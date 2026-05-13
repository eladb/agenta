# agenta — Claude collaboration notes

This file is your context for a new session. Read it in full before starting work.

## How to work with this user (Elad)

- **Functional TypeScript only.** No classes anywhere in `src/` or tests. Using class APIs from third-party packages (`SocketModeClient`, `WebClient`) is fine — we just don't author them.
- Keep things simple. **No redundant abstractions.** Prefer plain functions and callbacks. Reach for an `EventEmitter` only when there's a real one-to-many pattern.
- Don't introduce interfaces / "provider" types unless a second concrete implementation actually exists. Single implementation = single concrete function.
- **Stop and ask before non-trivial decisions or implementing.** Surface forks via `AskUserQuestion` (library choice, module layout, scope of the next phase, persistence strategy, etc.) and confirm direction before writing code. Don't bundle "while I'm here" cleanup or scope expansion.
- Honest is better than enthusiastic. When something is hard or impossible (Slack reCAPTCHA, App-Level token API gap, Anthropic image size limits), say so plainly and offer the realistic options instead of grinding.
- **Never instruct manual Slack UI operations.** All app-configuration changes (scopes, event subscriptions, interactivity, etc.) must go through `apps.manifest.update` so the manifest file in this repo stays the single source of truth. If the `SLACK_CONFIG_ACCESS_TOKEN` is expired or missing, ask the user to generate a fresh one — don't fall back to "go to the UI and toggle this."

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

