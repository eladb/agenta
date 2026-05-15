// Per-session git-backed botspace bootstrap.
//
// On the first sandbox-touching tool of a turn (called from turn.ts right
// after ensureContainer succeeds), this:
//   1. Generates a fresh ed25519 keypair on the host if the thread doesn't
//      already have one.
//   2. Adds an authorized_keys line tagged with the thread key, with
//      `command="<agenta-git-shell> --session … --repo … --allowed-ref …"`
//      so the key is restricted to git push/pull against ONE repo and ONE
//      ref namespace.
//   3. Records {pubkey_fp, ref} on session.json so /delete and the boot
//      reap know which authorized_keys line belongs to this thread.
//   4. Writes the private key + ssh config + known_hosts into the sandbox
//      volume via the existing sandbox HTTP API.
//   5. Shallow-clones the host repo into /home/sandbox (the workspace =
//      sandbox home), checks out a per-session branch.
//
// Idempotent: most steps short-circuit if their pre-state already holds.
// Designed so a partial failure can be retried by re-running the function.

import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { basename, join } from 'node:path';
import { log } from '../log';
import { readSession, setGit } from '../runtime/session-store';
import { runBash, writeFile as sbWriteFile } from '../sandbox';
import { loadSandbox } from '../sandbox/persistence';
import { addEntry, listEntries } from './authorized-keys';
import { generateKeypair } from './keys';
import { ensureKnownHostsCache } from './known-hosts';
import { ensureTunnel, getTunnelPublicKeyPath } from './tunnel';

// agenta-git-shell lives at <repo_root>/bin/agenta-git-shell. This module
// lives at <repo_root>/src/git/bootstrap.ts so two `..` resolves the root.
const AGENTA_ROOT = join(import.meta.dir, '..', '..');
const GIT_SHELL_PATH = join(AGENTA_ROOT, 'bin', 'agenta-git-shell');

function refFor(threadKey: string): string {
  return `refs/heads/agenta/sessions/${threadKey}`;
}

function commandFor(threadKey: string, repoPath: string): string {
  // The authorized_keys `command=` field. agenta-git-shell parses these
  // flags out of $0/$@ once sshd invokes it.
  return `${GIT_SHELL_PATH} --session ${threadKey} --repo ${repoPath} --allowed-ref ${refFor(threadKey)}`;
}

// Run a command inside the sandbox, throw on non-zero. The bootstrap is a
// linear sequence of small ops; the model never sees these directly, so we
// don't want to bury a failure in a tool_result.
async function sb(threadKey: string, cmd: string): Promise<string> {
  const res = await runBash(threadKey, cmd);
  if (res.exitCode !== 0) {
    throw new Error(`sandbox bash failed (${res.exitCode}): ${res.stderr || res.stdout}`);
  }
  return res.stdout;
}

