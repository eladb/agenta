#!/usr/bin/env bash
# Container entrypoint for the agenta single image (#253).
#
# Three roles share one image:
#
#   bot     — Slack ingress router. Loads config/tenants.json, opens one
#             Socket Mode connection, forwards events to per-tenant /events
#             URLs over HTTP. No disk writes, no model calls, no Slack ops.
#
#   tenant  — Agent harness. Owns /data, sessions, sandboxes, model gateway,
#             home repos. Listens on HEALTH_PORT for /events (bot dispatches)
#             + /health. Home for each thread arrives in the envelope; mirror
#             clones happen lazily inside the tenant.
#
#   combo   — Both roles co-located in one container, sharing the volume
#             and secrets. The bot's `tenants.json` is rendered at boot from
#             env vars (WORKSPACE_ID, DEFAULT_HOME_REMOTE, optional
#             CHANNEL_HOMES_JSON) and points the workspace's default route
#             at the loopback tenant. Used today by the single-tenant
#             agenta-bot + acme deployments while the split-app cutover
#             is still a follow-up. Slack sees one Socket Mode client per
#             xapp; the lockfile design keeps bot + tenant from clobbering
#             each other inside the container.
#
# Selector: first arg, defaulting to `tenant` so an unset CMD keeps backward
# compat with operators who pulled the image before the split.
#
# Required env (set as Fly secrets / ECS task env):
#
#   bot:
#     SLACK_APP_TOKEN       — xapp- (one per deployment).
#     SLACK_BOT_TOKEN       — xoxb- (request-scoped via envelope; v1 single-tenant
#                              just uses this for every envelope).
#     <per-tenant>           — every TenantEndpoint.auth_env referenced by
#                              config/tenants.json must be set; the bot reads
#                              them at dispatch time.
#
#   tenant:
#     TENANT_SECRET         — shared bearer the bot uses to call /events.
#     MODEL_API_KEY         — (or ANTHROPIC_API_KEY) for the model gateway.
#     <per-home auth_env>   — every home.auth_env that ever lands in an
#                              envelope must be set; tenant resolves at use.
#
#   combo: union of the above PLUS
#     WORKSPACE_ID          — Slack team_id the default route is keyed under.
#     DEFAULT_HOME_REMOTE   — default home repo URL (file://, https://, ssh:// or git@).
#     DEFAULT_HOME_AUTH_ENV — (optional) env-var NAME holding deploy key / PAT
#                              for the default home.
#     CHANNEL_HOMES_JSON    — (optional) raw JSON object for
#                              routes[WORKSPACE_ID].channels — e.g.
#                              `{"C0B4MU6GCFQ":{"tenant":"default","home":{...}}}`.
#
# Optional env (both roles):
#
#   AGENTA_DATA_DIR         — tenant only; defaults to /data/agenta (fly.toml).
#   AGENT_HOMES_ROOT        — tenant only; mirror root, default /data/homes.
#   AGENTA_SANDBOX_APP      — tenant only; sandbox Fly app, default agenta-sandbox.
#   TENANT_INTERNAL_PORT    — combo only; loopback port the tenant listens on,
#                              default 8081. Bot's /health stays on HEALTH_PORT
#                              (default 8080) so Fly's [[checks]] still passes.

set -euo pipefail

ROLE="${1:-tenant}"

run_tenant_setup() {
  # The tenant's flyProvider (src/tenant/sandbox/fly.ts:appName) calls
  # requireEnv('FLY_APP_NAME') with no fallback — it does NOT read
  # AGENTA_SANDBOX_APP. We have to export FLY_APP_NAME ourselves so
  # per-thread sandboxes land in the SANDBOX Fly app (default
  # "agenta-sandbox"), not whatever the surrounding host calls itself.
  #
  # Unconditional on purpose:
  #   - On Fly, Fly's machine runtime auto-injects FLY_APP_NAME=<host app>
  #     (e.g. agenta-bot or acme-tenant). This export overrides that
  #     injection so the tenant hits /apps/agenta-sandbox/* not the host.
  #   - On ECS (or any non-Fly host), nothing injects FLY_APP_NAME, so
  #     this export sets it from scratch — flyProvider would otherwise
  #     crash on requireEnv.
  export FLY_APP_NAME="${AGENTA_SANDBOX_APP:-agenta-sandbox}"

  DATA_DIR="${AGENTA_DATA_DIR:-/data/agenta}"
  HOMES_ROOT="${AGENT_HOMES_ROOT:-/data/homes}"
  mkdir -p "$DATA_DIR" "$HOMES_ROOT"
}

