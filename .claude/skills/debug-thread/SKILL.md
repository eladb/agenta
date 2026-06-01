---
name: debug-thread
description: Inspect the persisted state of an agenta thread on the production bot to debug "why didn't the bot do X" questions. Use when the user shares a Slack permalink (`https://*.slack.com/archives/<channel>/p<ts>?thread_ts=<thread_ts>...`) and asks about bot behavior — missing reply, unexpected tool call, stuck turn. Reads the JSONL + session.json directly off the bot's volume — `flyctl ssh` for Fly-hosted bots (agenta) or `aws ecs execute-command` for ECS-hosted bots (salto) — a more complete record than Slack itself.
---

# debug-thread

Goal: answer "what did the bot see / do in this thread?" by reading the bot's authoritative on-disk record. Faster and more accurate than reconstructing from Slack.

## When to invoke

- User shares a Slack permalink and asks why the bot did/didn't do something.
- User reports a bug in prod and you need the bot's view of the conversation, not Slack's.
- User asks what tools were called, in what order, with what arguments — `messages.jsonl` has the exact JSON payloads.

Skip if the user just shares a permalink as context (no debug question). Don't run unprompted.

## Procedure

### 1. Parse the Slack permalink

Slack thread permalinks look like:
```
https://<workspace>.slack.com/archives/<channel_id>/p<message_ts>?thread_ts=<thread_ts>&channel=<channel_id>&message_ts=<message_ts>
```

Extract:
- `channel_id` (e.g. `C0B5L9S2Q4Q`) from the `/archives/` path or the `channel=` param
- `thread_ts` (e.g. `1779192021.055539`) from the `thread_ts=` query param. **This is the thread root timestamp**, not the message timestamp from `p<...>`.

The bot's thread key is `<channel_id>__<thread_ts_with_dot_swapped_to_underscore>`. Example:
```
channel=C0B5L9S2Q4Q  thread_ts=1779192021.055539
→ thread_key = C0B5L9S2Q4Q__1779192021_055539
```

If only one timestamp is in the URL (root message of a thread), it serves as both `thread_ts` and `message_ts`.

### 2. Find where the thread's data lives — Fly or ECS?

Two production bots run in the `agentalabs` workspace on **different clouds with separate data planes**, so figure out which serves the channel before reaching for a volume:

- Check `config/homes.json` for the `channel_id`. A channel whose home has a **Bedrock model** (`base_url: bedrock://…`) and/or a `salto-*` `remote` is the **salto** bot on **ECS** (AWS account `271443695230`, `us-east-1`, ECS cluster + CFN stack `agenta-bot`). The `default` entry / `agenta-test-home` channels are the **agenta** bot on **Fly** (app `agenta-bot`).
- Rule of thumb: salto → ECS; agenta/dev → Fly. When unsure, try one and an empty result means try the other.

The thread key and on-disk layout are **identical** on both — only the access method differs. `AGENTA_DATA_DIR` is `/data/agenta/`; don't look at `/data/` itself (only `agenta/`, `botspace/`, `homes/`, `lost+found/` are there). Use `tail -<N>` not `cat` for `messages.jsonl` — it can be 100+ KB. Start with 20, increase as needed.

#### 2a. Fly-hosted bot (agenta)

```sh
flyctl ssh console -a agenta-bot -C 'sh -c "cd /data/agenta/<thread_key> && ls -la && echo ===SESSION=== && cat session.json && echo ===EVENTS=== && tail -<N> messages.jsonl"'
```
- `-C 'sh -c "..."'` is required — `flyctl ssh -C` runs the string as argv, not a shell line, so you need a real `sh -c` wrapper to chain commands with `;` / `&&` / `>` / `cat`.
- If the dir doesn't exist, the thread was `/delete`d or never seen: `ls /data/agenta | grep <channel_id>`.

#### 2b. ECS-hosted bot (salto)

Data is on the EFS volume mounted at `/data` inside the running Fargate task. AWS creds live in this host's `.env`; `bun`-run scripts auto-load it, but a bare `aws` shell needs them exported first:
```sh
set -a; eval "$(grep -E '^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|REGION)=' .env)"; set +a
```

The clean equivalent of `flyctl ssh` is `aws ecs execute-command`:
```sh
TASK=$(aws ecs list-tasks --cluster agenta-bot --service-name agenta-bot --query 'taskArns[0]' --output text)
aws ecs execute-command --cluster agenta-bot --task "$TASK" --container bot --interactive \
  --command "sh -c 'cd /data/agenta/<thread_key> && ls -la && cat session.json && tail -<N> messages.jsonl'"
```
It needs the `session-manager-plugin` locally — install once:
```sh
curl -fsSL https://s3.amazonaws.com/session-manager-downloads/plugin/latest/ubuntu_64bit/session-manager-plugin.deb -o /tmp/smp.deb && sudo dpkg -i /tmp/smp.deb
```