export async function ensureRepoBootstrap(threadKey: string): Promise<void> {
  const repoPath = process.env.AGENTA_REPO_PATH;
  if (!repoPath || repoPath.length === 0) {
    throw new Error('AGENTA_REPO_PATH must be set to a non-bare git repo');
  }

  // Provider-aware transport. Docker reaches the host's sshd directly via
  // Docker Desktop's loopback alias; Fly reaches it over a per-thread
  // reverse-SSH tunnel terminated at localhost:2222 inside the sandbox.
  // Both can be overridden via env for testing — the defaults match the
  // production setups.
  const provider = (process.env.SANDBOX_PROVIDER ?? 'docker').toLowerCase();
  const tunneled = provider === 'fly';
  const hostSshHostname =
    process.env.AGENTA_HOST_SSH_HOSTNAME ?? (tunneled ? 'localhost' : 'host.docker.internal');
  const hostSshPort = process.env.AGENTA_HOST_SSH_PORT ?? (tunneled ? '2222' : '22');

  // On Fly we have to install the bot's pubkey into the sandbox's dropbear
  // authorized_keys BEFORE we can start the tunnel — otherwise autossh
  // can't log in. Do this first.
  if (tunneled) {
    await ensureTunnelAuthorizedAndUp(threadKey);
  }

  const session = await readSession(threadKey);
  const existing = session?.git;

  // Fast path: pubkey is registered AND the line is present in
  // authorized_keys AND the sandbox already has ~/.git.
  if (existing?.pubkey_fp) {
    const entries = await listEntries();
    if (entries.includes(threadKey)) {
      const probe = await runBash(threadKey, 'test -d ~/.git');
      if (probe.exitCode === 0) return;
      // Sandbox is fresh (new container/volume) but the host-side key is
      // still good. Fall through to the SSH-config + clone path below,
      // reusing the existing fingerprint+ref.
      log.info('git', `[${threadKey}] sandbox missing ~/.git; re-seeding clone with existing key`);
    }
  }

  // Generate-and-register branch. Only fires when we don't already have a
  // matching pubkey_fp + authorized_keys line.
  let pubkeyFp = existing?.pubkey_fp;
  let privateKeyPem: string | undefined;
  let publicKeyOpenssh: string | undefined;
  const needsKey =
    !pubkeyFp ||
    !(await listEntries()).includes(threadKey) ||
    !(await sandboxHasKeyFile(threadKey));
  if (needsKey) {
    const kp = await generateKeypair();
    pubkeyFp = kp.fingerprint;
    privateKeyPem = kp.private;
    publicKeyOpenssh = kp.public;
    await addEntry({
      threadKey,
      publicKey: kp.public,
      command: commandFor(threadKey, repoPath),
    });
    await setGit(threadKey, { pubkey_fp: kp.fingerprint, ref: refFor(threadKey) });
    log.info('git', `[${threadKey}] generated keypair ${kp.fingerprint}`);
  }

  // Always (re-)seed the SSH config and known_hosts into the sandbox. If
  // the key was rotated above, drop in the matching private key; otherwise
  // we leave the existing one alone (the model is allowed to touch
  // ~/.ssh/id_ed25519 only via the bootstrap — there's no good reason for
  // it to rewrite the key, but if it did we'd rather not stomp on it
  // silently here).
  const knownHostsPath = await ensureKnownHostsCache();
  const knownHostsBody = await readFile(knownHostsPath, 'utf8');
  const sshUser = userInfo().username;
  const repoName = basename(repoPath);

  await sb(threadKey, 'mkdir -p ~/.ssh && chmod 700 ~/.ssh');
  if (privateKeyPem) {
    await writeKeyFiles(threadKey, privateKeyPem, publicKeyOpenssh ?? '');
  }
  // ssh config: pin the alias `agenta-repo` to the host's sshd. On docker
  // that's host.docker.internal:22 (Docker Desktop's loopback alias for the
  // host). On fly we go through the per-thread reverse-SSH tunnel at
  // localhost:2222 (Phase 23). Hostname + port are configurable via
  // AGENTA_HOST_SSH_HOSTNAME / AGENTA_HOST_SSH_PORT so a host with a
  // different sshd port can still bootstrap. The user under which the
  // agenta bot is running owns the authorized_keys line we wrote.
  const sshConfig = [
    'Host agenta-repo',
    `  HostName ${hostSshHostname}`,
    `  Port ${hostSshPort}`,
    `  User ${sshUser}`,
    '  IdentityFile ~/.ssh/id_ed25519',
    '  IdentitiesOnly yes',
    '  StrictHostKeyChecking yes',
    '  UserKnownHostsFile ~/.ssh/known_hosts',
    '',
  ].join('\n');
  await sbWrite(threadKey, '.ssh/config', sshConfig);
  await sbWrite(threadKey, '.ssh/known_hosts', knownHostsBody);
  await sb(threadKey, 'chmod 600 ~/.ssh/id_ed25519 ~/.ssh/config ~/.ssh/known_hosts');

  // Clone (idempotent). The remote URL embeds the literal repo path because
  // agenta-git-shell validates it against --repo.
  const cloneCmd = `[ -d ~/.git ] || (cd ~ && git clone --depth 1 ssh://agenta-repo${repoPath} ${shellQuote(repoName)}-tmp && mv ${shellQuote(repoName)}-tmp/.git .git && cp -an ${shellQuote(repoName)}-tmp/. . && rm -rf ${shellQuote(repoName)}-tmp)`;
  // Why the dance: `git clone … .` refuses an existing non-empty dir
  // (the volume has botspace seed or prior state). We clone into a temp
  // subdir, then move .git into ~ and copy any working-tree files over
  // without clobbering existing ones (`cp -an`).
  await sb(threadKey, cloneCmd);

  // Identity + branch — both no-ops on the second call.
  await sb(threadKey, 'git -C ~ config user.email "agenta@localhost"');
  await sb(threadKey, 'git -C ~ config user.name "agenta"');
  const onRef = await runBash(threadKey, 'git -C ~ symbolic-ref --quiet HEAD');
  const desired = refFor(threadKey);
  const currentRef = onRef.stdout.trim();
  if (currentRef !== desired) {
    await sb(threadKey, `git -C ~ checkout -B agenta/sessions/${threadKey}`);
  }
}

