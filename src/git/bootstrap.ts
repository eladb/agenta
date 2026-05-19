// Per-session git-backed agent home bootstrap (WS-tunnel transport, phase 24).
//
// Replaces the phase-22 per-session SSH keypairs + authorized_keys + Mac
// sshd transport and the phase-23 Fly reverse-SSH tunnel.
//
// The bot owns one git HTTP server per session, listening on loopback at
// 127.0.0.1:<random-port>. A WebSocket tunnel from the bot to the
// sandbox's /tunnel endpoint multiplexes loopback TCP between git (inside
// the sandbox, talking to http://localhost:6000/<repo>.git) and the
// per-session git server on the bot. Reachability is provided by the
// existing sandbox HTTP API direction — the bot already reaches the
// sandbox over Bearer-auth'd HTTP, so the tunnel uses the same path.
//
// Bootstrap is called from `turn.ts` right after `ensureContainer`
// succeeds, before `syncAttachmentsToSandbox`. Idempotent: re-running on
// the same thread is cheap when the sandbox already has `~/.git`.

import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { log } from '../log';
import { resolveTransport } from '../runtime/home-config';
import { readSession, setGit } from '../runtime/session-store';
import { runBash } from '../sandbox';
import { dockerProvider } from '../sandbox/docker';
import { flyProvider } from '../sandbox/fly';
import { type GitServerHandle, startGitServer } from './git-server';
import { startTunnel, stopTunnel, type TunnelHandle } from './ws-tunnel';

// pre-receive hook lives at <repo_root>/git-hooks/pre-receive. The same
// directory holds known_hosts (#88) — the pinned host-key bundle the
// sandbox installs into ~/.ssh on direct-mode bootstrap.
const AGENTA_ROOT = join(import.meta.dir, '..', '..');
const HOOKS_DIR = join(AGENTA_ROOT, 'git-hooks');
export const KNOWN_HOSTS_PATH = join(HOOKS_DIR, 'known_hosts');

// Read the pinned known_hosts bundle once at module load — bundling it
// at start time matches the spec ("read at process start, embedded into
// the bootstrap step"). Fail-fast: the file is committed, so a missing
// one is a packaging bug, not a runtime error to swallow.
function loadKnownHosts(): string {
  return readFileSync(KNOWN_HOSTS_PATH, 'utf8');
}
const KNOWN_HOSTS = loadKnownHosts();

// Loopback port the sandbox-side TCP listener binds inside the container.
// Must match `TUNNEL_TCP_PORT` in sandbox/server/server.ts.
const SANDBOX_TUNNEL_PORT = 6000;

// Per-thread handles. Tracked at module level so they survive across
// runTurn invocations and so /delete + shutdown can reach them.
type SessionHandles = {
  gitServer: GitServerHandle;
  tunnel: TunnelHandle;
};
const handles = new Map<string, SessionHandles>();

export function refFor(threadKey: string): string {
  return `refs/heads/agenta/sessions/${threadKey}`;
}

function selectProviderForEndpoint(): { getEndpoint: typeof dockerProvider.getEndpoint } {
  const name = (process.env.SANDBOX_PROVIDER ?? 'docker').toLowerCase();
  if (name === 'fly') return flyProvider;
  return dockerProvider;
}

// Run a command inside the sandbox, throw on non-zero. Bootstrap is a
// linear sequence of small ops — the model never sees them directly so a
// raw throw is the right surface.
async function sb(threadKey: string, cmd: string): Promise<string> {
  const res = await runBash(threadKey, cmd);
  if (res.exitCode !== 0) {
    throw new Error(`sandbox bash failed (${res.exitCode}): ${res.stderr || res.stdout}`);
  }
  return res.stdout;
}

