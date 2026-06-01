// Refresh the host-side agent-home mirror on first mention so a thread's
// frozen system prompt + skill listing reflects upstream changes since the
// bot last booted. Called from `handler.ts:resolveSystemPrompt` immediately
// before `buildSystemPrompt()`; the per-thread frozen-prompt invariant
// stays — refreshes happen only on the first-mention path, never mid-turn.
//
// Behavior by transport (see `resolveTransport` in `home-config.ts`):
//   - `tunneled-file` (file://): no-op. The local path IS the working tree.
//   - `tunneled-mirror` (https://): clone (first use) or fetch + reset --hard
//     using a token-spliced clone URL (matching `entrypoint.sh`'s shape).
//   - `direct` (ssh:// / git@): clone (first use) or fetch + reset --hard
//     using a short-lived 0600 PEM tempfile + the pinned known_hosts bundle.
//
// The INITIAL clone matters because nothing else seeds the mirror on a fresh
// volume: under #253 entrypoint.sh stopped prefetching the home, leaving the
// "lazy clone on first use" it promised to here (#262). The mirror is both
// the prompt source AND, for tunneled transports, the repo the per-session
// git server serves to the sandbox — so a missing mirror means no README/
// skills and a failing in-sandbox clone, not just a stale prompt.
//
// All failures are non-fatal — we log a warning and let the prompt build
// fall through to whatever is on disk. Never block the thread on a refresh.
//
// See `gh issue view 120` (refresh) and `262` (initial clone) for the design.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

// Refresh (or, on first use, clone) the host-side mirror for `home` so a
// fresh prompt build reads the latest README.md + skills/. Resolves on
// success or after a swallowed warning; never throws.
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

  // First use vs. subsequent: a fresh volume has no mirror yet (entrypoint.sh
  // stopped prefetching under #253), so clone it here; later mentions
  // fetch+reset. A fresh clone lands on the default branch (already current),
  // so the clone paths return without an extra refresh. (#262)
  const hasMirror = existsSync(join(resolved.mirrorPath, '.git'));

  if (resolved.transport === 'tunneled-mirror') {
    if (hasMirror) await refreshHttpsMirror(home, resolved.mirrorPath, runner);
    else await cloneHttpsMirror(home, resolved.mirrorPath, runner);
    return;
  }
  if (resolved.transport === 'direct') {
    if (hasMirror) await refreshDirectMirror(home, resolved.mirrorPath, runner);
    else await cloneDirectMirror(home, resolved.mirrorPath, runner);
    return;
  }
}

// Resolve the token-spliced https URL for clone/fetch, or null (with a
// warning) when auth_env is missing/unset or the remote can't be parsed.
function httpsAuthedUrl(home: HomeConfig, mirror: string): string | null {
  if (!home.auth_env) {
    log.warn('home-refresh', `[${mirror}] auth_env missing for https mirror; skipping`);
    return null;
  }
  const token = process.env[home.auth_env];
  if (!token || token.length === 0) {
    log.warn('home-refresh', `[${mirror}] auth_env ${home.auth_env} not set; skipping`);
    return null;
  }
  try {
    return spliceToken(home.remote, token);
  } catch (err) {
    log.warn(
      'home-refresh',
      `[${mirror}] failed to splice token into ${home.remote}: ${(err as Error).message}`,
    );
    return null;
  }
}

// First-use clone of an https mirror. `git clone` sets origin to the
// token-spliced URL on disk — same as entrypoint.sh used to — which the
// refresh path's anonymous `fetch <url>` then sidesteps anyway.
async function cloneHttpsMirror(home: HomeConfig, mirror: string, runner: Runner): Promise<void> {
  const cloneUrl = httpsAuthedUrl(home, mirror);
  if (!cloneUrl) return;
  mkdirSync(dirname(mirror), { recursive: true });
  const cloned = await runner(['git', 'clone', cloneUrl, mirror, '--quiet']);
  if (cloned.code !== 0) {
    log.warn(
      'home-refresh',
      `[${mirror}] git clone failed (code ${cloned.code}): ${cloned.stderr.trim()}`,
    );
  }
}

async function refreshHttpsMirror(home: HomeConfig, mirror: string, runner: Runner): Promise<void> {
  const cloneUrl = httpsAuthedUrl(home, mirror);
  if (!cloneUrl) return;
  // `fetch <url>` (anonymous remote name) avoids re-writing `origin`'s URL
  // on disk — the initial clone / entrypoint.sh already set origin to a
  // token-spliced URL; we only need this one fetch to succeed.
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

// Stage the PEM into a private 0600 tempfile under an 0700 tempdir and build
// the GIT_SSH_COMMAND env (pinned known_hosts, strict host-key checking).
// Returns null (with a warning) when auth_env is missing/unset. The CALLER
// MUST `rmSync(dir, { recursive: true, force: true })` in a finally so key
// material never leaks on disk.
function stageSshEnv(
  home: HomeConfig,
  mirror: string,
): { env: Record<string, string>; dir: string } | null {
  if (!home.auth_env) {
    log.warn('home-refresh', `[${mirror}] auth_env missing for direct mirror; skipping`);
    return null;
  }
  const pem = process.env[home.auth_env];
  if (!pem || pem.length === 0) {
    log.warn('home-refresh', `[${mirror}] auth_env ${home.auth_env} not set; skipping`);
    return null;
  }
  const dir = mkdtempSync(join(tmpdir(), 'agenta-home-refresh-'));
  const keyFile = join(dir, 'id');
  // Trailing newline mirrors entrypoint.sh; ssh tolerates either, but some
  // OpenSSH versions warn without it.
  writeFileSync(keyFile, pem.endsWith('\n') ? pem : `${pem}\n`, { mode: 0o600 });
  const env = {
    GIT_SSH_COMMAND: `ssh -i ${keyFile} -o IdentitiesOnly=yes -o UserKnownHostsFile=${KNOWN_HOSTS_PATH} -o StrictHostKeyChecking=yes`,
  };
  return { env, dir };
}

// First-use clone of a direct (ssh/git@) mirror over the staged key.
async function cloneDirectMirror(home: HomeConfig, mirror: string, runner: Runner): Promise<void> {
  const staged = stageSshEnv(home, mirror);
  if (!staged) return;
  try {
    mkdirSync(dirname(mirror), { recursive: true });
    const cloned = await runner(['git', 'clone', home.remote, mirror, '--quiet'], staged.env);
    if (cloned.code !== 0) {
      log.warn(
        'home-refresh',
        `[${mirror}] git clone failed (code ${cloned.code}): ${cloned.stderr.trim()}`,
      );
    }
  } finally {
    try {
      rmSync(staged.dir, { recursive: true, force: true });
    } catch (err) {
      log.warn('home-refresh', `failed to clean up tmp key dir ${staged.dir}: ${(err as Error).message}`);
    }
  }
}

async function refreshDirectMirror(
  home: HomeConfig,
  mirror: string,
  runner: Runner,
): Promise<void> {
  const staged = stageSshEnv(home, mirror);
  if (!staged) return;
  try {
    const fetched = await runner(['git', '-C', mirror, 'fetch', '--quiet'], staged.env);
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
      rmSync(staged.dir, { recursive: true, force: true });
    } catch (err) {
      log.warn('home-refresh', `failed to clean up tmp key dir ${staged.dir}: ${(err as Error).message}`);
    }
  }
}
