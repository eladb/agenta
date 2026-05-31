// Parser + resolver for the bot's per-deployment tenants.json config (#253).
//
// `parseTenantsConfig` validates a freshly-read JSON blob and throws on any
// schema violation so the bot refuses to start with a malformed config —
// same boot-refuse pattern as the legacy `loadHomesConfig`. Validation is
// structural only: it does NOT verify referenced env vars exist (the bot
// resolves those at dispatch time per request).
//
// `resolveRoute` is pure: most-specific-wins over a (team_id, channel_id?)
// key. Lookup order:
//   1. routes[team_id].channels[channel_id] — if both team and channel hit.
//   2. routes[team_id].default              — workspace fallback.
//   3. null                                 — workspace has no entry at all,
//                                              OR has channels-only and the
//                                              channel didn't match.
// Returning null means "drop + log" at the call site; the bot never
// implicitly serves an unrouted event.

import type { HomeSpec, RouteTarget, TenantsConfig, WorkspaceRoutes } from './types';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateHome(scope: string, raw: unknown): HomeSpec {
  if (!isPlainObject(raw)) {
    throw new Error(`[${scope}] "home" must be an object`);
  }
  if (typeof raw.remote !== 'string' || raw.remote.length === 0) {
    throw new Error(`[${scope}] home.remote required (non-empty string)`);
  }
  const home: HomeSpec = { remote: raw.remote };
  if (raw.auth_env !== undefined) {
    if (typeof raw.auth_env !== 'string' || raw.auth_env.length === 0) {
      throw new Error(`[${scope}] home.auth_env must be a non-empty string if present`);
    }
    home.auth_env = raw.auth_env;
  }
  return home;
}

function validateRouteTarget(scope: string, raw: unknown, tenantNames: Set<string>): RouteTarget {
  if (!isPlainObject(raw)) {
    throw new Error(`[${scope}] route target must be an object`);
  }
  if (typeof raw.tenant !== 'string' || raw.tenant.length === 0) {
    throw new Error(`[${scope}] tenant required (non-empty string)`);
  }
  if (!tenantNames.has(raw.tenant)) {
    throw new Error(`[${scope}] tenant ${JSON.stringify(raw.tenant)} not declared in "tenants"`);
  }
  const home = validateHome(`${scope}.home`, raw.home);
  return { tenant: raw.tenant, home };
}

function validateWorkspaceRoutes(
  teamId: string,
  raw: unknown,
  tenantNames: Set<string>,
): WorkspaceRoutes {
  if (!isPlainObject(raw)) {
    throw new Error(`[routes.${teamId}] must be an object`);
  }
  const out: WorkspaceRoutes = {};
  if (raw.default !== undefined) {
    out.default = validateRouteTarget(`routes.${teamId}.default`, raw.default, tenantNames);
  }
  if (raw.channels !== undefined) {
    if (!isPlainObject(raw.channels)) {
      throw new Error(`[routes.${teamId}.channels] must be an object if present`);
    }
    const channels: Record<string, RouteTarget> = {};
    for (const [chan, target] of Object.entries(raw.channels)) {
      channels[chan] = validateRouteTarget(
        `routes.${teamId}.channels.${chan}`,
        target,
        tenantNames,
      );
    }
    out.channels = channels;
  }
  if (out.default === undefined && (out.channels === undefined || Object.keys(out.channels).length === 0)) {
    throw new Error(
      `[routes.${teamId}] must declare "default" or at least one channel in "channels"`,
    );
  }
  return out;
}

export function parseTenantsConfig(raw: unknown): TenantsConfig {
  if (!isPlainObject(raw)) {
    throw new Error('tenants config must be a JSON object');
  }
  if (!isPlainObject(raw.tenants)) {
    throw new Error('tenants config missing required "tenants" object');
  }
  const tenants: Record<string, { url: string; auth_env: string }> = {};
  for (const [name, entry] of Object.entries(raw.tenants)) {
    if (!isPlainObject(entry)) {
      throw new Error(`[tenants.${name}] must be an object`);
    }
    if (typeof entry.url !== 'string' || entry.url.length === 0) {
      throw new Error(`[tenants.${name}] url required (non-empty string)`);
    }
    if (typeof entry.auth_env !== 'string' || entry.auth_env.length === 0) {
      throw new Error(`[tenants.${name}] auth_env required (non-empty string)`);
    }
    tenants[name] = { url: entry.url, auth_env: entry.auth_env };
  }
  if (Object.keys(tenants).length === 0) {
    throw new Error('tenants config must declare at least one tenant');
  }
  if (!isPlainObject(raw.routes)) {
    throw new Error('tenants config missing required "routes" object');
  }
  const tenantNames = new Set(Object.keys(tenants));
  const routes: Record<string, WorkspaceRoutes> = {};
  for (const [teamId, entry] of Object.entries(raw.routes)) {
    routes[teamId] = validateWorkspaceRoutes(teamId, entry, tenantNames);
  }
  return { tenants, routes };
}

// Most-specific-wins routing. Returns null when the workspace is entirely
// unrouted OR when a channels-only entry has no match for `channelId` and
// no `default`. The caller logs + metrics the null case.
export function resolveRoute(
  config: TenantsConfig,
  teamId: string,
  channelId?: string,
): RouteTarget | null {
  const ws = config.routes[teamId];
  if (!ws) return null;
  if (channelId !== undefined && ws.channels) {
    const hit = ws.channels[channelId];
    if (hit) return hit;
  }
  if (ws.default) return ws.default;
  return null;
}
