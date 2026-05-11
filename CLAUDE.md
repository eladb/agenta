# agenta — Claude collaboration notes

This file is your context for a new session. Read it in full before starting work.

## How to work with this user (Elad)

- **Functional TypeScript only.** No classes anywhere in `src/` or tests. Using class APIs from third-party packages (`SocketModeClient`, `WebClient`) is fine — we just don't author them.
- Keep things simple. **No redundant abstractions.** Prefer plain functions and callbacks. Reach for an `EventEmitter` only when there's a real one-to-many pattern.
- Don't introduce interfaces / "provider" types unless a second concrete implementation actually exists. Single implementation = single concrete function.
- **Stop and ask before non-trivial decisions or implementing.** Surface forks via `AskUserQuestion` (library choice, module layout, scope of the next phase, persistence strategy, etc.) and confirm direction before writing code. Don't bundle "while I'm here" cleanup or scope expansion.
- Honest is better than enthusiastic. When something is hard or impossible (Slack reCAPTCHA, App-Level token API gap, Anthropic image size limits), say so plainly and offer the realistic options instead of grinding.

## Project: agenta

Implementation of `SPEC.md` (v1) in this repo — a Slack thread-backed agentic sandbox bot. Greenfield; **do not copy code from `~/agents`** (an earlier scratch repo) without asking.

### Stack (locked in)

- **Runtime / package manager:** Bun 1.3.x. Default test runner is `bun test`. Bun loads `.env` automatically.
- **Slack SDK:** `@slack/socket-mode` + `@slack/web-api` (not Bolt). Explicit event routing in `src/slack/events.ts`.
- **Model gateway:** Anthropic via the **OpenAI-compatible endpoint** (`https://api.anthropic.com/v1/chat/completions`). Wire format is OpenAI; auth is `Authorization: Bearer $ANTHROPIC_API_KEY`. Default model: `claude-sonnet-4-6`. Plain `fetch`, no SDK.
- **MIME detection:** `file-type` npm package, magic-byte based. Never trust filename or Slack-reported `mimetype`.
- **Lint/format:** `biome` (single tool, `biome.json`). Tests: `bun:test` co-located with src under `src/`; e2e tests in `tests/e2e/`.

## Implementation state (current)

Phases completed (in order):

1. **Slack adapter (thin)** — Socket Mode connect, event normalization, dedupe, command parsing (`/stop`, `/delete`), `thread_key`, basic checklist UI (post `thinking…` then edit).
2. **Persistence + attachments + real `/delete`** — JSONL event store, ingest mentions + non-mention thread messages + edits + deletes, eager attachment download, `/delete` rm's the thread dir. Backfill on first mention only.
3. **Model gateway + agent loop** — pluggable `CallModel` function, per-thread mutex, `runTurn` wraps post → edit → callModel → edit → record-assistant. Replaces the echo flow.
3.x **Attachments → model** — byte-based MIME detection, multipart `content` in OpenAI-compat messages: images + PDFs as `image_url` data URIs, text inlined with 20KB cap, anything else as a `[attached: name (mime) — not passed to model]` placeholder. JSONL stays clean (metadata + `local_path` only; base64 is in-memory only at model-call time).

### Not yet implemented (deferred from spec)

- **Session state machine** (`idle` / `running` / `stopping` / `deleting`, mention batching during a run, real `/stop` cancellation, runtime.json checkpoint, restart recovery). `/stop` currently posts `stopped (stub)` and no-ops; the in-thread mutex is the only concurrency control.
- **Sandbox** (Docker per session, mTLS bot↔sandbox API, kernel-enforced egress block, SSH bash/fs tools). Nothing started.
- **Context window trimming** (spec §11: 50% sliding window, atomic tool-block trim). Currently we send the full history. No tokenizer.
- **Edits/deletes projected into model context.** Persisted in JSONL but not flattened into the messages array.
- **Tool calls** (function calling / tool use). Once added, will need atomic-trim and `causal_parent_ids` linkage.

## Repo layout

