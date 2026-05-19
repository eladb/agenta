---
name: debug-thread
description: Inspect the persisted state of an agenta thread on the production bot to debug "why didn't the bot do X" questions. Use when the user shares a Slack permalink (`https://*.slack.com/archives/<channel>/p<ts>?thread_ts=<thread_ts>...`) and asks about bot behavior — missing reply, unexpected tool call, stuck turn. Reads the JSONL + session.json directly off the Fly volume via `flyctl ssh`, which is a more complete record than Slack itself.
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

### 2. SSH in and read the state

```sh
flyctl ssh console -a agenta-bot -C 'sh -c "cd /data/agenta/<thread_key> && ls -la && echo ===SESSION=== && cat session.json && echo ===EVENTS=== && tail -<N> messages.jsonl"'
```

Notes on the path:
- Production `AGENTA_DATA_DIR` is `/data/agenta/`. Don't look at `/data/` — only `agenta/`, `botspace/`, `homes/`, `lost+found/` are there.
- If the dir doesn't exist, the thread was either `/delete`d or never seen. Confirm by listing: `ls /data/agenta | grep <channel_id>`.
- `-C 'sh -c "..."'` is required — `flyctl ssh -C` runs the string as argv, not a shell line, so you need a real `sh -c` wrapper to chain commands with `;` / `&&` / `>` / `cat`.

Use `tail -<N>` not `cat` for `messages.jsonl` — it can be large (100+ KB for a long thread). Start with 20, increase if needed.

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
| Is the sandbox still alive? | `session.json`'s `sandbox.machine_id` — then `flyctl machine status <id> -a agenta-sandbox`. |
| Which model is in use? | `session.json`'s `model.name` if per-channel override active (#128), otherwise the global `MODEL_NAME` Fly secret. |
| Is the home repo direct-SSH or HTTPS? | `session.json`'s `home.remote` — `git@` / `ssh://` = direct, `https://` = mirror. |

### 4. Report findings

Lead with the answer ("Bot didn't reply because the user message wasn't a mention"). Cite the event timestamp(s) you base it on. Keep it tight — the user shared a link, they want a verdict, not a transcript.

If you need the bot to re-process something, the user has to act on Slack — there's no admin endpoint to "replay" a message. Common follow-up: "re-send with `@agenta <text>`".

## What NOT to do

- Don't restart, kill, or `flyctl machine stop` anything during debug. Read-only.
- Don't `rm` or modify files on the bot volume. The JSONL is authoritative; tampering with it confuses future turns.
- Don't tail the WHOLE `messages.jsonl` when you only need the end — it can exceed the SSH transcript budget.
- Don't try to read messages.jsonl via `flyctl logs` — those are stdout/stderr only, not persisted state.
- Don't ask the user for the channel ID + thread_ts when they pasted a permalink — parse them yourself.
