---
name: canary-must-pin-target-user-id
description: "Always pin CANARY_TARGET_USER_ID per canary step; falling back to auth.test on a shared SLACK_BOT_TOKEN secret silently routes every canary to one bot, masking real coverage."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2c39036d-3357-4679-8941-5e865798a190
---

`scripts/canary.ts:204` resolves the bot the tester mentions in two ways: explicit `CANARY_TARGET_USER_ID`, else `auth.test(SLACK_BOT_TOKEN)`. With a single repo-level `secrets.SLACK_BOT_TOKEN` shared across multiple canary steps, the auth.test fallback resolves to the SAME bot for every step — every canary tests THAT bot's reply path, in whatever channel each step happens to use.

**Why:** Pre-#260 `cd.yml` had this exact bug. `secrets.SLACK_BOT_TOKEN` resolved to the acme bot (U0B65LMHRLL), so the "Canary (production)" Fly step tested acme's reply path in `CANARY_CHANNEL_ID` instead of agenta's, and the "Canary (acme / ECS)" step tested acme's reply path in `ACME_CANARY_CHANNEL_ID`. Both gates rode on acme's health. An agenta-only regression couldn't have been caught here; a acme outage looked like an agenta canary fail (mis-paged for two hours on 2026-05-31). Fixed in PR #260 by pinning per step.

**How to apply:** Any new canary step or migrated deployment must set `CANARY_TARGET_USER_ID` explicitly. `canary-monitor.sh` (host-local watchdog) and `cd.yml` both now do this — the pattern: `CANARY_TARGET_USER_ID: U0B2WQUHK6Z` for agenta, `U0B65LMHRLL` for acme. If you see canary logs print `agent user = <unexpected_user>; channel = ***`, the wrong secret is wiring it. The `SLACK_BOT_TOKEN` env var is now unused on those steps and can be dropped entirely.
