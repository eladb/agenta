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
//   - `git@` / `ssh:` → direct (#88). Sandbox clones + pushes straight to
//     the SSH remote; the bot still keeps a host-side mirror at
//     `<root>/<slug>` for prompt-source (README.md + skills/).
//
// Slugs are derived deterministically from the URL so two channels pointing
// at the same remote share a mirror (and so the mirror path is stable across
// restarts).

import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Per-channel model/provider triplet (#128). All three fields are required
// when the `model` block is present in homes.json — partial overrides aren't
// supported (silently inheriting just `base_url` from env would be a footgun).
// Only the env var NAME is persisted; the secret VALUE is read at use time
// via `process.env[api_key_env]`, mirroring how `auth_env` works for git PATs.
export type ModelTriplet = {
  name: string;
  base_url: string;
  api_key_env: string;
};

// Per-channel UI mode (#141). `verbose` is the existing single-message-per-turn
// debug surface (tool labels, provisioning lines, checklist). `pretty` is a
// polished progress surface for end-user channels — model `content` as the
// progress line, humanized fallback labels when content is null, footer
// `_ran N tools_` on the final reply. Default is `verbose`. Frozen into
// session.json on first mention, same shape as `model`.
export type DisplayStyle = 'verbose' | 'pretty';
export type DisplayConfig = {
  style: DisplayStyle;
};

export type HomeConfig = {
  remote: string;
  auth_env?: string;
  model?: ModelTriplet;
  display?: DisplayConfig;
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
    const slug = deriveSshSlug(home.remote);
    if (slug.length === 0) {
      throw new Error(`could not derive slug from ssh remote ${JSON.stringify(home.remote)}`);
    }
    const mirror = join(defaultMirrorRoot(), slug);
    return {
      ...home,
      slug,
      transport: 'direct',
      // The bot still keeps a host-side clone for prompt-source (README.md
      // + skills/). The sandbox uses the original SSH URL directly.
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

// Validate a single HomeConfig entry. Throws with a clear message keyed
// off the entry's name (`default` or a channel id). Auth rules:
//   - file:// → auth_env MUST be absent.
//   - https:// → auth_env REQUIRED, and process.env[auth_env] must be set.
//   - ssh / git@ → auth_env REQUIRED (PEM-formatted private key), and
//     process.env[auth_env] must be set. The PEM itself is read at use
//     time, not here, so config-reload survives a transient unset.
// Validate the optional `model` block (#128). All three keys required when
// present; the referenced env var must be set at boot. Same shape as the
// `auth_env` check above.
function validateModel(name: string, model: unknown): void {
  if (model === undefined) return;
  if (typeof model !== 'object' || model === null || Array.isArray(model)) {
    throw new Error(`[${name}] "model" must be an object if present`);
  }
  const m = model as Record<string, unknown>;
  for (const key of ['name', 'base_url', 'api_key_env'] as const) {
    if (typeof m[key] !== 'string' || (m[key] as string).length === 0) {
      throw new Error(
        `[${name}] model.${key} required (all three of name/base_url/api_key_env must be set together)`,
      );
    }
  }
  const envName = m.api_key_env as string;
  const v = process.env[envName];
  if (!v || v.length === 0) {
    throw new Error(`[${name}] model.api_key_env ${envName} is not set (or empty) in process env`);
  }
}

function validateDisplay(name: string, display: unknown): void {
  if (display === undefined) return;
  if (typeof display !== 'object' || display === null || Array.isArray(display)) {
    throw new Error(`[${name}] "display" must be an object if present`);
  }
  const d = display as Record<string, unknown>;
  if (typeof d.style !== 'string') {
    throw new Error(`[${name}] display.style required (string)`);
  }
  if (d.style !== 'verbose' && d.style !== 'pretty') {
    throw new Error(
      `[${name}] unknown display.style ${JSON.stringify(d.style)} (allowed: "verbose" | "pretty")`,
    );
  }
}

function validateEntry(name: string, home: HomeConfig): void {
  if (typeof home.remote !== 'string' || home.remote.length === 0) {
    throw new Error(`[${name}] missing required string "remote"`);
  }
  validateModel(name, home.model);
  validateDisplay(name, home.display);
  if (isSshStyle(home.remote)) {
    if (typeof home.auth_env !== 'string' || home.auth_env.length === 0) {
      throw new Error(`[${name}] auth_env required for ssh:// / git@ URLs`);
    }
    const v = process.env[home.auth_env];
    if (!v || v.length === 0) {
      throw new Error(`[${name}] auth_env ${home.auth_env} is not set (or empty) in process env`);
    }
    return;
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

// Resolve the per-thread model triplet (#128). Channel-specific `model`
// block wins, else the default's, else the caller-supplied fallback
// (typically env-derived in production, undefined in tests with a fully-
// configured homes.json). Returns undefined if no source provides a triplet
// — callers must surface that as a boot/config error since the agent can't
// run without one.
export function resolveModel(
  channelId: string,
  fallback: ModelTriplet | undefined,
  path?: string,
): ModelTriplet | undefined {
  const file = loadHomesConfig(path);
  const specific = file.channels[channelId];
  if (specific?.model) return { ...specific.model };
  if (file.default.model) return { ...file.default.model };
  return fallback ? { ...fallback } : undefined;
}

// Resolve the per-thread display style (#141). Channel-specific `display`
// block wins, else the default's, else `"verbose"`. Pure lookup — no env
// fallback because display is a UX choice, not a deploy-wide knob.
export function resolveDisplay(channelId: string, path?: string): DisplayConfig {
  const file = loadHomesConfig(path);
  const specific = file.channels[channelId];
  if (specific?.display) return { ...specific.display };
  if (file.default.display) return { ...file.default.display };
  return { style: 'verbose' };
}

// For tests — drop the module-level cache so a new AGENT_HOMES_CONFIG
// takes effect.
export function _resetCacheForTests(): void {
  cached = undefined;
}