```
src/
  index.ts                 entry: env → connect → listen → handler
  log.ts                   tiny console logger with scope + level
  slack/
    connect.ts             SocketModeClient + WebClient + auth.test
    events.ts              message → IncomingEvent (message | edit | delete); filters agent's own user_id; allows file_share + thread_broadcast subtypes
    post.ts                postInThread, editMessage
  runtime/
    handler.ts             dedupe → persist → backfill-if-first-mention → command or runTurn under withLock
    commands.ts            parseCommand: exact "/stop" or "/delete" only
    dedupe.ts              dedupeKey + createDedupe (LRU-ish set, eventId first)
    thread.ts              threadKey: `${channel}__${ts.replace(/\./g,'_')}`
    mutex.ts               withLock(key, fn): chained-promise queue per key
    redact.ts              best-effort secret scrubber for error messages
    turn.ts                runTurn: post checklist → buildMessages → callModel → edit final → record assistant
  persistence/
    store.ts               data/{thread_key}/messages.jsonl + attachments/; AGENTA_DATA_DIR env override
    events.ts              discriminated AgentaEvent union (slack/assistant × message/edit/delete) + record()
    mime.ts                detectMime(buf): file-type first, UTF-8 plaintext fallback, else octet-stream
    attachments.ts         downloadFiles via url_private_download with bot token; overrides Slack mime; deleteAttachmentsForSlackTs
    backfill.ts            on new thread + mention: conversations.replies → record each, excluding the triggering ts
  model/
    gateway.ts             createCallModel: fetch /chat/completions, Bearer auth. Message.content is `string | ContentPart[]` (TextPart | ImageUrlPart)
    context.ts             buildMessages: JSONL → OpenAI messages. files → image_url (images/PDF) | text (text/*, json/xml/yaml) | placeholder
scripts/
  setup-slack-apps.ts      interactive creator via apps.manifest.create (needs config tokens)
  manual-test-image.ts     quick uploader for the agent: posts a PNG with a mention via the tester
slack-manifests/
  agent.json               scopes: app_mentions:read, chat:write, channels:history, files:read; events: message.channels
  tester.json              scopes: app_mentions:read, chat:write, channels:history, files:write; events: message.channels
tests/e2e/
  helpers.ts               startAgent (in-process), startTester, mention, uploadFile, waitForReply (polls conversations.replies w/ thread_not_found tolerance), waitFor (predicate), stubCalls/recordingStub, cleanup
  fixtures.ts              inline PNG/PDF/text/binary byte fixtures
  echo.test.ts, commands.test.ts, persistence.test.ts, edits.test.ts, attachments.test.ts
```

## Key invariants / gotchas

- **JSONL never contains base64.** `payload.files[].local_path` is the only attachment reference. Base64 is created in memory by `context.ts:fileToContentPart` per model call, by reading from disk. If you ever change this, add a regression test.
- **MIME comes from bytes, not extensions or Slack metadata.** `attachments.ts:downloadFiles` runs `detectMime(buf)` after every download and overwrites whatever Slack reported. This is a hard product requirement.
- **The tester is also a bot.** Slack events from the tester have `event.bot_id` set. Do NOT filter `if (event.bot_id) return null` — that drops the tester's mentions. Filter only `event.user === agent.botUserId`.
- **Slack file uploads come as `subtype: "file_share"`.** Our `normalize()` whitelists `undefined | file_share | thread_broadcast`; anything else (joins, leaves, pins, channel topic changes…) is dropped.
- **Backfill excludes the triggering message** by `slack_ts`. The main handler records the triggering message itself after backfill — without `excludeSlackTs`, we'd double-record.
- **`waitForReply` swallows `thread_not_found`.** Slack doesn't materialize a thread record until the parent gets its first reply. Polling before the bot has replied throws `thread_not_found`; we just keep polling.
- **Anthropic images have a minimum size** (~8×8 px). A 1×1 PNG is rejected with `Could not process image`. Use fixtures from `tests/e2e/fixtures.ts` for tests; for ad-hoc manual tests, use real images.
- **App-Level (`xapp-`) tokens** are UI-only — no Slack API can generate them. The setup script handles bot tokens via OAuth install but pauses for the user to click "Generate Token and Scopes" for the App-Level token.
- **`gh repo create agenta` already exists** on account `eladb`. The repo is private. Don't try to create it again — push to the existing remote.

