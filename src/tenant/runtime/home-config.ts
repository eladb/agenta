// Per-thread home resolution (#87, refactored under #253).
//
// Under the bot↔tenant split, home config lives on the bot side
// (`config/tenants.json`, per-deployment). Each `/events` POST carries a
// resolved `home` spec in its envelope; the
// tenant's job is to take that spec, look up its secret (by env-var NAME),
// and derive the transport descriptor used by `git/bootstrap` +
// `home-refresh`.
//
// Two transports — `tunneled-file`, `tunneled-mirror`, `direct` — are
// derived from `URL.protocol`:
//   - `file:`  → tunneled, no mirror (the file:// path IS the working tree).
//   - `https:` → tunneled, with a mirror clone at `<root>/<slug>` that
//     `entrypoint.sh` refreshes on boot.
//   - `git@` / `ssh:` → direct (#88). Sandbox clones + pushes straight to
//     the SSH remote; the tenant still keeps a host-side mirror at
//     `<root>/<slug>` for prompt-source (README.md + skills/).
//
// Slugs are derived deterministically from the URL so two channels pointing
// at the same remote share a mirror (and so the mirror path is stable across
// restarts).

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HomeSpec } from '../../shared/types';

// Per-channel model/provider triplet (#128). All three fields are required
// when a model triplet is in play — partial overrides aren't supported
// (silently inheriting just `base_url` from env would be a footgun). Only
// the env var NAME is persisted; the secret VALUE is read at use time via
// `process.env[api_key_env]`, mirroring how `auth_env` works for git PATs.
export type ModelTriplet = {
  name: string;
  base_url: string;
  api_key_env: string;
};

// The per-thread home snapshot frozen into `session.json` on first mention.
// Same shape as `HomeSpec` from the bot↔tenant wire format (`{remote,
// auth_env?}`) — the tenant doesn't enrich the spec before persisting.
export type HomeConfig = HomeSpec;

export type Transport = 'tunneled-file' | 'tunneled-mirror' | 'direct';

export type ResolvedHome = HomeConfig & {
  slug: string;
  transport: Transport;
  // For `tunneled-mirror`: the mirror directory on the host's data volume.
  // For `tunneled-file`: identical to `localPath` (the file:// pathname).
  // For `direct`: where a future PR will clone the read-only prompt mirror.
  mirrorPath: string;
  // The host-side working tree to read README.md / skills/ from AND to
  // serve to the sandbox over the WS-tunnel transport. For file:// it's
  // the pathname; for https:// it's the mirror dir.
  localPath: string;
};

// Resolve the mirror root: production sets `AGENT_HOMES_ROOT=/data/homes`
// in fly.toml; local dev / tests get an OS tmpdir under
// `agenta-homes-mirrors/`. The mirror dir is created by `entrypoint.sh` on
// Fly; locally the dir is virtual unless someone configures an https://
// entry (in which case the user must seed the mirror themselves — local dev
// usually points at a file:// URL where no mirror is needed).
export function defaultMirrorRoot(): string {
  const override = process.env.AGENT_HOMES_ROOT;
  if (override && override.length > 0) return override;
  return join(tmpdir(), 'agenta-homes-mirrors');
}

