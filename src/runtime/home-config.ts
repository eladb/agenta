// Per-channel agent-home configuration.
//
// Each Slack channel can point at its own home repo; transport is inferred
// from the URL scheme of the configured `remote`. The default entry applies
// to any channel not explicitly listed. See `config/homes.json` for the
// canonical schema and `gh issue view 87` for the design.
//
// The config file lives at `config/homes.json` relative to the repo root.
// `AGENT_HOMES_CONFIG` overrides the path (used by tests via
// `withTempHomeConfig`).
//
// Three transports — `tunneled-file`, `tunneled-mirror`, `direct` — are
// derived from `URL.protocol`:
//   - `file:`  → tunneled, no mirror (the file:// path IS the working tree).
//   - `https:` → tunneled, with a mirror clone at `<root>/<slug>` that
//     `entrypoint.sh` refreshes on boot.
//   - `git@` / `ssh:` → direct (NOT implemented; deferred to #88). Caught
//     at validation time so a misconfigured ssh URL fails fast.
//
// Slugs are derived deterministically from the URL so two channels pointing
// at the same remote share a mirror (and so the mirror path is stable across
// restarts).

import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type HomeConfig = {
  remote: string;
  auth_env?: string;
};

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

export type HomesFile = {
  default: HomeConfig;
  channels: Record<string, HomeConfig>;
};

const REPO_ROOT = join(import.meta.dir, '..', '..');

export function defaultConfigPath(): string {
  const override = process.env.AGENT_HOMES_CONFIG;
  if (override && override.length > 0) return override;
  return join(REPO_ROOT, 'config', 'homes.json');
}

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

function parseRemote(remote: string): URL {
  // node:url throws on unparseable input. We catch + rethrow with a clearer
  // message so config validation errors point at the offending entry.
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
// every use site (handler, bootstrap) so the config file can be edited
// without re-resolving live threads — sessions store the HomeConfig, not
// the ResolvedHome.
export function resolveTransport(home: HomeConfig): ResolvedHome {
  if (isSshStyle(home.remote)) {
    throw new Error(`SSH transport requires #88; not implemented (remote: ${home.remote})`);
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

// Validate a single HomeConfig entry. Throws with a clear message keyed
// off the entry's name (`default` or a channel id). Auth rules:
//   - file:// → auth_env MUST be absent.
//   - https:// → auth_env REQUIRED, and process.env[auth_env] must be set.
//   - ssh / git@ → rejected (deferred to #88).
function validateEntry(name: string, home: HomeConfig): void {
  if (typeof home.remote !== 'string' || home.remote.length === 0) {
    throw new Error(`[${name}] missing required string "remote"`);
  }
  if (isSshStyle(home.remote)) {
    throw new Error(
      `[${name}] SSH transport requires #88; not implemented (remote: ${home.remote})`,
    );
  }
  const url = parseRemote(home.remote);
  if (url.protocol === 'file:') {
    if (home.auth_env !== undefined) {
      throw new Error(`[${name}] auth_env must be absent for file:// URLs`);
    }
    return;
  }
  if (url.protocol === 'https:') {
    if (typeof home.auth_env !== 'string' || home.auth_env.length === 0) {
      throw new Error(`[${name}] auth_env required for https:// URLs`);
    }
    const v = process.env[home.auth_env];
    if (!v || v.length === 0) {
      throw new Error(`[${name}] auth_env ${home.auth_env} is not set (or empty) in process env`);
    }
    return;
  }
  throw new Error(`[${name}] unsupported URL scheme ${url.protocol}`);
}

// Read + validate the homes config. Throws on any validation failure so
// the bot refuses to start with a bad config — same shape as the other
// boot-time env checks. Cached after first call.
let cached: HomesFile | undefined;

export function loadHomesConfig(path: string = defaultConfigPath()): HomesFile {
  if (cached !== undefined) return cached;
  if (!existsSync(path)) {
    throw new Error(`homes config not found at ${path} (set AGENT_HOMES_CONFIG to override)`);
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`failed to read homes config at ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`failed to parse homes config at ${path}: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`homes config at ${path} must be a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  if (!obj.default || typeof obj.default !== 'object' || Array.isArray(obj.default)) {
    throw new Error(`homes config at ${path} is missing required "default" entry`);
  }
  if (
    obj.channels !== undefined &&
    (typeof obj.channels !== 'object' || obj.channels === null || Array.isArray(obj.channels))
  ) {
    throw new Error(`homes config at ${path}: "channels" must be an object if present`);
  }
  const file: HomesFile = {
    default: obj.default as HomeConfig,
    channels: (obj.channels as Record<string, HomeConfig>) ?? {},
  };
  validateEntry('default', file.default);
  for (const [chan, home] of Object.entries(file.channels)) {
    validateEntry(chan, home);
  }
  cached = file;
  return file;
}

// Channel-specific entry if present, else the default. Returns a snapshot
// (HomeConfig) suitable for freezing into session.json — slug + transport +
// paths recompute on read via `resolveTransport`.
export function resolveHome(channelId: string, path?: string): HomeConfig {
  const file = loadHomesConfig(path);
  const specific = file.channels[channelId];
  if (specific) return { ...specific };
  return { ...file.default };
}

// For tests — drop the module-level cache so a new AGENT_HOMES_CONFIG
// takes effect.
export function _resetCacheForTests(): void {
  cached = undefined;
}