## Slack apps + IDs (workspace `agentalabs` / T0B304AJPUZ)

- Agent app: **A0B2WL8UYAZ** (bot user `U0B2WQUHK6Z`, display name `agenta`)
- Tester app: **A0B33L7CVRA** (bot user used by e2e tests, `agenta-tester`)
- Test channel: `C0B307LP274`
- Both bots must be `/invite`d to the test channel

If you change scopes via `apps.manifest.update`, `permissions_updated: true` in the response means the user must reinstall the app to grant the new scope. The bot token usually stays the same across reinstalls.

## Env vars

Runtime (required for `bun start`):
- `SLACK_APP_TOKEN` (xapp-) — agent Socket Mode
- `SLACK_BOT_TOKEN` (xoxb-) — agent bot
- `ANTHROPIC_API_KEY` (sk-ant-)

E2E (required for `bun run e2e`):
- All runtime vars (the test starts the agent in-process)
- `TEST_APP_TOKEN`, `TEST_BOT_TOKEN`, `TEST_CHANNEL_ID`

Optional:
- `AGENTA_DATA_DIR` — overrides `./data` (tests use a mkdtemp dir)
- `MODEL_NAME` — defaults to `claude-sonnet-4-6`
- `MODEL_BASE_URL` — defaults to `https://api.anthropic.com/v1`
- `SYSTEM_PROMPT` — has a sensible default

For the setup script only (rotates every 12h):
- `SLACK_CONFIG_ACCESS_TOKEN`, `SLACK_CONFIG_REFRESH_TOKEN`

`.env` is gitignored. `.slack-apps.json` (app-id cache used by the setup script) is also gitignored.

## Running things

```sh
bun install
bun run test     # unit tests in src/
bun run e2e      # e2e tests in tests/e2e/ (needs both Slack apps + Anthropic key not required since stubbed)
bun start        # production agent
bun run lint     # biome check
bun run format   # biome format --write
bun run setup    # interactive Slack app creation
```

## Test design — important to understand

- **Unit tests** live next to source as `*.test.ts` under `src/`. They never touch Slack/Anthropic; `attachments.test.ts` and `gateway.test.ts` stub `globalThis.fetch`.
- **E2E tests** in `tests/e2e/` start a real agent in-process against the real Slack workspace. Each test file spins up its own agent + tester sockets in `beforeAll`. Slack mutations are cleaned up in `afterAll` (deletes the thread messages it created).
- **The model is stubbed in e2e.** `helpers.ts:stubCallModel` records every `messages` array into `stubCalls[]` and returns `stub: <last user text>` (or `(multipart)` for attachment messages). Tests assert on both the JSONL state and the recorded stub-call shape. Use `resetStubCalls()` in `beforeEach`.
- **There is no e2e test against the real model.** It would cost tokens per run and be flaky. If you ever need one, gate it behind an env flag and exclude it from the default `bun run e2e`.
- **5s default test timeout is too tight.** `package.json` sets `--timeout 30000` for e2e because the model call + backfill round-trip easily exceeds 5s.

## Git / GitHub

- Repo: `git@github.com:eladb/agenta.git` (private, on account `eladb`).
- Default branch: `main`. Commits use a `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` trailer.
- Never push without being asked.
- Never amend / force-push.

## Open questions for the next session

- Which phase to do next: state machine, sandbox, or model context-window trimming. Spec is independent on all three; user picked model+attachments last, so most likely next is state machine or sandbox.
- The dedupe is in-process only; on restart, we re-process events Slack replays. Will need persistence-backed dedupe with the state machine.
- `runtime.json` checkpoint file is not yet written. The state machine phase will introduce it.