render_combo_tenants_json() {
  # Build a single-tenant tenants.json that routes the workspace's default
  # at the loopback tenant. Writes to $1.
  local out_path="$1"
  : "${WORKSPACE_ID:?combo: WORKSPACE_ID required (Slack team_id)}"
  : "${DEFAULT_HOME_REMOTE:?combo: DEFAULT_HOME_REMOTE required}"
  : "${TENANT_SECRET:?combo: TENANT_SECRET required (auth_env value for the loopback tenant)}"

  local tenant_port="${TENANT_INTERNAL_PORT:-8081}"

  # Build the default home block. auth_env is optional (file:// + public
  # https don't need one).
  local default_home_json
  if [ -n "${DEFAULT_HOME_AUTH_ENV:-}" ]; then
    default_home_json=$(jq -nc --arg r "$DEFAULT_HOME_REMOTE" --arg a "$DEFAULT_HOME_AUTH_ENV" \
      '{remote:$r, auth_env:$a}')
  else
    default_home_json=$(jq -nc --arg r "$DEFAULT_HOME_REMOTE" '{remote:$r}')
  fi

  # Channel overrides default to {} when not provided.
  local channels_json="${CHANNEL_HOMES_JSON:-{\}}"

  jq -n \
    --arg url "http://127.0.0.1:${tenant_port}" \
    --arg tk "TENANT_SECRET" \
    --arg ws "$WORKSPACE_ID" \
    --argjson home "$default_home_json" \
    --argjson channels "$channels_json" \
    '{
      tenants: { default: { url: $url, auth_env: $tk } },
      routes: { ($ws): { default: { tenant: "default", home: $home }, channels: $channels } }
    }' > "$out_path"
}

wait_for_tenant_ready() {
  local port="$1"
  local deadline=$(( $(date +%s) + 60 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsS "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "[entrypoint] tenant did not become ready on :$port within 60s" >&2
  return 1
}

case "$ROLE" in
  bot)
    echo "[entrypoint] role=bot"
    exec bun src/bot/index.ts
    ;;
  tenant)
    echo "[entrypoint] role=tenant"
    run_tenant_setup
    # No home prefetch here — under #253 the home spec arrives in each
    # `/events` envelope; the tenant's bootstrap / home-refresh code
    # clones lazily on first use.
    exec bun src/tenant/index.ts
    ;;
  combo)
    echo "[entrypoint] role=combo"
    run_tenant_setup

    TENANT_PORT="${TENANT_INTERNAL_PORT:-8081}"
    BOT_PORT="${HEALTH_PORT:-8080}"

    TENANTS_JSON_OUT="${TENANTS_JSON_PATH:-/tmp/tenants.json}"
    render_combo_tenants_json "$TENANTS_JSON_OUT"
    export TENANTS_JSON_PATH="$TENANTS_JSON_OUT"
    echo "[entrypoint] rendered tenants.json -> $TENANTS_JSON_OUT"

    # Tenant in background on TENANT_PORT; bot in foreground on BOT_PORT.
    # If either dies, we exit so the platform (Fly/ECS) restarts the
    # whole container.
    HEALTH_PORT="$TENANT_PORT" bun src/tenant/index.ts &
    TENANT_PID=$!

    # Forward SIGTERM/SIGINT to the tenant so it can release locks cleanly.
    trap 'kill -TERM "$TENANT_PID" 2>/dev/null || true' TERM INT

    wait_for_tenant_ready "$TENANT_PORT" || { kill "$TENANT_PID" 2>/dev/null || true; exit 1; }

    HEALTH_PORT="$BOT_PORT" bun src/bot/index.ts &
    BOT_PID=$!

    # Wait for whichever child dies first; exit with its code so the
    # platform restarts us. `wait -n` returns the exit status of the
    # first-to-exit child.
    set +e
    wait -n "$TENANT_PID" "$BOT_PID"
    rc=$?
    set -e
    echo "[entrypoint] combo: one process exited (rc=$rc), terminating the other"
    kill -TERM "$TENANT_PID" "$BOT_PID" 2>/dev/null || true
    wait "$TENANT_PID" 2>/dev/null || true
    wait "$BOT_PID" 2>/dev/null || true
    exit "$rc"
    ;;
  *)
    echo "[entrypoint] FATAL: unknown role $(printf %q "$ROLE") (want 'bot', 'tenant', or 'combo')" >&2
    exit 1
    ;;
esac