async function sandboxHasKeyFile(threadKey: string): Promise<boolean> {
  const res = await runBash(threadKey, 'test -f ~/.ssh/id_ed25519');
  return res.exitCode === 0;
}

async function writeKeyFiles(
  threadKey: string,
  privatePem: string,
  publicOpenssh: string,
): Promise<void> {
  // /write doesn't expose a mode argument; we chmod once everything is on
  // disk (see the chmod 600 call in the caller).
  const r1 = await sbWriteFile(threadKey, '.ssh/id_ed25519', privatePem);
  if (r1.exitCode !== 0) {
    throw new Error(`sandbox writeFile id_ed25519 failed: ${r1.stderr || r1.stdout}`);
  }
  if (publicOpenssh.length > 0) {
    const r2 = await sbWriteFile(
      threadKey,
      '.ssh/id_ed25519.pub',
      publicOpenssh.endsWith('\n') ? publicOpenssh : `${publicOpenssh}\n`,
    );
    if (r2.exitCode !== 0) {
      log.warn('git', `[${threadKey}] write id_ed25519.pub: ${r2.stderr || r2.stdout}`);
    }
  }
}

async function sbWrite(threadKey: string, path: string, content: string): Promise<void> {
  const r = await sbWriteFile(threadKey, path, content);
  if (r.exitCode !== 0) {
    throw new Error(`sandbox writeFile ${path} failed: ${r.stderr || r.stdout}`);
  }
}

// Single-quote a path/word for safe inclusion in a bash command. Used for
// the `mv`/`cp` calls in the clone dance; the input is the repo basename
// which we don't trust to be shell-safe.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Fly-only: install the Mac-side tunnel pubkey into the sandbox's
// /root/.ssh/authorized_keys (where dropbear reads it), then spawn the
// per-thread autossh that creates the localhost:2222 reverse-forward. The
// helper is idempotent — repeated /write calls are cheap and ensureTunnel
// already handles "already running" itself.
async function ensureTunnelAuthorizedAndUp(threadKey: string): Promise<void> {
  // 1. Load sandbox record to find the machine's private_ip.
  const sb = await loadSandbox(threadKey);
  if (!sb || sb.provider !== 'fly') {
    throw new Error(
      `tunnel: no Fly sandbox record for ${threadKey}; ensureContainer must run before bootstrap`,
    );
  }
  const flyIp = sb.private_ip;
  if (!flyIp || flyIp.length === 0) {
    throw new Error(
      `tunnel: Fly sandbox record for ${threadKey} has no private_ip; cannot reach over WireGuard`,
    );
  }

  // 2. Read the Mac tunnel pubkey and install it into the sandbox's
  //    /root/.ssh/authorized_keys. Append-if-missing rather than overwrite
  //    so the same authorized_keys file can carry future operator keys if
  //    we ever need them. The sandbox's entrypoint.sh pre-chowns this file
  //    to sandbox:sandbox + 644 so the uid-1000 sandbox-server can append
  //    to it; dropbear still reads it as root.
  const pubKey = (await readFile(getTunnelPublicKeyPath(), 'utf8')).trim();
  const haveKey = await runBash(
    threadKey,
    `grep -qF ${shellQuote(pubKey)} /root/.ssh/authorized_keys 2>/dev/null`,
  );
  if (haveKey.exitCode !== 0) {
    const append = await runBash(
      threadKey,
      `echo ${shellQuote(pubKey)} >> /root/.ssh/authorized_keys`,
    );
    if (append.exitCode !== 0) {
      throw new Error(
        `tunnel: failed to install Mac tunnel pubkey into sandbox: ${append.stderr || append.stdout}`,
      );
    }
    log.info('git', `[${threadKey}] installed Mac tunnel pubkey into sandbox`);
  }

  // 3. Spawn (or adopt) the per-thread autossh.
  await ensureTunnel(threadKey, flyIp);
}
