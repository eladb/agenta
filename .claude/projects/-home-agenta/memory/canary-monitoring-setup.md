---
name: canary-monitoring-setup
description: "Host-local 30-min cron watchdog that runs the double canary and wakes the oncall agent on confirmed red. CURRENTLY UNARMED — Fly target gone, acme/ECS down."
metadata:
  node_type: memory
  type: project
  originSessionId: 73f0e26f-a9df-459f-a065-da90c831bf52
---

**STATUS (2026-06-02): the watchdog is UNARMED and has no live target.** The `*/30` cron was removed when this agent was torn down 2026-06-01 (`--keep-home`); the agenta/Fly deployment it canaried was destroyed 2026-06-02 to stop cost (see CLAUDE.md "Production runtime" — no agenta Fly app exists, and CD no longer deploys or canaries); the acme/ECS target is itself down pending the AWS-account migration. So both halves of the "double canary" are currently dead. The recipe below still exists on disk and can be re-armed if acme/ECS comes back — but do NOT assume it's running or that there's a Fly bot to canary.

The watchdog is **not in the repo** — a future session won't find it by reading code. The reusable recipe is the [[canary]] repo skill; the host script survives at `~/.local/bin/canary-monitor.sh`.

- **Cron** (agenta user crontab, when armed): `*/30 * * * *` → `~/.local/bin/canary-monitor.sh`. Re-arm by re-running `./install.sh` (it installs the cron + deps). Currently absent.
- **`canary-monitor.sh`** runs `scripts/canary.ts` against each configured target. Green → quiet, appends to its log. Red **twice** (re-run rules out flakes) → posts a Slack alert to `C0B307LP274` (via the tester bot token) **and** `agents send agenta "ONCALL: …"` to wake this agent.
- **Remediation is agent-driven, not script-driven** (deliberate — a blind restart on a transient model blip is harmful and wouldn't fix an upstream outage). When woken, diagnose with [[canary]] + the debug-thread skill, apply at most ONE bounded safe action, re-verify, post outcome. Never unattended redeploy/scale/destroy/secret changes — escalate to Elad. NOTE the old Fly remediation (`flyctl machine restart -a agenta-bot`) is moot now — that app is gone; only the ECS path (`aws ecs update-service --force-new-deployment`) could apply, and only once acme is back.

**Why:** Cloud health checks and (the now-removed) CD canary only caught process/deploy failures; the watchdog was the only thing exercising Slack→model→sandbox→cleanup continuously (catches silent-deaf #27, model-gateway, sandbox breakage).

**How to apply:** If I ever receive an "ONCALL: … canary failed twice" message, it's from this watchdog — follow that briefing. To re-arm or change cadence, re-run `install.sh` / edit the crontab + `~/.local/bin/canary-monitor.sh`. Keep its deps in install.sh ([[keep-install-sh-current]]). See also [[watchdog-pause-when-creds-broken]] and [[canary-must-pin-target-user-id]].
