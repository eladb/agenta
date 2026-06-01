---
name: watchdog-pause-when-creds-broken
description: "When the canary watchdog can't reach a cloud target because OUR credentials are bad (not the target being down), pause that target's check in canary-monitor.sh instead of letting it page every 30 min — the alerts are noise and burn oncall tokens until creds return."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2c39036d-3357-4679-8941-5e865798a190
---

Distinguish a *target outage* (the bot is down, restart might recover it) from a *watchdog blind spot* (our local AWS/Slack/Fly creds went bad, the bot might be fine and we just can't tell). The bounded remediation the watchdog's oncall prompt asks for assumes target outage; running the remediation against a watchdog blind spot uses the same dead creds and fails identically. Pasting the same "still blocked" thread reply every 30 min costs tokens without producing signal.

**Why:** On 2026-05-31 the salto-staging IAM keys (both `.env` and GH `secrets.AWS_*`) were rotated out mid-fix-forward. The watchdog's salto/ECS canary started failing with `InvalidClientTokenId` on `aws describe-services` — the bot's runtime might have been fine, but no way to tell. The watchdog kept paging on the 30-min cadence. Elad's call: pause the check and stop the firehose.

**How to apply:** In `~/.local/bin/canary-monitor.sh`, comment out the `check <target> "<label>" || true` line at the bottom of the script, and add `record_result <target> paused` so the status.json still publishes a row. Leave a dated comment with the pause reason so the next person knows the unpause condition. Re-enable by uncommenting once the creds are back. Don't change concurrency settings, cron schedule, or the alert wiring — just the single check call.

Don't pause both targets — if the healthy one regresses for a real reason, the watchdog needs to be live for it. See also [[canary-monitoring-setup]].
