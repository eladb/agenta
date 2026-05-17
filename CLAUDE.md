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

Phase history, open gotchas, and proposed work live on GitHub as issues.
`ISSUES.md` is the offline index. Quick lookup:

- `gh issue list -R eladb/agenta --label phase --state closed` — what shipped
- `gh issue list -R eladb/agenta --label gotcha` — open footguns to know
- `gh issue list -R eladb/agenta --label proposed` — backlog

### Production runtime notes

- **Bot runs on Fly** as app `agenta-bot` (one shared-cpu-1x machine in `iad`, 1 GB volume `agenta_data` mounted at `/data`). Deploy via `bun scripts/deploy-bot-fly.ts`. No `[http_service]` — Slack is Socket Mode (outbound WS), the model gateway + Fly Machines API are outbound HTTPS, so the bot has no inbound surface.
- **Botspace lives on GitHub** at `eladb/agenta-botspace` (private). `entrypoint.sh` clones it into `/data/botspace` (= `AGENTA_REPO_PATH`) on first boot using `GITHUB_TOKEN`. `git-hooks/post-receive` then auto-pushes every `agenta/sessions/<thread_key>` ref to `origin` after the WS-tunnel receive-pack completes — best-effort, failures log to stderr and don't block the receive.
- **Production bot user**: `U0B2WQUHK6Z` (agent app `A0B2WL8UYAZ`). The agent's manifest scopes after phase 25: `app_mentions:read`, `chat:write`, `channels:history`, `files:read`, `files:write`, `reactions:write`, `users:read`, `users:read.email`. Reinstall required after any scope change via `https://api.slack.com/apps/A0B2WL8UYAZ/install-on-team`.
- **Slack config-tokens** (for `apps.manifest.update`): cached in `.slack-apps.json` (gitignored). `getConfigTokens()` reads env first (one-time bootstrap), persists to cache, then auto-rotates via `tooling.tokens.rotate`. To recover from a lost cache: regenerate at https://api.slack.com/authentication/config-tokens, export `SLACK_CONFIG_ACCESS_TOKEN` + `SLACK_CONFIG_REFRESH_TOKEN`, run any script once, the cache fills back in.

### Session continuity checklist for a fresh Claude session

When you start a new session on this repo:

1. Read this file in full (you're doing that now).
2. Skim recent commits: `git log -25 --oneline` to see what's actually merged vs. what this doc claims.
3. Check `ps aux | grep "bun src/index"` — production agent may already be running on the user's Mac (pid varies). Don't restart unless needed; the `agent` lockfile will block a second instance with a clear error if you try.
4. Glance at ISSUES.md (or 'gh issue list -R eladb/agenta --label gotcha') — Socket Mode silent disconnect (#27), Fly DNS hostility (#29), and SIGTERM unreliability (#35) are the most likely to come up.
5. If the user asks "what's next?", check 'gh issue list -R eladb/agenta --label proposed'. Top of mind today: #39 edits/deletes into context, #40 context-window trimming, #41 Socket Mode watchdog, #43 host-side egress block on docker, #44 persisted dedupe + queue.

## Repo layout

```
src/
  index.ts                 entry: env → acquire('agent') lock → connect → listen (registered FIRST) → fire-and-forget reapOrphanSandboxes + recoverInterruptedSessions; on shutdown teardownAllSessions()
  log.ts                   tiny console logger with scope + level
  lockfile.ts              acquire(name) / release: per-bot tmpdir lockfile with O_CREAT|O_EXCL + stale-pid steal. Auto-released on exit/SIGINT/SIGTERM. Used by production (`'agent'`) and by test helpers (`'agent'`, `'tester'`).
  prompt.ts                buildSystemPrompt(botspaceDir?, envPrefix?): walks the configured host-side directory (default `AGENTA_REPO_PATH`; `BOTSPACE_DIR` override for tests) to compose [env prefix] + README.md + "Available skills" + JSON array (sorted by path). Throws when neither env is set. Pure, no Slack/sandbox deps. Skills with bad frontmatter are warn-and-skipped.
  git/
    git-server.ts          startGitServer({ repoPath, allowedRef, hooksDir }): per-session HTTP server on 127.0.0.1:0 that wraps `git http-backend` as a CGI subprocess per request. Sets core.hooksPath via GIT_CONFIG_* + AGENTA_ALLOWED_REF so the pre-receive hook enforces policy without touching the customer repo's .git/hooks. Accepts /<repo>.git/(info/refs|git-upload-pack|git-receive-pack); rewrites the .git suffix off PATH_INFO for http-backend.
    ws-tunnel.ts           startTunnel / stopTunnel / stopAllTunnels — per-session WS client to the sandbox's /tunnel route. Demultiplexes inbound binary frames (5-byte header: streamId u32 BE | type u8; type 0=data, 1=close) into TCP sockets toward the bot's local git server. Reconnect with backoff (max 5s) on drop; module-level Map<threadKey, TunnelHandle>.
    bootstrap.ts           ensureRepoBootstrap(threadKey): starts the per-session git HTTP server + WS tunnel, probes `localhost:6000` inside the sandbox, persists session.git = {ref}, then clones http://localhost:6000/<repo>.git into ~ and checks out agenta/sessions/<thread_key>. Idempotent (fast-path: handle alive + ref matches + sandbox has ~/.git). Called from turn.ts after ensureContainer, before syncAttachmentsToSandbox. teardownSession / teardownAllSessions stop both halves; called from `/delete` and shutdown handlers.
  slack/
    connect.ts             SocketModeClient + WebClient + auth.test
    events.ts              message → IncomingEvent (message | edit | delete). Drops bot-authored edits/deletes AND no-op message_changed events (same new_text + previous_text = Slack link-unfurl metadata refresh, not a real edit).
    post.ts                postInThread, editMessage, deleteMessage, addReaction, removeReaction, postBlocksInThread, editBlocksMessage. All text passes through mdToMrkdwn at the boundary. Reaction helpers use try/catch so a stub WebClient missing `reactions` doesn't blow up.
    mrkdwn.ts              mdToMrkdwn(): standard GitHub markdown → Slack mrkdwn. Protects fenced + inline code, then links, then bold+italic in a single alternation pass, then headings → bold. Co-located mrkdwn.test.ts has the conversion regression cases.
    interactive.ts         listenInteractive — dispatches block_actions to asks registry
    ask-blocks.ts          block-kit builders for the ask_user tool (buttons/select/multi_select/text)
  runtime/
    handler.ts             dedupe → text-override resolveByThreadText → persist → backfill-if-first → command or startOrQueue
    commands.ts            parseCommand: exact "/stop" or "/delete" only
    dedupe.ts              dedupeKey + createDedupe (LRU-ish set, eventId first)
    thread.ts              threadKey + decodeThreadKey (inverse, for recovery)
    redact.ts              best-effort secret scrubber for error messages
    session.ts             per-thread state machine (idle / running / stopping); writes session.json on transitions
    session-store.ts       atomic temp+rename session.json per thread; schema {status, updated_at, system_prompt?, sandbox?, git?}; clearSession now rewrites idle (preserving system_prompt + sandbox + git), only /delete removes the file. setSandbox / setGit are the atomic helpers providers + bootstrap call.
    recovery.ts            recoverInterruptedSessions: on boot, post "agent restarted" notice + clear stale session.json
    asks.ts                pending ask_user registry; at most one per thread; resolveByThreadText for text-override
    turn.ts                runTurn: single-message-per-turn UX. Adds 🤔 reaction to the originating mention at start; lazy-creates ONE Slack message and overwrites its content as the turn progresses (provisioning status → tool labels → final reply); injectSteering at every iteration boundary appends new user messages to messages[] and 🛞-reacts on them; clears all added reactions in `finally` (success, abort, or error). Accepts an optional `onMidTurnConsume` callback that `session.ts` uses to clear the `pending` flag when steering consumes a mention (so no redundant follow-up turn fires).
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
    provider.ts            SandboxProvider interface (ensure / isReady / getEndpoint / remove / killAll / listAll / destroyById) + SandboxEndpoint {baseUrl, headers}
    persistence.ts         loadSandbox / saveSandbox / clearSandbox / sweepAllSandboxes — thin wrappers over session-store's setSandbox/readSession/listSessions, shared by both providers.
    docker.ts              dockerProvider — local Docker container + per-thread named volume (`agenta-vol-<threadKey>`). ensureImage / ensureNetwork / dockerSpawn + lifecycle. ensure re-hydrates from session.json (verifyAlive via `docker inspect`) before provisioning; the dead-container + live-volume case spawns a new container attached to the existing volume; getEndpoint also lazily re-hydrates; remove tears down container then volume; killAll sweeps both kinds plus the disk-side sandbox field; listAll reports both for the orphan reap.
    fly.ts                 flyProvider — per-thread Fly machine + per-thread Fly volume via the Fly Machines REST API. fly-force-instance-id header routes requests to the specific machine over the shared <app>.fly.dev URL. Same re-hydration shape as docker.ts (verifyAlive via `GET /v1/apps/<app>/machines/<id>` and `state === 'started'`); dead machine + live volume = new machine attached to the existing volume. Volume region resolves from `FLY_REGION` env or the app's `primary_region`. 1 GB volumes.
    index.ts               provider selector (SANDBOX_PROVIDER=docker|fly), provider-agnostic HTTP client: runBash/readFile/readBinary/writeFile/editFile/grep/glob/listDir, consumeExecStream (SSE parser). Re-exports containerName / volumeName for tests. Hosts reapOrphanSandboxes() (boot-time safety net; walks both containers/machines and volumes).
git-hooks/
  pre-receive              bash. Reads `<old> <new> <ref>` triples from stdin, rejects unless `<ref> == $AGENTA_ALLOWED_REF`, accepts zero→sha (initial creation), otherwise requires `git merge-base --is-ancestor` (FF-only). Lives here (not in any customer-repo .git/hooks/) so the agenta policy is versioned alongside the bot. Wired in per-request by src/git/git-server.ts via core.hooksPath (GIT_CONFIG_*).
sandbox/
  Dockerfile               multi-stage: oven/bun:1-slim builds the server binary → ubuntu:24.04 runtime + iptables/ripgrep/git/curl/jq/zip/unzip + python3/python3-pip/python3-pil/matplotlib/numpy/pandas/imagemagick, sandbox user uid 1000. No botspace bake-in — `bootstrap.ts` clones the configured host repo into `/home/sandbox` per session over the WS-tunnel transport. `WORKDIR /home/sandbox`. Note: Ubuntu 24.04 enforces PEP 668 so `pip install` outside a venv needs `--break-system-packages`.
  entrypoint.sh            chown /home/sandbox to sandbox:sandbox (Fly mounts fresh volumes as root:root mode 0755); conditionally installs the iptables OUTPUT block ONLY when `SANDBOX_EGRESS=block` (default: allow); then `setpriv` to sandbox user with bounding/inheritable/ambient caps wiped, then exec the server. (Image-side botspace seeding is gone — clone happens on first sandbox-touching tool, host-driven.)
  fly.toml                 minimal Fly app config — `app = "agenta-sandbox"` + Dockerfile pointer. No services here; the bot creates per-thread machines on demand.
  server/
    server.ts              Bun HTTP API. Endpoints (Bearer auth except /health): /exec (SSE), /read, /read_binary, /write, /edit, /grep, /glob, /ls, /tunnel (WS), /health. Spawned bash inherits cwd=/home/sandbox (the workspace = sandbox user's home = per-thread persistent volume mount). 60s default exec timeout (SANDBOX_EXEC_TIMEOUT_MS). /tunnel binds 127.0.0.1:6000 per WS connection and multiplexes accepted TCP into binary frames (5-byte header: streamId u32 BE | type u8; data=0, close=1) so the bot's local git server (Phase 24) can serve the sandbox's `git` over loopback.
scripts/
  setup-slack-apps.ts      interactive creator via apps.manifest.create (needs config tokens)
  update-manifest.ts       push slack-manifests/<agent|tester>.json via apps.manifest.update (`SLACK_CONFIG_ACCESS_TOKEN=... bun scripts/update-manifest.ts <agent|tester>`). Reports `permissions_updated: true` when reinstall is needed.
  deploy-sandbox-fly.ts    one-shot Fly provisioning + image push (`bun scripts/deploy-sandbox-fly.ts`)
  manual-test-image.ts     quick uploader for the agent: posts a PNG with a mention via the tester
  run-e2e.ts               `bun run e2e` wrapper. Creates a fresh `#agenta-e2e-<stamp>` channel, invites the agent, exports TEST_CHANNEL_ID for each spawned `bun test <file>` (sequentially, one process per file), archives the channel on exit (success/failure/signal).
  canary.ts                `bun run canary` smoke test against a live production agent. Three steps: chat reply → bash + cat → /delete cleanup. Logs `[OK]`/`[FAIL]` per step + non-zero exit on red. Useful after deploys.
slack-manifests/
  agent.json               scopes: app_mentions:read, chat:write, channels:history, files:read, files:write, reactions:write; events: message.channels; interactivity enabled
  tester.json              scopes: app_mentions:read, chat:write, channels:history, files:write, channels:manage, channels:write.invites; events: message.channels (channels:manage + write.invites are for run-e2e's per-run channel creation)
tests/e2e/
  helpers.ts               startAgent (acquires 'agent' lock + in-process socket), startTester (acquires 'tester' lock), mention, uploadFile, waitForReply, waitFor, deleteThread, stubCalls/recordingStub, createGoldenCallModel, shutdown (disconnects + releases both locks), DOCKER_PROVIDER_ACTIVE constant (gates docker-only test files).
  fixtures.ts              inline PNG/PDF/text/binary byte fixtures
  *.test.ts                echo, commands, persistence, edits, attachments, session, tools, sandbox, sandbox-persistence, sandbox-persistence-dead, sandbox-volumes, skills, skills-golden, inbound-attachments, share-file, asks
tests/golden/
  <test-file>/<test-name>.jsonl   recorded (request, response) pairs for golden-run tests; replayed positionally
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
- **`--cap-drop ALL` strips `CAP_CHOWN`** even from root inside the container, so `entrypoint.sh` must NOT try to `chown` anything. The botspace seed under `/opt/botspace/` is owned by `sandbox:sandbox` at image-build time (`COPY --chown=…`); `cp -a /opt/botspace/. /home/sandbox/` preserves that ownership when seeding a fresh volume, so an explicit chown isn't needed. The home dir itself is created with the correct uid/gid by `useradd --create-home`.
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
- `AGENTA_REPO_PATH` — absolute path to a non-bare git working tree on the bot host. It's both the source of the prompt (README.md + skills/) AND the remote the per-session sandbox clones from + pushes back to. Required for `bun start`; only optional in tests (set `BOTSPACE_DIR` instead to point the prompt builder at a tmpdir). On Fly, `entrypoint.sh` clones from `BOTSPACE_REPO` into this path on first boot.
- `BOTSPACE_REPO` — `owner/repo` of the GitHub repo `entrypoint.sh` clones into `AGENTA_REPO_PATH` on Fly. Set in `fly.toml`'s `[env]` (default `eladb/agenta-botspace`); ignored when the path already exists, so it's a no-op for local `bun start` against a checked-out repo.
- `GITHUB_TOKEN` — fine-grained PAT with read+write to `BOTSPACE_REPO`. Used by `entrypoint.sh` to clone on first boot and embedded in the `origin` URL so the `post-receive` hook can auto-push session refs. Fly secret only; not needed for local `bun start`.

E2E (required for `bun run e2e`):
- All runtime vars (the test starts the agent in-process)
- `TEST_APP_TOKEN`, `TEST_BOT_TOKEN`, `TEST_CHANNEL_ID`

Optional:
- `AGENTA_DATA_DIR` — overrides `./data` (tests use a mkdtemp dir)
- `MODEL_NAME` — defaults to `claude-sonnet-4-6`
- `MODEL_BASE_URL` — defaults to `https://api.anthropic.com/v1`. For OpenRouter set `https://openrouter.ai/api/v1` and choose a tool-supporting model (e.g. `google/gemini-2.0-flash-exp:free`). Tool calling reliability varies wildly by model — many free models don't support `tool_calls` and the agent regresses to chat-only.
- `SYSTEM_PROMPT` — **prepended** to README.md (separated by a blank line). Used to **replace** the default const prompt entirely; the switch to a per-thread frozen prompt composed from `<AGENTA_REPO_PATH>/README.md` made replace-semantics meaningless, so it's now a prefix. Leave unset to use README.md verbatim.
- `BOTSPACE_DIR` — override the directory the prompt is composed from (precedence: `BOTSPACE_DIR` > `AGENTA_REPO_PATH`). E2E + unit tests use this to point at an isolated tmpdir so they don't need a real repo on disk.
- `SANDBOX_PROVIDER` — `docker` (default) or `fly`. Picks where per-thread sandboxes live.
- `SANDBOX_EGRESS` — `allow` (default) or `block`. Controls whether the in-container iptables OUTPUT block is installed. `block` matches the old behavior (loopback + RFC1918 + link-local only).
- `FLY_APP_NAME` + `FLY_API_TOKEN` — required when `SANDBOX_PROVIDER=fly`. Provision the app once via `bun scripts/deploy-sandbox-fly.ts`, then generate a token: `flyctl tokens create deploy -a <app>`.
- `FLY_REGION` — optional override for the region per-thread Fly volumes + machines provision into. Defaults to the app's `primary_region`. Set this if you want sandboxes in a specific region regardless of where the app's primary is.
- `SANDBOX_EXEC_TIMEOUT_MS` — bash command wall-clock cap inside the sandbox. Default 60s. Tests set it lower.

For the setup script only (rotates every 12h):
- `SLACK_CONFIG_ACCESS_TOKEN`, `SLACK_CONFIG_REFRESH_TOKEN`

`.env` is gitignored. `.slack-apps.json` (app-id cache used by the setup script) is also gitignored.

## Running things

```sh
bun install
bun run test     # unit tests in src/
bun run e2e      # scripts/run-e2e.ts: creates a fresh #agenta-e2e-<stamp> channel, runs each tests/e2e/*.test.ts in its own bun process sequentially, archives on exit
bun run canary   # scripts/canary.ts: 3-step smoke test against the running production agent (chat reply → bash → /delete)
bun start        # production agent (acquires the 'agent' lockfile; second invocation errors with the running pid)
bun run lint     # biome check
bun run format   # biome format --write
bun run setup    # interactive Slack app creation (apps.manifest.create)
bun run deploy   # scripts/deploy-bot-fly.ts: provisions agenta-bot app + agenta_data volume in iad, builds + rolls the bot image
# scripts/update-manifest.ts <agent|tester> — push a manifest change to Slack via apps.manifest.update (needs SLACK_CONFIG_ACCESS_TOKEN)
# scripts/deploy-sandbox-fly.ts — builds + pushes the sandbox image to registry.fly.io/agenta-sandbox:latest (run when sandbox/ changes)
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
- **Conventional Commits is mandatory** for BOTH commit subjects AND PR titles. Format: `<type>(<optional-scope>): <subject> (#NN)`. Allowed types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `perf`, `build`, `ci`, `style`, `revert`. Scope is the touched area (`sandbox`, `SPEC`, `CLAUDE.md`, `slack`, etc.). The `(#NN)` issue reference is required when there's an associated issue (i.e. always, under the issue-driven workflow). Examples: `feat(sandbox): background warmup + lazy UI (#11)`, `docs(SPEC): drop §5 dangling note (#56)`.
- Never push without being asked.
- Never amend / force-push.
