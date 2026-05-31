// Shared wire + config types for the bot↔tenant split (#253).
//
// `HomeSpec` is the trimmed-down home descriptor the bot forwards in an
// envelope: just `{ remote, auth_env? }` — no slug/transport/paths (those
// are derived per-call inside the tenant). `auth_env` is the NAME of an
// env var the tenant resolves against its own process env; the bot never
// touches the secret value. Same indirection rule as the legacy per-tenant
// homes.json `auth_env`.
//
// `EventEnvelope` is the body of `POST /events`. The bot mints it after
// resolving the route and dispatches it to the chosen tenant's URL. `xoxb`
// is request-scoped (not persisted by the tenant) and is the only Slack
// credential on the wire — the tenant uses it for this turn's Slack ops.
//
// `TenantsConfig` is the per-deployment operator config (config/tenants.json)
// the bot loads at boot. It merges the routing table and the per-channel
// home spec — both are channel-keyed operator concerns, so keeping them in
// one file removes a sync hazard.

export type HomeSpec = {
  remote: string;
  auth_env?: string;
};

export type EventEnvelope = {
  envelope_id: string;
  type: 'event_callback' | 'interactive';
  workspace_id: string;
  // Request-scoped bot xoxb. Tenant uses this for the turn's Slack ops;
  // it is NEVER persisted to disk.
  xoxb: string;
  home: HomeSpec;
  // Raw Slack envelope (event_callback payload or interactive payload).
  // The tenant's existing event normalizer parses it.
  payload: unknown;
};

// Routing target: which tenant serves this (team_id, channel_id?) and with
// which home repo. Home is forwarded to the tenant verbatim — the tenant
// has no local home config of its own.
export type RouteTarget = {
  tenant: string;
  home: HomeSpec;
};

export type TenantEndpoint = {
  url: string;
  // Env-var NAME holding the shared bearer secret used by the bot when
  // calling this tenant's /events. Resolved by the bot against its own
  // env at dispatch time.
  auth_env: string;
};

export type WorkspaceRoutes = {
  default?: RouteTarget;
  channels?: Record<string, RouteTarget>;
};

export type TenantsConfig = {
  tenants: Record<string, TenantEndpoint>;
  // Keyed by Slack team_id (workspace_id). Missing entry => unrouted
  // workspace; the bot drops + logs + metrics those.
  routes: Record<string, WorkspaceRoutes>;
};
