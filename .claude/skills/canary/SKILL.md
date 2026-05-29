---
name: canary
description: Run the production smoke test (chat → bash → /delete) against BOTH deploy targets — agenta on Fly and salto on ECS — to confirm the whole system is functional end-to-end. Use when the user asks "is the bot/system working?", "run the canary", "smoke-test prod", "is salto/agenta up?", or after a deploy/cutover when you need a real end-to-end signal (Slack → model → sandbox bash → cleanup), not just a process/health check.
---

# canary

Goal: the highest-confidence "is the system actually functional?" check. `scripts/canary.ts` drives the **tester** bot to mention a target bot in a real channel and asserts it handles three steps — a chat reply, a bash command whose output round-trips, and `/delete` cleanup. Green means Slack delivery, the model gateway, the sandbox, bash exec, and session teardown all work together. The same codebase ships as two bots; this skill runs the canary against **both**.

## The two targets

| Target | Cloud | Slack bot | user id | pre-flight health gate |
|---|---|---|---|---|
| **agenta** | Fly (app `agenta-bot`) | `agenta` | `U0B2WQUHK6Z` | Fly Machines API — *currently skipped, see gotcha* |
| **salto** | ECS (cluster + service `agenta-bot`) | `salto` | `U0B65LMHRLL` | `aws ecs describe-services` |

Both bots live in the `agentalabs` workspace and are members of the test channel `C0B307LP274`. They are **different Slack apps** (agenta `A0B2WL8UYAZ`, salto `A0B5VLX7QUT`) → separate event streams → the canary targets each one deterministically by mentioning its user id. There is no split-brain between them.

## When to invoke

- User asks whether the system / a specific bot is working, or to run the canary / smoke test.
- After a deploy, cutover, or infra change, when you want a real end-to-end signal rather than a health check.

Skip if a health check, `git`, or CI status already answers the question — try those first. The canary posts real Slack messages and spends ~30–90s of model time per target.

## Prerequisites

- Ops tools installed and on PATH (run `./install.sh` if missing), then:
  ```sh
  export PATH="$HOME/.bun/bin:$HOME/.fly/bin:$HOME/.local/bin:$PATH"
  ```
- This host's `.env` provides the tester tokens (`TEST_APP_TOKEN`, `TEST_BOT_TOKEN`, `TEST_CHANNEL_ID`) and AWS creds. `bun`-run scripts auto-load `.env`; CLI-set env vars win (bun won't override an already-set variable), which is how the per-target overrides below take effect.

## Procedure

### agenta (Fly)

```sh
export PATH="$HOME/.bun/bin:$HOME/.fly/bin:$HOME/.local/bin:$PATH"
# FLY_API_TOKEN comes from .env (org-scoped); FLY_APP_NAME→agenta-bot so the
# Fly health gate polls the bot's machines (api.machines.dev) before firing.
FLY_APP_NAME=agenta-bot AGENTA_DEPLOY_TARGET=fly \
  CANARY_TARGET_USER_ID=U0B2WQUHK6Z \
  bun scripts/canary.ts
```

`CANARY_TARGET_USER_ID=U0B2WQUHK6Z` is also the `.env` default, but set it explicitly so the two runs read symmetrically.

### salto (ECS)

```sh
export PATH="$HOME/.bun/bin:$HOME/.fly/bin:$HOME/.local/bin:$PATH"
set -a; eval "$(grep -E '^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|REGION)=' .env)"; set +a
AGENTA_DEPLOY_TARGET=ecs AGENTA_ECS_CLUSTER=agenta-bot AGENTA_ECS_SERVICE=agenta-bot \
  CANARY_TARGET_USER_ID=U0B65LMHRLL \
  bun scripts/canary.ts
```

The ECS gate polls `aws ecs describe-services` until the primary deployment is `COMPLETED` with `running==1` (no pending/failed) before firing any Slack messages.

### Read the result

Each run prints a per-step summary and exits `0` (all green) or `1` (a step failed, with the failing step on stderr). The three steps:

1. **chat reply** — a non-empty reply lands (rejects the `thinking…` placeholder and `error:` replies).
2. **bash + cat** — bot runs `echo hello-canary > ~/canary.txt && cat …` and the reply contains `hello-canary` (exercises the sandbox).
3. **/delete cleanup** — bot replies `deleted…`.

Report per target: ✅/❌ each, plus the failing step + stderr message if red.

## Gotchas

- **The Fly health gate needs an org-scoped token.** `.env`'s `FLY_API_TOKEN` is org-scoped (2026-05-29) so `waitForFlyHealth` can read `agenta-bot`'s machines on `api.machines.dev`. If it ever 403s again, the token has been narrowed back to an app-scoped (`agenta-sandbox`) deploy token — mint a new org token (`fly tokens create org`) and put it in `.env`. The watchdog still overrides `FLY_APP_NAME=agenta-bot` per-run (the `.env` default is `agenta-sandbox` for the sandbox provider).
- **Both bots must be members of `C0B307LP274`.** The tester lacks `channels:read`, so you can't list membership directly; recent posts from a bot's user id in `conversations.history` are good evidence it's a member. If a target isn't in the channel, step 1 just times out (~60s) with no reply.
- **Step 3's host-side cleanup check is vacuous when run remotely.** `canary.ts` verifies the thread's data dir is gone on the *canary host*, but a Fly/ECS bot writes that dir on its own volume — so the dir never exists locally and the check passes trivially. A green step 3 proves the bot replied `deleted`, not that its volume was cleaned.
- **It posts real messages and exercises the live bots.** Fine for `C0B307LP274` (the dedicated test channel) — never point `TEST_CHANNEL_ID` at a human-facing channel.

## What NOT to do

- Don't run against a prod *conversation* channel — keep it in the test channel.
- Don't paste a broader Fly token into a committed file to "fix" the 403 — tokens belong in `.env` / secrets.
- Don't restart or scale Fly/ECS to make a red canary pass. If a target fails, debug it (see the `debug-thread` skill) instead of papering over it.