ECS Exec works on the salto bot as of 2026-05-28 (#226 added the `ssmmessages:*` data-channel perms to the bot task role). One gotcha: a task assumes its role **at launch**, so if a role change is newer than the running task you'll still get `TargetNotConnected` — relaunch with `aws ecs update-service --cluster agenta-bot --service agenta-bot --force-new-deployment` (brief bot restart) so a fresh task picks up the perms. `enableExecuteCommand` on the service is also required (already set).

These read-only fallbacks remain handy when exec isn't an option (no `session-manager-plugin` to hand, a task that predates a role change, or just a quick peek) — they cover most "what happened?" questions:

- **Conversation transcript via the Slack API** (user-visible messages — not the full JSONL, but enough to see the symptom and exact error text the bot posted):
  ```sh
  TOKEN=$(aws ssm get-parameter --name /agenta-bot/SLACK_BOT_TOKEN --with-decryption --query 'Parameter.Value' --output text)
  curl -s -H "Authorization: Bearer $TOKEN" \
    "https://slack.com/api/conversations.replies?channel=<channel_id>&ts=<thread_ts>&limit=80" \
    | jq -r '.messages[] | "[\(.ts)] \(if .bot_id then "BOT" else "USER:"+(.user//"?") end): \(.text)"'
  ```
- **Bot logs via CloudWatch** (scoped log lines incl. `[gateway]` errors + tool activity):
  ```sh
  aws logs tail /ecs/agenta-bot --since 30m --format short | grep -iE "<channel_id>|error|gateway"
  ```

### 3. Read the JSONL

Each line is a JSON event with these top-level fields:
- `source`: `slack` (user messages, edits, deletes, file uploads) | `assistant` (bot reply, tool call, tool result)
- `type`: `message` | `edit` | `delete` | `tool_call` | `tool_result`
- `ts` / `ingested_at`: when the bot saw it
- `payload`: source-specific

Common debug questions and what to look for:

| Question | Where to look |
|---|---|
| Did the bot get the message? | Filter `source:"slack" type:"message"` near the timestamp. |
| Why didn't the bot reply? | After the user message, is there an `assistant` event? If not — was the user message a **mention** (`<@U…>` in text matching the bot user)? The handler only fires turns on mentions. Non-mentions are ingested but not acted on. |
| Did a tool fail? | `assistant tool_result` events — look at `payload.content` for the `exit:` line + stderr. |
| What was the system prompt? | `session.json`'s `system_prompt` field. Frozen on first mention. |
| Is the sandbox still alive? | `session.json`'s `sandbox` field. Fly: `sandbox.machine_id` → `flyctl machine status <id> -a agenta-sandbox`. ECS: the sandbox is a Fargate task in cluster `agenta-sandbox` → `aws ecs list-tasks --cluster agenta-sandbox` / `aws ecs describe-tasks --cluster agenta-sandbox --tasks <id>`. |
| Which model is in use? | `session.json`'s `model.name` if per-channel override active (#128), otherwise the global `MODEL_NAME` Fly secret. |
| Is the home repo direct-SSH or HTTPS? | `session.json`'s `home.remote` — `git@` / `ssh://` = direct, `https://` = mirror. |

### 4. Report findings

Lead with the answer ("Bot didn't reply because the user message wasn't a mention"). Cite the event timestamp(s) you base it on. Keep it tight — the user shared a link, they want a verdict, not a transcript.

If you need the bot to re-process something, the user has to act on Slack — there's no admin endpoint to "replay" a message. Common follow-up: "re-send with `@agenta <text>`".

## What NOT to do

- Don't restart, kill, stop, or scale anything during debug — `flyctl machine stop`, `aws ecs stop-task`, `update-service`. Read-only. And don't "fix" a `TargetNotConnected` by editing the live task role + rolling the bot mid-debug; that's a prod change — file a follow-up instead.
- Don't `rm` or modify files on the bot volume. The JSONL is authoritative; tampering with it confuses future turns.
- Don't tail the WHOLE `messages.jsonl` when you only need the end — it can exceed the SSH transcript budget.
- Don't try to read messages.jsonl via `flyctl logs` — those are stdout/stderr only, not persisted state.
- Don't ask the user for the channel ID + thread_ts when they pasted a permalink — parse them yourself.