// Compute the slug from a URL. The form is `<host>-<pathname-sanitized>`,
// lowercased. For file:// URLs `host` is empty so we use just the
// sanitized pathname; sanitization replaces every char outside
// [A-Za-z0-9-] with `-` and collapses leading dashes so the slug never
// starts with one (filesystem-friendly).
//
// Examples:
//   https://github.com/eladb/agenta-test-home  → github.com-eladb-agenta-test-home
//   file:///Users/elad/home                     → users-elad-home
//   git@github.com:owner/repo.git               → invalid (rejected at validation)
function deriveSlug(url: URL): string {
  const host = url.host; // empty for file://
  const path = url.pathname.replace(/^\//, '').replace(/[^a-zA-Z0-9-]/g, '-');
  const raw = host ? `${host}-${path}` : path;
  // Lowercase, then collapse leading dashes (file:// produces them).
  return raw.toLowerCase().replace(/^-+/, '');
}

// SSH-style scp-form URLs (`git@host:owner/repo.git`) and `ssh://` URLs
// each need their own slug path: scp-form isn't an RFC-3986 URL, and
// `ssh://git@host/path` parses with the user as part of host. Match the
// `host + sanitized path` shape of `deriveSlug(URL)` so a future migration
// from https → ssh on the same repo preserves the slug if anyone hand-
// pins it.
function deriveSshSlug(remote: string): string {
  let host = '';
  let path = '';
  if (remote.startsWith('ssh://') || remote.startsWith('git+ssh://')) {
    // node:url parses these — strip user info, then reuse host + pathname.
    try {
      const u = new URL(remote);
      host = u.hostname; // user info stripped
      path = u.pathname.replace(/^\//, '');
    } catch {
      // Fall through to the scp-form parser.
    }
  }
  if (host === '') {
    // scp form: <user>@<host>:<path>
    const m = remote.match(/^[^@]+@([^:]+):(.+)$/);
    if (m) {
      host = m[1] ?? '';
      path = m[2] ?? '';
    }
  }
  const sanitized = path.replace(/[^a-zA-Z0-9-]/g, '-');
  const raw = host ? `${host}-${sanitized}` : sanitized;
  return raw.toLowerCase().replace(/^-+/, '');
}

function parseRemote(remote: string): URL {
  // node:url throws on unparseable input. We catch + rethrow with a clearer
  // message so envelope validation errors point at the offending entry.
  try {
    return new URL(remote);
  } catch (err) {
    throw new Error(`unparseable remote URL ${JSON.stringify(remote)}: ${(err as Error).message}`);
  }
}

// SSH URLs (`git@host:owner/repo`) are not RFC-3986 URLs — `new URL()`
// either rejects them or treats `git@host` as the userinfo. Detect them
// before falling through to URL parsing so we can emit a deterministic
// error pointing at #88 instead of a generic parse failure.
function isSshStyle(remote: string): boolean {
  if (remote.startsWith('ssh://')) return true;
  if (remote.startsWith('git@')) return true;
  // git+ssh:// is rare but valid; treat the same.
  if (remote.startsWith('git+ssh://')) return true;
  return false;
}

// Pure: derive transport + paths from a HomeConfig snapshot. Called at
// every use site (handler, bootstrap, refresh) so the envelope's home can
// be re-derived without re-resolving live threads — sessions store the
// HomeConfig, not the ResolvedHome.
export function resolveTransport(home: HomeConfig): ResolvedHome {
  if (isSshStyle(home.remote)) {
    const slug = deriveSshSlug(home.remote);
    if (slug.length === 0) {
      throw new Error(`could not derive slug from ssh remote ${JSON.stringify(home.remote)}`);
    }
    const mirror = join(defaultMirrorRoot(), slug);
    return {
      ...home,
      slug,
      transport: 'direct',
      // The tenant still keeps a host-side clone for prompt-source
      // (README.md + skills/). The sandbox uses the original SSH URL.
      mirrorPath: mirror,
      localPath: mirror,
    };
  }
  const url = parseRemote(home.remote);
  const slug = deriveSlug(url);
  if (slug.length === 0) {
    throw new Error(`could not derive slug from remote ${JSON.stringify(home.remote)}`);
  }
  if (url.protocol === 'file:') {
    // file:// — the URL pathname IS the working tree. No mirror needed.
    // url.pathname is always absolute (file:///x → /x), even on Windows
    // it's '/C:/...' which is wrong but we don't target Windows.
    const path = url.pathname;
    return {
      ...home,
      slug,
      transport: 'tunneled-file',
      mirrorPath: path,
      localPath: path,
    };
  }
  if (url.protocol === 'https:') {
    const mirror = join(defaultMirrorRoot(), slug);
    return {
      ...home,
      slug,
      transport: 'tunneled-mirror',
      mirrorPath: mirror,
      localPath: mirror,
    };
  }
  throw new Error(`unsupported URL scheme ${url.protocol} (remote: ${home.remote})`);
}

// Resolve an envelope's `home` field into a per-thread snapshot. Validates
// the auth_env reference against the tenant's process env so secret
// misconfiguration surfaces here (clear error) rather than later inside a
// git clone.
//
// Returned shape is intentionally the raw `HomeConfig` (remote + auth_env);
// slug / transport / paths derive on read via `resolveTransport`. That's
// what gets frozen into `session.json` on first mention.
//
// Auth rules mirror the legacy validator:
//   - file://       → auth_env MUST be absent.
//   - https://      → auth_env REQUIRED; env[auth_env] must be set.
//   - ssh:// / git@ → auth_env REQUIRED; env[auth_env] must be set.
export function resolveHomeFromEnvelope(home: HomeSpec, env: NodeJS.ProcessEnv): HomeConfig {
  if (typeof home.remote !== 'string' || home.remote.length === 0) {
    throw new Error('envelope home.remote required (non-empty string)');
  }
  if (isSshStyle(home.remote)) {
    if (typeof home.auth_env !== 'string' || home.auth_env.length === 0) {
      throw new Error(`envelope home.auth_env required for ssh:// / git@ remote ${home.remote}`);
    }
    requireEnvValue(env, home.auth_env);
    return { remote: home.remote, auth_env: home.auth_env };
  }
  const url = parseRemote(home.remote);
  if (url.protocol === 'file:') {
    if (home.auth_env !== undefined) {
      throw new Error(`envelope home.auth_env must be absent for file:// remote ${home.remote}`);
    }
    return { remote: home.remote };
  }
  if (url.protocol === 'https:') {
    if (typeof home.auth_env !== 'string' || home.auth_env.length === 0) {
      throw new Error(`envelope home.auth_env required for https:// remote ${home.remote}`);
    }
    requireEnvValue(env, home.auth_env);
    return { remote: home.remote, auth_env: home.auth_env };
  }
  throw new Error(`unsupported URL scheme ${url.protocol} (remote: ${home.remote})`);
}

function requireEnvValue(env: NodeJS.ProcessEnv, name: string): void {
  const v = env[name];
  if (v === undefined || v.length === 0) {
    throw new Error(`envelope home.auth_env ${name} is not set (or empty) in tenant env`);
  }
}
