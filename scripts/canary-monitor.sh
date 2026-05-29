#!/usr/bin/env bash
# canary-monitor.sh — 30-min double-canary watchdog for the agenta + salto bots.
#
# Deployed by install.sh to ~/.local/bin and run by cron every 30 min. For
# each target it runs scripts/canary.ts; on a confirmed failure (red twice,
# to rule out a flake) it posts a Slack alert to the test channel and wakes
# the agenta agent (oncall) via `agents send` to investigate + apply BOUNDED
# safe remediation. Remediation is agent-driven on purpose: a blind restart
# on a transient blip is harmful and wouldn't fix an upstream outage.
#
# Repo location comes from $AGENTA_REPO (install.sh bakes it into the cron
# line); falls back to $HOME. Needs this host's .env + the `agents` CLI.
#
# NOTE: this watchdog canaries and (via the woken agent) remediates PROD.
# It must run on exactly ONE host. install.sh installs it unconditionally,
# so don't run install.sh on a second box you don't want canarying prod.
set -uo pipefail   # not -e: canary failures are handled, not fatal.

REPO="${AGENTA_REPO:-$HOME}"
LOG="$REPO/canary-monitor.log"
ALERT_CHANNEL=C0B307LP274
export PATH="$HOME/.bun/bin:$HOME/.fly/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"

cd "$REPO" || exit 1
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$LOG"; }

# Single-flight: skip if a previous run is still going (a red run can take ~6 min).
exec 9>"$REPO/.canary-monitor.lock"
flock -n 9 || { log "skip: previous run still in progress"; exit 0; }

[ -f "$REPO/.env" ] || { log "abort: no .env in $REPO"; exit 1; }
# AWS creds for the ECS health gate; tester token for the Slack alert.
set -a; eval "$(grep -E '^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|REGION)=' .env)"; set +a
TESTER_BOT="$(grep '^TEST_BOT_TOKEN=' .env | cut -d= -f2-)"

# Run one target's canary; stdout+stderr → $2. Returns canary exit code.
run_canary() {
  local target="$1" out="$2"
  if [ "$target" = fly ]; then
    # FLY_API_TOKEN comes from .env (org-scoped); FLY_APP_NAME→agenta-bot so the
    # Fly health gate checks the bot machine, not the sandbox app.
    FLY_APP_NAME=agenta-bot AGENTA_DEPLOY_TARGET=fly \
      CANARY_TARGET_USER_ID=U0B2WQUHK6Z \
      bun scripts/canary.ts >"$out" 2>&1
  else
    AGENTA_DEPLOY_TARGET=ecs AGENTA_ECS_CLUSTER=agenta-bot AGENTA_ECS_SERVICE=agenta-bot \
      CANARY_TARGET_USER_ID=U0B65LMHRLL \
      bun scripts/canary.ts >"$out" 2>&1
  fi
}

slack_alert() {
  curl -s -X POST https://slack.com/api/chat.postMessage \
    -H "Authorization: Bearer $TESTER_BOT" \
    -H 'Content-Type: application/json; charset=utf-8' \
    --data "$(jq -nc --arg c "$ALERT_CHANNEL" --arg t "$1" '{channel:$c,text:$t}')" >/dev/null
}

# check <fly|ecs> <label> — 0 = green (or recovered on retry), 1 = confirmed red.
check() {
  local target="$1" label="$2" out1 out2 tail2
  out1="$(mktemp)"
  if run_canary "$target" "$out1"; then log "$label OK"; rm -f "$out1"; return 0; fi
  log "$label red on attempt 1 — re-running to rule out a flake"
  out2="$(mktemp)"
  if run_canary "$target" "$out2"; then
    log "$label recovered on retry (transient)"; rm -f "$out1" "$out2"; return 0
  fi
  tail2="$(tail -n 8 "$out2")"
  log "$label CONFIRMED RED:"$'\n'"$tail2"
  slack_alert ":rotating_light: canary RED: *${label}* (failed twice). Agenta (oncall) is investigating.
\`\`\`
${tail2}
\`\`\`"
  # Wake the oncall agent. Single line — newlines would submit early in the PTY.
  agents send agenta "ONCALL: the ${label} canary failed twice in the 30-min watchdog. Investigate now — run the /canary skill for just this target to confirm, diagnose with the debug-thread skill + Fly/ECS/CD logs, and if clearly wedged apply ONE bounded safe remediation (agenta/Fly: 'flyctl machine restart <id> -a agenta-bot'; salto/ECS: 'aws ecs update-service --cluster agenta-bot --service agenta-bot --force-new-deployment'), then re-verify and post the outcome to ${ALERT_CHANNEL}. Do NOT redeploy new code, scale, run destructive ops, or change secrets/config — escalate those to Elad. Full output is in ${LOG} and the Slack alert." 2>>"$LOG"
  rm -f "$out1" "$out2"
  return 1
}

log "=== monitor run start ==="
check fly "agenta/Fly" || true
check ecs "salto/ECS" || true
log "=== monitor run end ==="