1. **Slack adapter (thin)** — Socket Mode connect, event normalization, dedupe, command parsing (`/stop`, `/delete`), `thread_key`, ephemeral `• thinking…` checklist UI.
2. **Persistence + attachments + real `/delete`** — JSONL event store under `data/{thread_key}/`, ingest mentions + non-mention thread messages + edits + deletes, eager attachment download, `/delete` rm's the thread dir + sandbox container. Backfill on first mention only.
3. **Model gateway + agent loop** — pluggable `CallModel` against any OpenAI-compatible endpoint, `runTurn` posts checklist → buildMessages → callModel → tools loop → final reply.
3.x **Attachments → model** — byte-based MIME detection, multipart `content` in OpenAI-compat messages.
4. **Session state machine** — per-thread `idle`/`running`/`stopping`, real `/stop` via `AbortController`, mention batching during a turn (queues, runs one extra turn after current). `session.json` checkpoint per thread; on boot, `recoverInterruptedSessions(web)` posts an "agent restarted" notice and clears the entry.
5. **Tool calling** — multi-iteration loop. Built-in tools registered in `src/model/tools/` (one file per tool). Tool events (`tool_call`, `tool_result`) recorded to JSONL; `context.ts` reattaches them on reconstruction. Includes orphan-tool_call guard (synthetic stub if no result was persisted).
6. **Sandbox** — Docker container per thread (image `agenta-sandbox:latest`, built from `sandbox/Dockerfile`). All bot↔sandbox traffic goes through an in-container **Bun HTTP server** (`sandbox/server/server.ts`, compiled to a static binary) over a random `127.0.0.1:<port>` with a per-container Bearer token. Endpoints: `/exec` (SSE-streamed bash), `/read`, `/write`, `/edit`, `/grep`, `/glob`, `/ls`, `/health`. Hardening: runs as **uid 1000 `sandbox`**, `--cap-drop ALL` + `--cap-add NET_ADMIN/SETUID/SETGID/SETPCAP` (entrypoint uses them then `setpriv`s them away), `--security-opt no-new-privileges`, `--pids-limit 256`, `--memory 1g`, `--cpus 1.0`, egress blocked via in-container iptables OUTPUT rules. Per-thread anonymous volume at `/workspace`.
7. **Live-streamed bash** — `consumeExecStream` fires `onChunk` per SSE event; `runTurn` shows a debounced (800ms) live preview line under the bash bullet, replaces it with a one-line `→ exit: N` summary on completion.
8. **Interactive Slack asks** — `ask_user` tool posts block-kit messages (buttons / static_select / multi_static_select / text-via-thread-reply). The tool's `invoke()` registers a deferred in `src/runtime/asks.ts` and awaits. `src/slack/interactive.ts` dispatches `block_actions` payloads to the registry. 10-min timeout, `/stop`-cancellable, text reply in the same thread auto-resolves the ask. The ask blocks render *on* the checklist message (chat.update with blocks) rather than as a separate post — keeps the thread chronologically coherent. Settled answer is appended inline to the ask bullet (`• ask_user (buttons): pick db → postgres`).
9. **`share_file` tool** — uploads a file from the sandbox to the Slack thread via `files.uploadV2`. Bytes are read from the sandbox over `/read_binary` (new server endpoint; base64 over HTTP), MIME detected from bytes, persisted locally under `data/{thread_key}/attachments/{file_id}-{name}`, and recorded as an `assistant message` event with `files` payload mirroring the user-attachment shape. Tool_result intentionally omits the permalink and the upload uses no `initial_comment` — the model's final reply is the only place prose lives, which removes a class of duplicate-message UX bugs. System prompt has a "File handling rules (strict)" block enforcing this for smaller models.
10. **Sandbox provider abstraction + Fly Machines provider** — `src/sandbox/provider.ts` defines `SandboxProvider { ensure, getEndpoint, remove, killAll, isReady }`. `src/sandbox/docker.ts` and `src/sandbox/fly.ts` implement it. `src/sandbox/index.ts` selects via `SANDBOX_PROVIDER=docker|fly` and exports the unified HTTP client (runBash/readFile/…). The Fly provider creates a per-thread Firecracker VM via the Machines REST API, routes via `fly-force-instance-id` on the shared `<app>.fly.dev` URL, with a per-machine `SANDBOX_TOKEN` in env. `scripts/deploy-sandbox-fly.ts` provisions the app, allocates shared v4 + dedicated v6, and `fly deploy --build-only --push --image-label latest` so the registry tag is stable.
11. **Lazy sandbox provisioning + UI** — the sandbox is no longer created on every mention. Each `Tool` carries a `requiresSandbox?: boolean` flag; the first tool with that flag in a turn triggers `ensureContainer` if `isSandboxReady(threadKey)` is false. While provisioning is in flight the checklist gets a `• 🛠️ provisioning workspace…` line, which mutates to `• ✅ workspace ready` on success or `• ❌ workspace provisioning failed: <err>` on failure. On failure the tool gets an error tool_result synthesized in turn.ts (invoke isn't called), so the model can recover. Mentions that never use a sandbox-touching tool (chat-only, `get_current_time`, `fetch_url`, `ask_user`) skip provisioning entirely.
12. **Inbound attachments → sandbox** — user-uploaded files are mirrored into `/workspace/attachments/<file_id>-<safeName>` so the model can `read_file`/`bash` over them. Sync is lazy (runs after `ensureContainer` on the first sandbox-touching tool of a turn) and idempotent via a per-thread `Map<threadKey, Set<basename>>` in `src/sandbox/index.ts` (cleared on `removeContainer`/`killAllSandboxContainers`). The sandbox server exposes `POST /write_binary` (`{ path, content_b64 }`) for the upload. `buildMessages` also appends `[attached: attachments/<file_id>-<safeName>]` to the user message text so non-vision models see the path hint.
13. **Skills + botspace + per-thread frozen prompt** — the system prompt is no longer a const in `src/index.ts`. It lives in `sandbox/botspace/`: `README.md` for identity/rules + `skills/<slug>/SKILL.md` files with YAML frontmatter (`name`, `description`, anything else flows through verbatim). `src/prompt.ts:buildSystemPrompt` walks the dir, parses frontmatter (malformed = warn + skip, never crash), and composes `<SYSTEM_PROMPT env prefix?>\n\n<README.md>\n\n# Available skills\n…\n<JSON array, sorted by path>` (the skills section is omitted entirely when there are zero skills). The whole `sandbox/botspace/` tree is `COPY --chown=sandbox:sandbox`'d into `/workspace/` at image-build time so a fresh sandbox starts with README.md + skills/* in place; the model loads a skill by `read_file('skills/<slug>/SKILL.md')`. The composed prompt is **frozen per thread**: `session.json` schema now persists `{status, updated_at, system_prompt?}` with `status: 'idle' | 'running' | 'stopping'`, `handler.ts` composes on the first mention and writes it into the file, and every subsequent turn in that thread reads `system_prompt` back from session.json. `clearSession` rewrites the file as idle (preserving the prompt) instead of deleting it; only `/delete` removes the thread dir. `recoverInterruptedSessions` filters on status !== 'idle' so we don't re-announce on every boot. `SYSTEM_PROMPT` env var semantics changed: it **prepends** to README.md (used to **replace** the default).

### Not yet implemented (deferred from spec)

- **Edits/deletes projected into model context.** Persisted in JSONL but not flattened into the messages array. Spec §11.
- **Context window trimming** (spec §11: 50% sliding window, atomic tool-block trim). We send the full history. Starts mattering once tool loops produce long histories.
- **Persisted dedupe + pending-mention queue** across restarts. In-memory only; Slack redelivery on bot restart can re-process events.

### Known issues / gotchas worth knowing about

- **Egress block ineffective on Fly.** The entrypoint's iptables rules allow `172.16.0.0/12` because the local-Docker setup needs to reach the bridge gateway. On Fly the machine's outbound default route is *also* a 172.x address (Fly's overlay gateway), which then forwards to the public internet. So the same rule that's correct for Docker is wide-open on Fly. Verified live (`curl https://example.com` from inside a Fly sandbox succeeds). Fix idea: detect the directly-connected subnet at entrypoint time and allow only that CIDR, not the whole RFC1918 block. Local-Docker egress block is still working correctly.
- **Fly trial machines auto-stop at 5 min** ("Trial machine stopping. To run for longer than 5m0s, add a credit card." in `flyctl logs`). Long-lived turns / threads will get killed mid-flight. Add a payment method on the Fly account to remove the cap.
- **Fly host-side DNS hostility.** On networks that block outbound port 53 to public resolvers AND the local resolver mishandles `<app>.fly.dev` (Elad's home network does both: router returns AAAA-only, ISP blocks port 53 to 8.8.8.8/1.1.1.1), Bun's `fetch` can't resolve the Fly host. Workarounds we've used:
  - `/etc/hosts` line: `66.241.125.131 agenta-sandbox.fly.dev` (added on Elad's Mac during this session).
  - Encrypted DNS profile on macOS (cleaner; uses DoH over 443).
  - **Better long-term fix:** implement DoH-based resolution inside `flyProvider` so the bot is independent of the host's resolver. Sketch in `runBash`/`postJson`: resolve via `https://cloudflare-dns.com/dns-query`, open the TLS socket to the resolved IP with SNI = original hostname. Would need Node's `https.request` with custom `lookup` since Bun's `fetch` has no DNS hook.
- **Host port not cached on Docker.** Docker Desktop auto-restarts containers when their main process exits and reassigns the host port. `dockerProvider.getEndpoint` re-reads via `docker port` on every call (~50ms). Fly doesn't have this quirk.
- **share_file files aren't reprojected to the model on later turns.** OpenAI/Anthropic compat doesn't allow image content on `assistant` role. The bytes are archived in `data/{thread_key}/attachments/` and the metadata is in the JSONL `assistant message.files` payload, but `buildMessages` doesn't emit them as multipart `user` content. If we want the model to "see" what it sent later, that's a synthetic-user-message hack.

### Session continuity checklist for a fresh Claude session

When you start a new session on this repo:

1. Read this file in full (you're doing that now).
2. Skim recent commits: `git log -20 --oneline` to see what's actually merged vs. what this doc claims.
3. Glance at open issues above — the Fly egress and DNS items are the most likely things the user will want to revisit.
4. If the user asks "what's next?", the open phases are: edits/deletes into context (smallest), context-window trimming, persisted dedupe + queue, and Fly-side egress block. There may also be UX iteration on existing tools.

## Repo layout

```
src/
  index.ts                 entry: env → killAllSandboxContainers → connect → recoverInterruptedSessions → listen
  log.ts                   tiny console logger with scope + level
  prompt.ts                buildSystemPrompt(botspaceDir?, envPrefix?): walks `sandbox/botspace/` to compose [env prefix] + README.md + "Available skills" + JSON array (sorted by path). Pure, no Slack/sandbox deps. Skills with bad frontmatter are warn-and-skipped.
  slack/
    connect.ts             SocketModeClient + WebClient + auth.test
    events.ts              message → IncomingEvent (message | edit | delete)
    post.ts                postInThread, editMessage, postBlocksInThread, editBlocksMessage
    interactive.ts         listenInteractive — dispatches block_actions to asks registry
    ask-blocks.ts          block-kit builders for the ask_user tool (buttons/select/multi_select/text)
  runtime/
    handler.ts             dedupe → text-override resolveByThreadText → persist → backfill-if-first → command or startOrQueue
    commands.ts            parseCommand: exact "/stop" or "/delete" only
    dedupe.ts              dedupeKey + createDedupe (LRU-ish set, eventId first)
    thread.ts              threadKey + decodeThreadKey (inverse, for recovery)
    redact.ts              best-effort secret scrubber for error messages
    session.ts             per-thread state machine (idle / running / stopping); writes session.json on transitions
    session-store.ts       atomic temp+rename session.json per thread; schema {status, updated_at, system_prompt?}; clearSession now rewrites idle (preserving system_prompt), only /delete removes the file
    recovery.ts            recoverInterruptedSessions: on boot, post "agent restarted" notice + clear stale session.json
    asks.ts                pending ask_user registry; at most one per thread; resolveByThreadText for text-override
    turn.ts                runTurn: ephemeral thinking… → callModel → tool loop with live bash preview → final reply
  persistence/
    store.ts               data/{thread_key}/{messages.jsonl, attachments/, session.json}; AGENTA_DATA_DIR override
    events.ts              AgentaEvent union (slack × {message,edit,delete}; assistant × {message,tool_call,tool_result}) + record()
    mime.ts                detectMime(buf): file-type first, UTF-8 plaintext fallback, else octet-stream
    attachments.ts         downloadFiles via url_private_download; mime detected from bytes; deleteAttachmentsForSlackTs
    backfill.ts            on new thread + mention: conversations.replies → record each, excluding the triggering ts
  model/
    gateway.ts             createCallModel: fetch /chat/completions; Message = system | user | assistant | tool; tool_calls in response; OpenRouter-friendly headers
    context.ts             buildMessages: JSONL → OpenAI messages; reattaches tool_calls to parent assistant; emits role:tool; synthesizes orphan-tool_call stubs
    tools/
      types.ts             Tool, ToolContext (threadKey + onProgress + web/channel/threadTs), ToolProgressChunk
      helpers.ts           truncate / oneLine / strArg
      index.ts             TOOLS registry + TOOL_DEFS + invokeTool
      get-current-time.ts  trivial UTC ISO
      fetch_url.ts         host-side HTTP GET, 8 KB cap, 10s timeout
      bash.ts              wraps runBash, formatBashResult, streams onProgress chunks
      read-file.ts         offset/limit slice, 16 KB cap
      write-file.ts        64 KB cap, auto-mkdir
      edit-file.ts         unique-match string replace (Claude Code semantics)
      grep.ts              ripgrep + line numbers
      glob.ts              ripgrep --files
      list-dir.ts          structured ls
      ask-user.ts          interactive Slack ask (buttons/select/multi_select/text) — uses asks.ts registry, renders on the checklist message itself
      share-file.ts        uploads a sandbox file to the Slack thread; records assistant message event with files payload
  sandbox/
    provider.ts            SandboxProvider interface (ensure / getEndpoint / remove / killAll) + SandboxEndpoint {baseUrl, headers}
    docker.ts              dockerProvider — local Docker container. ensureImage / ensureNetwork / dockerSpawn + lifecycle.
    fly.ts                 flyProvider — per-thread Fly machine via the Fly Machines REST API. fly-force-instance-id header routes requests to the specific machine over the shared <app>.fly.dev URL.
    index.ts               provider selector (SANDBOX_PROVIDER=docker|fly), provider-agnostic HTTP client: runBash/readFile/readBinary/writeFile/editFile/grep/glob/listDir, consumeExecStream (SSE parser). Re-exports containerName for tests.
sandbox/
  Dockerfile               multi-stage: oven/bun:1-slim builds the server binary → ubuntu:24.04 runtime + iptables/ripgrep/git/curl/jq/python3/python3-pil/matplotlib/numpy/pandas/imagemagick, sandbox user uid 1000. Also `COPY --chown=sandbox:sandbox botspace /workspace/` so README.md + skills/* ship into every container.
  botspace/                README.md + skills/<slug>/SKILL.md library. Single source of truth for the bot's prompt; copied into /workspace at image-build time and read by src/prompt.ts on first mention. Override the dir for tests via `BOTSPACE_DIR` env.
  entrypoint.sh            installs iptables OUTPUT rules (root + NET_ADMIN), then `setpriv` to sandbox user with bounding/inheritable/ambient caps wiped, then exec the server
  fly.toml                 minimal Fly app config — `app = "agenta-sandbox"` + Dockerfile pointer. No services here; the bot creates per-thread machines on demand.
  server/
    server.ts              Bun HTTP API. Endpoints (Bearer auth except /health): /exec (SSE), /read, /read_binary, /write, /edit, /grep, /glob, /ls, /health. Spawned bash inherits cwd=/workspace. 60s default exec timeout (SANDBOX_EXEC_TIMEOUT_MS).
scripts/
  setup-slack-apps.ts      interactive creator via apps.manifest.create (needs config tokens)
  deploy-sandbox-fly.ts    one-shot Fly provisioning + image push (`bun scripts/deploy-sandbox-fly.ts`)
  manual-test-image.ts     quick uploader for the agent: posts a PNG with a mention via the tester
slack-manifests/
  agent.json               scopes: app_mentions:read, chat:write, channels:history, files:read; events: message.channels; interactivity enabled
  tester.json              scopes: app_mentions:read, chat:write, channels:history, files:write; events: message.channels
tests/e2e/
  helpers.ts               startAgent (in-process), startTester, mention, uploadFile, waitForReply, waitFor, deleteThread (also removeContainer), stubCalls/recordingStub
  fixtures.ts              inline PNG/PDF/text/binary byte fixtures
  *.test.ts                echo, commands, persistence, edits, attachments, session, tools, sandbox, skills
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

### Tools layout

- **One file per tool** in `src/model/tools/<name>.ts`. Each file owns: the OpenAI tool `def`, `describe(args)` for the Slack checklist, and `invoke(args, ctx, signal)` with all arg validation + the actual implementation. Helpers shared across tools live in `helpers.ts`. Adding a new tool = create the file, export the `Tool` const, register it in `index.ts:TOOLS`.
- **Tool tests are co-located**: `<name>.test.ts` next to each tool. Registry-wide contracts (every tool has a non-throwing `describe`, names match keys, etc.) live in `_registry.test.ts`.
- **`ToolContext` is permissive on purpose** — Slack hooks (`web`, `channel`, `threadTs`) are optional so tools that don't need Slack can be unit-tested without a stub. Tools that *do* need Slack (currently only `ask_user`) throw a clear error when those fields aren't set.

### Session + recovery semantics

- **`session.json` per thread** records session state: `{status: 'idle' | 'running' | 'stopping', updated_at, system_prompt?}`. Written atomically (temp + rename) on every transition. The file lives across the thread's whole lifetime — `clearSession` rewrites it as `idle` (preserving `system_prompt`) instead of deleting; only `/delete` removes it. `signalStop` writes `stopping` **before** firing `abort.abort()` — otherwise the abort cascade lets the turn's `finally { clearSession }` race ahead and leave a stale `stopping` entry on disk.
- **Per-thread frozen prompt.** `handler.ts` composes the system prompt via `buildSystemPrompt()` on the first mention of a thread, writes it into `session.json` (status: idle), and reads it back on every subsequent turn. So README.md/skill edits don't affect already-running threads; only new threads pick up changes. `session.ts` threads the prompt through every `writeSession` call so it survives running ↔ stopping ↔ idle transitions.
- **On boot**, `recoverInterruptedSessions(web)` scans `data/*/session.json`, filters to `status === 'running' | 'stopping'`, posts an "agent restarted — previous turn was interrupted" notice per match, then clears the entry (which flips it to idle, preserving the prompt). Idle entries are skipped — we don't re-announce on every boot. Bad threadKeys and Slack errors don't abort the whole recovery; entries always clear.
- **`/delete` removes the whole thread dir** including `session.json` and the sandbox container — no special cleanup logic.

### Sandbox quirks

- **Re-read the host port every call.** Docker Desktop auto-restarts containers when the main process exits and reassigns a new random host port. `getEndpoint()` always calls `docker port`; the bot caches only the Bearer token (which survives restart in container env).
- **`--cap-drop ALL` strips `CAP_CHOWN`** even from root inside the container, so `entrypoint.sh` must NOT try to `chown /workspace`. The image creates `/workspace` owned by uid 1000 in the Dockerfile; Docker preserves that on the anonymous volume mount.
- **`setpriv` needs `SETUID + SETGID + SETPCAP`** (the last is for the bounding-set wipe). All three are also added with `--cap-add` and dropped from the bounding set after the privilege drop. Net effect: server runs as uid 1000 with `CapEff = 0000000000000000`.
- **Ubuntu 24.04 base ships with a default `ubuntu` user at uid 1000.** The Dockerfile `userdel`s it first so we can claim that uid for the sandbox user.
- **In-container egress block is in-container.** A deliberately malicious shell command could `iptables -F OUTPUT` since the container retains NET_ADMIN, but with our non-root user the shell can't reach iptables (perm denied). True defense-in-depth requires host-side `DOCKER-USER` rules — deferred.
- **The sandbox image is built lazily** by `ensureImage()`. First mention pays the build cost (~minutes); subsequent runs hit the layer cache. CI / cold starts should pre-pull or pre-build.

### Interactive asks

- **At most one pending `ask_user` per thread.** `registerAsk` throws `AskInUseError` otherwise. The model issues tool calls serially so this matches reality.
- **Text reply in the same thread resolves the pending ask.** `handler.ts` checks `resolveByThreadText(tk, text)` before the normal ingestion path for non-mention text. Mention text takes the normal mention path (so the user can still ask follow-ups while declining to answer).
- **`block_actions` payloads arrive via the `interactive` Socket Mode event** (separate from `message`). `src/slack/interactive.ts` is wired in `index.ts` alongside `listen()`.
- **Multi-select accumulates picks on the in-memory ask entry** (`multiSelected: string[]`); the Submit button click resolves the ask with `JSON.stringify(multiSelected)`. Cancel button rejects with `"cancelled"`. 10-min timeout. `/stop` rejects the deferred via `abortSignal`.

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
- `MODEL_API_KEY` — the model gateway API key. Falls back to `ANTHROPIC_API_KEY` if unset. Same key works against Anthropic's OpenAI-compat endpoint, OpenRouter, or any OpenAI-compat host (set `MODEL_BASE_URL` accordingly).

E2E (required for `bun run e2e`):
- All runtime vars (the test starts the agent in-process)
- `TEST_APP_TOKEN`, `TEST_BOT_TOKEN`, `TEST_CHANNEL_ID`

Optional:
- `AGENTA_DATA_DIR` — overrides `./data` (tests use a mkdtemp dir)
- `MODEL_NAME` — defaults to `claude-sonnet-4-6`
- `MODEL_BASE_URL` — defaults to `https://api.anthropic.com/v1`. For OpenRouter set `https://openrouter.ai/api/v1` and choose a tool-supporting model (e.g. `google/gemini-2.0-flash-exp:free`). Tool calling reliability varies wildly by model — many free models don't support `tool_calls` and the agent regresses to chat-only.
- `SYSTEM_PROMPT` — **prepended** to README.md (separated by a blank line). Used to **replace** the default const prompt entirely; the switch to a per-thread frozen prompt composed from `sandbox/botspace/README.md` made replace-semantics meaningless, so it's now a prefix. Leave unset to use README.md verbatim.
- `BOTSPACE_DIR` — override the directory the prompt is composed from (defaults to `<cwd>/sandbox/botspace`). E2E tests use this to point at an isolated tmpdir.
- `SANDBOX_PROVIDER` — `docker` (default) or `fly`. Picks where per-thread sandboxes live.
- `FLY_APP_NAME` + `FLY_API_TOKEN` — required when `SANDBOX_PROVIDER=fly`. Provision the app once via `bun scripts/deploy-sandbox-fly.ts`, then generate a token: `flyctl tokens create deploy -a <app>`.
- `SANDBOX_EXEC_TIMEOUT_MS` — bash command wall-clock cap inside the sandbox. Default 60s. Tests set it lower.

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

Prioritized roughly by impact / effort:

- **Fly egress block** — sandbox can reach public internet on Fly (RFC1918 allow is too wide; Fly's overlay gateway is in that range). Probably the most user-visible "issue" right now. Fix in `sandbox/entrypoint.sh`: derive the directly-connected subnet from `ip route` and only allow that CIDR instead of all of 172.16/12. Keep Docker behavior intact.
- **DoH-based DNS in `flyProvider`** — so the bot doesn't depend on the host network resolving `<app>.fly.dev` correctly. See "Known issues" above for sketch.
- **Edits/deletes into model context** — events are persisted in JSONL but `buildMessages` ignores them. Spec §11. Smallest of the remaining spec items.
- **Context-window trimming** — spec §11 sliding window with atomic tool-block trim. Will need a tokenizer. Starts mattering when tool loops produce long histories.
- **Host-side egress block (Docker case)** — replace in-container iptables with `DOCKER-USER` rules tied to container IPs so a malicious shell can't undo them. Needs root on the host + per-container teardown.
- **Persisted dedupe + pending-mention queue** across restarts. In-memory only today; Slack redelivery on bot restart can re-process events.