export async function ensureRepoBootstrap(threadKey: string): Promise<void> {
  const allowedRef = refFor(threadKey);
  const session = await readSession(threadKey);
  if (!session?.home) {
    throw new Error(
      `[${threadKey}] session.home is unset — handler should freeze it on first mention (#87)`,
    );
  }
  const resolved = resolveTransport(session.home);
  if (resolved.transport === 'direct') {
    // Direct SSH transport (#88): sandbox clones + pushes straight to
    // the remote over SSH. No bot-side git server, no WS tunnel.
    await bootstrapDirect(threadKey, session.home.remote, session.home.auth_env);
    return;
  }
  const repoPath = resolved.localPath;

  // Fast path: tunnel + git server already up for this thread, and the
  // sandbox already has a clone. Probe ~/.git to confirm — the sandbox
  // may have been wiped (rare, but possible if the volume was reset).
  const existing = handles.get(threadKey);
  if (existing && session?.git?.ref === allowedRef) {
    const probe = await runBash(threadKey, 'test -d ~/.git');
    if (probe.exitCode === 0) return;
    log.info('git', `[${threadKey}] sandbox missing ~/.git; re-cloning over existing tunnel`);
    await cloneAndCheckout(threadKey, repoPath);
    return;
  }

  // Tear down any stale handle (e.g. from a prior turn where the tunnel
  // died mid-flight) before re-provisioning.
  if (existing) {
    await teardownSession(threadKey).catch((err) => {
      log.warn('git', `[${threadKey}] stale teardown failed: ${(err as Error).message}`);
    });
  }

  // 1. Start the per-session git HTTP server on loopback.
  const gitServer = await startGitServer({
    repoPath,
    allowedRef,
    hooksDir: HOOKS_DIR,
  });
  log.info('git', `[${threadKey}] git server on 127.0.0.1:${gitServer.port}`);

  // 2. Open the WS tunnel to the sandbox's /tunnel route. We pull the
  //    sandbox base URL + bearer token straight from the active provider's
  //    endpoint — same path as every other sandbox HTTP call.
  const provider = selectProviderForEndpoint();
  const ep = await provider.getEndpoint(threadKey);

  let tunnel: TunnelHandle;
  try {
    tunnel = await startTunnel({
      threadKey,
      sandboxBaseUrl: ep.baseUrl,
      sandboxHeaders: ep.headers,
      localTargetPort: gitServer.port,
    });
  } catch (err) {
    await gitServer.stop();
    throw err;
  }
  handles.set(threadKey, { gitServer, tunnel });

  // 3. Probe the in-sandbox loopback port. /dev/tcp is a bash builtin so
  //    we don't depend on `nc`. Cap at ~5s — the WS handshake itself
  //    blocks startTunnel, so the listener should be up by now; this is
  //    just belt-and-suspenders against startup races.
  await waitForSandboxPort(threadKey);

  // 4. Persist the session's allowed ref. Preserve the creator written
  //    by handler.ts on first mention. We tolerate (but don't write) the
  //    old phase-22 pubkey_fp field.
  await setGit(threadKey, { ref: allowedRef, creator: session?.git?.creator });

  // 5. Clone into the sandbox and check out the session branch.
  await cloneAndCheckout(threadKey, repoPath);
}

async function waitForSandboxPort(threadKey: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  const probe = `bash -c "exec 3<>/dev/tcp/localhost/${SANDBOX_TUNNEL_PORT}" 2>/dev/null`;
  while (Date.now() < deadline) {
    const res = await runBash(threadKey, probe);
    if (res.exitCode === 0) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `WS tunnel for ${threadKey} not reachable inside sandbox on localhost:${SANDBOX_TUNNEL_PORT} within 5s`,
  );
}

