---
name: canary-monitoring-setup
description: "A 30-min cron watchdog runs the double canary and wakes the agenta agent (oncall) on confirmed red. Host-local, not in the repo."
metadata: 
  node_type: memory
  type: project
  originSessionId: 73f0e26f-a9df-459f-a065-da90c831bf52
---

There is a continuous prod watchdog on the claude-agents host (set up 2026-05-28). It is **not in the repo** — a future session won't find it by reading code.

- **Cron** (agenta user crontab): `*/30 * * * *` → `/home/agenta/canary-monitor.sh`.
- **`canary-monitor.sh`** is an *untracked* host file (kept out of git on purpose so it survives branch switches; the reusable recipe is the `canary` repo skill). It runs `scripts/canary.ts` against both bots — agenta/Fly (`U0B2WQUHK6Z`) and salto/ECS (`U0B65LMHRLL`). Green → quiet, appends to `~/canary-monitor.log`. Red **twice** (re-run rules out flakes) → posts a Slack alert to `C0B307LP274` (via the tester bot token) **and** `agents send agenta "ONCALL: …"` to wake this agent.
- **Remediation is agent-driven, not script-driven** (deliberate — a blind restart on a transient model blip is harmful and wouldn't fix an upstream outage). When woken, diagnose with [[canary]] + the debug-thread skill, apply at most ONE bounded safe action (Fly: `flyctl machine restart <id> -a agenta-bot`; ECS: `aws ecs update-service --cluster agenta-bot --service agenta-bot --force-new-deployment`), re-verify, post outcome. Never unattended redeploy/scale/destroy/secret changes — escalate to Elad.

**Why:** Fly/ECS health checks and the CD canary only catch process/deploy failures; this is the only thing exercising Slack→model→sandbox→cleanup continuously (catches silent-deaf #27, model-gateway, sandbox breakage).

**How to apply:** If I receive an "ONCALL: … canary failed twice" message, it's from this watchdog — follow that briefing. To change cadence or behavior, edit the crontab (`crontab -e`) and `/home/agenta/canary-monitor.sh`. Keep its deps in install.sh ([[keep-install-sh-current]]).
