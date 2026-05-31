#!/usr/bin/env bash
# Container entrypoint for the agenta single image (#253).
#
# Two roles share one image:
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
# Optional env (both roles):
#
#   AGENTA_DATA_DIR         — tenant only; defaults to /data/agenta (fly.toml).
#   AGENT_HOMES_ROOT        — tenant only; mirror root, default /data/homes.
#   AGENTA_SANDBOX_APP      — tenant only; sandbox Fly app, default agenta-sandbox.

set -euo pipefail

ROLE="${1:-tenant}"

case "$ROLE" in
  bot)
    echo "[entrypoint] role=bot"
    exec bun src/bot/index.ts
    ;;
  tenant)
    echo "[entrypoint] role=tenant"

    # The tenant's flyProvider (src/tenant/sandbox/fly.ts:appName) calls
    # requireEnv('FLY_APP_NAME') with no fallback — it does NOT read
    # AGENTA_SANDBOX_APP. We have to export FLY_APP_NAME ourselves so
    # per-thread sandboxes land in the SANDBOX Fly app (default
    # "agenta-sandbox"), not whatever the surrounding host calls itself.
    #
    # Unconditional on purpose:
    #   - On Fly, Fly's machine runtime auto-injects FLY_APP_NAME=<host app>
    #     (e.g. agenta-bot or salto-tenant). This export overrides that
    #     injection so the tenant hits /apps/agenta-sandbox/* not the host.
    #   - On ECS (or any non-Fly host), nothing injects FLY_APP_NAME, so
    #     this export sets it from scratch — flyProvider would otherwise
    #     crash on requireEnv.
    export FLY_APP_NAME="${AGENTA_SANDBOX_APP:-agenta-sandbox}"

    DATA_DIR="${AGENTA_DATA_DIR:-/data/agenta}"
    HOMES_ROOT="${AGENT_HOMES_ROOT:-/data/homes}"
    mkdir -p "$DATA_DIR" "$HOMES_ROOT"

    # No home prefetch here — under #253 the home spec arrives in each
    # `/events` envelope; the tenant's bootstrap / home-refresh code
    # clones lazily on first use.
    exec bun src/tenant/index.ts
    ;;
  *)
    echo "[entrypoint] FATAL: unknown role $(printf %q "$ROLE") (want 'bot' or 'tenant')" >&2
    exit 1
    ;;
esac
