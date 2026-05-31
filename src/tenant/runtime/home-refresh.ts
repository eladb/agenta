// Refresh the host-side agent-home mirror on first mention so a thread's
// frozen system prompt + skill listing reflects upstream changes since the
// bot last booted. Called from `handler.ts:resolveSystemPrompt` immediately
// before `buildSystemPrompt()`; the per-thread frozen-prompt invariant
// stays — refreshes happen only on the first-mention path, never mid-turn.
//
// Behavior by transport (see `resolveTransport` in `home-config.ts`):
//   - `tunneled-file` (file://): no-op. The local path IS the working tree.
//   - `tunneled-mirror` (https://): fetch + reset --hard origin/main using a
//     token-spliced clone URL (matching `entrypoint.sh`'s shape).
//   - `direct` (ssh:// / git@): fetch + reset --hard origin/HEAD using a
//     short-lived 0600 PEM tempfile + the pinned known_hosts bundle.
//
// All failures are non-fatal — we log a warning and let the prompt build
// fall through to whatever is on disk. Never block the thread on a refresh.
//
// See `gh issue view 120` for the design.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log } from '../../shared/log';
import { KNOWN_HOSTS_PATH } from '../git/bootstrap';
import { type HomeConfig, resolveTransport } from './home-config';

// Inject a token into an https:// URL's userinfo, matching the shape used
// by `entrypoint.sh` (`x-access-token:<token>@host/path`). GitHub PATs use
// this form when used as the password against the v3 HTTPS endpoint.
function spliceToken(remote: string, token: string): string {
  const u = new URL(remote);
  u.username = 'x-access-token';
  u.password = token;
  return u.toString();
}

// Async wrapper around `Bun.spawn` that captures stdout+stderr and exit code.
// Centralised so the test can stub a single seam.
export type RunResult = { code: number; stdout: string; stderr: string };
export type Runner = (cmd: string[], env?: Record<string, string>) => Promise<RunResult>;

const defaultRunner: Runner = async (cmd, env) => {
  const proc = Bun.spawn(cmd, {
    env: env ? { ...process.env, ...env } : process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
};

// Refresh the host-side mirror for `home` so a fresh prompt build reads
// the latest README.md + skills/. Resolves on success or after a swallowed
// warning; never throws.
//
// `runner` is injectable for tests so unit tests don't actually shell out.
export async function refreshHomeMirror(
  home: HomeConfig,
  runner: Runner = defaultRunner,
): Promise<void> {
  let resolved: ReturnType<typeof resolveTransport>;
  try {
    resolved = resolveTransport(home);
  } catch (err) {
    log.warn(
      'home-refresh',
      `resolveTransport failed for ${home.remote}: ${(err as Error).message}`,
    );
    return;
  }

  // file:// — local path is the working tree, nothing to fetch.
  if (resolved.transport === 'tunneled-file') return;

  // Both other transports need an existing mirror to refresh. If the
  // directory doesn't exist yet (e.g. local dev that hasn't seeded the
  // mirror, or a fresh deploy where entrypoint.sh hasn't run), skip with
  // a warning — the prompt build will fall through to whatever's on disk
  // (likely nothing, but that's the existing behavior).
  if (!existsSync(join(resolved.mirrorPath, '.git'))) {
    log.warn('home-refresh', `mirror at ${resolved.mirrorPath} has no .git; skipping refresh`);
    return;
  }

  if (resolved.transport === 'tunneled-mirror') {
    await refreshHttpsMirror(home, resolved.mirrorPath, runner);
    return;
  }
  if (resolved.transport === 'direct') {
    await refreshDirectMirror(home, resolved.mirrorPath, runner);
    return;
  }
}

async function refreshHttpsMirror(home: HomeConfig, mirror: string, runner: Runner): Promise<void> {
  if (!home.auth_env) {
    log.warn('home-refresh', `[${mirror}] auth_env missing for https mirror; skipping`);
    return;
  }
  const token = process.env[home.auth_env];
  if (!token || token.length === 0) {
    log.warn('home-refresh', `[${mirror}] auth_env ${home.auth_env} not set; skipping refresh`);
    return;
  }
  let cloneUrl: string;
  try {
    cloneUrl = spliceToken(home.remote, token);
  } catch (err) {
    log.warn(
      'home-refresh',
      `[${mirror}] failed to splice token into ${home.remote}: ${(err as Error).message}`,
    );
    return;
  }
  // `fetch <url>` (anonymous remote name) avoids re-writing `origin`'s URL
  // on disk — entrypoint.sh already set origin to a token-spliced URL; we
  // only need this one fetch to succeed.
  const fetched = await runner(['git', '-C', mirror, 'fetch', cloneUrl, 'main', '--quiet']);
  if (fetched.code !== 0) {
    log.warn(
      'home-refresh',
      `[${mirror}] git fetch failed (code ${fetched.code}): ${fetched.stderr.trim()}`,
    );
    return;
  }
  const reset = await runner(['git', '-C', mirror, 'reset', '--hard', 'FETCH_HEAD', '--quiet']);
  if (reset.code !== 0) {
    log.warn(
      'home-refresh',
      `[${mirror}] git reset --hard failed (code ${reset.code}): ${reset.stderr.trim()}`,
    );
  }
}

async function refreshDirectMirror(
  home: HomeConfig,
  mirror: string,
  runner: Runner,
): Promise<void> {
  if (!home.auth_env) {
    log.warn('home-refresh', `[${mirror}] auth_env missing for direct mirror; skipping`);
    return;
  }
  const pem = process.env[home.auth_env];
  if (!pem || pem.length === 0) {
    log.warn('home-refresh', `[${mirror}] auth_env ${home.auth_env} not set; skipping refresh`);
    return;
  }
  // Stage the PEM into a private 0600 tempfile under an 0700 tempdir.
  // mkdtempSync gives us 0700 on the parent already; the key file is
  // chmod'd to 0600 via writeFileSync's mode. Cleanup runs in finally
  // regardless of success/failure to avoid leaking key material on disk.
  const dir = mkdtempSync(join(tmpdir(), 'agenta-home-refresh-'));
  const keyFile = join(dir, 'id');
  try {
    // Trailing newline mirrors entrypoint.sh; ssh tolerates either, but
    // some OpenSSH versions warn without it.
    writeFileSync(keyFile, pem.endsWith('\n') ? pem : `${pem}\n`, { mode: 0o600 });
    const gitSshCmd = `ssh -i ${keyFile} -o IdentitiesOnly=yes -o UserKnownHostsFile=${KNOWN_HOSTS_PATH} -o StrictHostKeyChecking=yes`;
    const env = { GIT_SSH_COMMAND: gitSshCmd };
    const fetched = await runner(['git', '-C', mirror, 'fetch', '--quiet'], env);
    if (fetched.code !== 0) {
      log.warn(
        'home-refresh',
        `[${mirror}] git fetch failed (code ${fetched.code}): ${fetched.stderr.trim()}`,
      );
      return;
    }
    const reset = await runner(['git', '-C', mirror, 'reset', '--hard', 'origin/HEAD', '--quiet']);
    if (reset.code !== 0) {
      log.warn(
        'home-refresh',
        `[${mirror}] git reset --hard failed (code ${reset.code}): ${reset.stderr.trim()}`,
      );
    }
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      log.warn('home-refresh', `failed to clean up tmp key dir ${dir}: ${(err as Error).message}`);
    }
  }
}