// Direct SSH transport (#88): no bot-side git server / WS tunnel; the
// sandbox clones from the remote and pushes straight back over SSH.
//
// Side effects inside the sandbox:
//   - writes ~/.ssh/id_ed25519 (mode 0600) from process.env[authEnv]
//   - writes ~/.ssh/known_hosts from the bundled KNOWN_HOSTS
//   - clones <sshUrl> into /tmp/agenta-clone, transplants .git + cp -an
//     into ~/, removes the temp dir
//   - checks out agenta/sessions/<thread_key>
//   - sets user.name / user.email from session.git.creator (with the
//     same fallback as the tunneled path).
//
// The PEM is resolved from env at every call — NEVER persisted into
// session.json. The auth_env name is the only thing the session carries.
async function bootstrapDirect(
  threadKey: string,
  sshUrl: string,
  authEnv: string | undefined,
): Promise<void> {
  if (!authEnv || authEnv.length === 0) {
    throw new Error(
      `[${threadKey}] direct SSH transport requires auth_env to be set in session.home`,
    );
  }
  const allowedRef = refFor(threadKey);
  const session = await readSession(threadKey);

  // Persist the session ref + creator (same shape as the tunneled path).
  // We don't track a bot-side handle for direct mode — there's nothing
  // running on the bot to tear down.
  await setGit(threadKey, { ref: allowedRef, creator: session?.git?.creator });

  // Fast path: if ~/.git is already in place and pointed at our ref, the
  // setup commands below are all no-ops, but skipping the round-trips is
  // worth it. We still want user.* to be set in case the sandbox volume
  // was wiped between turns.
  const probe = await runBash(threadKey, 'test -d ~/.git');
  if (probe.exitCode === 0) {
    log.info('git', `[${threadKey}] direct: ~/.git present; ensuring branch + identity`);
    await ensureBranchAndIdentity(threadKey, session?.git?.creator);
    return;
  }

  // PEM lookup at USE time — not at module load, not at session-write
  // time. The auth_env name is the contract; the PEM bytes live entirely
  // in process env.
  const pem = process.env[authEnv];
  if (!pem || pem.length === 0) {
    throw new Error(
      `[${threadKey}] direct SSH transport: env var ${authEnv} is unset or empty (deploy key missing)`,
    );
  }

  // Write the keypair + known_hosts via the sandbox /write endpoint so we
  // don't have to inline the PEM into a bash command (cleaner + avoids
  // pem-newline escape issues).
  await ensureSshDir(threadKey);
  await writeSandboxFile(threadKey, '/home/sandbox/.ssh/id_ed25519', pem, 0o600);
  await writeSandboxFile(threadKey, '/home/sandbox/.ssh/known_hosts', KNOWN_HOSTS, 0o644);

  // Same clone dance as the tunneled path, just with the SSH URL. We use
  // `git clone -c …` to point at the per-session known_hosts + key right
  // from the initial clone; `origin` then stays as the SSH URL.
  const sshOpts = `-o IdentitiesOnly=yes -o UserKnownHostsFile=/home/sandbox/.ssh/known_hosts -o StrictHostKeyChecking=yes`;
  const gitSshCmd = `ssh -i /home/sandbox/.ssh/id_ed25519 ${sshOpts}`;
  const cloneCmd = [
    `[ -d ~/.git ] || (`,
    `cd /tmp &&`,
    `rm -rf agenta-clone &&`,
    `GIT_SSH_COMMAND=${shellQuote(gitSshCmd)}`,
    `git clone --depth 1 ${shellQuote(sshUrl)} agenta-clone &&`,
    `mv agenta-clone/.git ~/ &&`,
    `cp -an agenta-clone/. ~/ &&`,
    `rm -rf agenta-clone`,
    `)`,
  ].join(' ');
  await sb(threadKey, cloneCmd);

  // Stamp the SSH command on the cloned repo so subsequent fetch/push
  // calls from inside the sandbox use the same key + host pin without
  // needing GIT_SSH_COMMAND in the model's bash env.
  await sb(threadKey, `git -C ~ config core.sshCommand ${shellQuote(gitSshCmd)}`);
  // Origin URL is already set by `git clone`; reassert it so a re-bootstrap
  // onto a remote URL change is honored.
  await sb(threadKey, `git -C ~ remote set-url origin ${shellQuote(sshUrl)}`);

  await ensureBranchAndIdentity(threadKey, session?.git?.creator);
}

// Create ~/.ssh with mode 0700 if it isn't already there. `useradd
// --create-home` doesn't create .ssh, and ssh-keygen / git refuse to use
// a 0755 .ssh dir.
async function ensureSshDir(threadKey: string): Promise<void> {
  await sb(threadKey, 'mkdir -p ~/.ssh && chmod 700 ~/.ssh');
}

// Drop a file into the sandbox via the bytes-aware /write endpoint. We
// don't import writeFile from ../sandbox to keep this file's surface
// narrow; the inline bash heredoc works for utf-8 payloads (PEMs +
// known_hosts are both 7-bit ASCII).
async function writeSandboxFile(
  threadKey: string,
  path: string,
  content: string,
  mode: number,
): Promise<void> {
  // Use printf %s + a heredoc — handles arbitrary content (including
  // trailing newlines) without trying to inline-escape the PEM bytes.
  const modeOct = mode.toString(8);
  const cmd = `cat > ${shellQuote(path)} <<'__AGENTA_EOF__' && chmod ${modeOct} ${shellQuote(path)}
${content}
__AGENTA_EOF__`;
  await sb(threadKey, cmd);
}

// Idempotent branch + identity step shared by direct + the tunneled path.
async function ensureBranchAndIdentity(
  threadKey: string,
  creator: { email: string; name: string } | undefined,
): Promise<void> {
  const allowedRef = refFor(threadKey);
  const branchName = `agenta/sessions/${threadKey}`;
  const authorName = creator?.name ?? 'agenta';
  const authorEmail = creator?.email ?? 'agenta@localhost';
  await sb(threadKey, `git -C ~ config user.email ${shellQuote(authorEmail)}`);
  await sb(threadKey, `git -C ~ config user.name ${shellQuote(authorName)}`);
  const head = await runBash(threadKey, 'git -C ~ symbolic-ref --quiet HEAD');
  if (head.stdout.trim() !== allowedRef) {
    await sb(threadKey, `git -C ~ checkout -B ${shellQuote(branchName)}`);
  }
}

async function cloneAndCheckout(threadKey: string, repoPath: string): Promise<void> {
  const repoName = basename(repoPath);
  const remoteUrl = `http://localhost:${SANDBOX_TUNNEL_PORT}/${repoName}.git`;
  const allowedRef = refFor(threadKey);
  const branchName = `agenta/sessions/${threadKey}`;
  // Author identity: prefer the Slack thread creator resolved by
  // handler.ts on first mention. Falls back to a static name/email when
  // the lookup failed (denied scopes, deleted account, pre-phase-25
  // threads, etc.) so we always have something committable.
  const session = await readSession(threadKey);
  const creator = session?.git?.creator;
  const authorName = creator?.name ?? 'agenta';
  const authorEmail = creator?.email ?? 'agenta@localhost';

  // Idempotent clone: `git clone … .` refuses an existing non-empty dir,
  // so clone into /tmp then move .git + copy-if-missing over the existing
  // workspace tree. Skip entirely if ~/.git already exists.
  const cloneCmd = [
    `[ -d ~/.git ] || (`,
    `cd /tmp &&`,
    `rm -rf agenta-clone &&`,
    `git clone --depth 1 ${shellQuote(remoteUrl)} agenta-clone &&`,
    `mv agenta-clone/.git ~/ &&`,
    `cp -an agenta-clone/. ~/ &&`,
    `rm -rf agenta-clone`,
    `)`,
  ].join(' ');
  await sb(threadKey, cloneCmd);

  // Set the origin remote URL explicitly so it's stable for subsequent
  // push/pull. `git clone` already set it but a re-bootstrap onto a
  // different gitServer port (we don't pin the port across restarts)
  // would otherwise still point at the old port.
  await sb(threadKey, `git -C ~ remote set-url origin ${shellQuote(remoteUrl)}`);

  await sb(threadKey, `git -C ~ config user.email ${shellQuote(authorEmail)}`);
  await sb(threadKey, `git -C ~ config user.name ${shellQuote(authorName)}`);

  const head = await runBash(threadKey, 'git -C ~ symbolic-ref --quiet HEAD');
  if (head.stdout.trim() !== allowedRef) {
    await sb(threadKey, `git -C ~ checkout -B ${shellQuote(branchName)}`);
  }
}

// Single-quote a path/word for safe inclusion in a bash command.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Tear down the per-session git server + tunnel. Called from /delete and
// from process-shutdown handlers. Safe to call when there's no handle.
export async function teardownSession(threadKey: string): Promise<void> {
  const h = handles.get(threadKey);
  if (!h) {
    // Best-effort: even with no in-process handle, the ws-tunnel module
    // may still hold one (e.g. across a session that crashed mid-turn).
    await stopTunnel(threadKey).catch(() => {});
    return;
  }
  handles.delete(threadKey);
  await h.tunnel.stop().catch(() => {});
  await h.gitServer.stop().catch(() => {});
}

export async function teardownAllSessions(): Promise<void> {
  const keys = [...handles.keys()];
  await Promise.all(keys.map((k) => teardownSession(k)));
}

// For tests.
export function _resetForTests(): void {
  handles.clear();
}
