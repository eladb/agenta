# SPEC: Slack Thread-Backed Agentic Sandbox Bot (v1)

## 1) Problem Statement
Build a single-workspace Slack bot platform where each thread can host an isolated, long-running agent session with filesystem/shell tooling, sandbox isolation, and persistent thread history. The system must be simple, deterministic, and bootstrap-friendly for implementation by multiple agents.

## 2) Scope and Goals
### Goals
- Mentioning the bot in Slack creates or continues a thread-scoped agent session.
- Each session can run an agentic tool loop using an OpenAI-compatible model interface.
- Filesystem/shell tools execute via provider implementations, with sandboxed execution as default behavior.
- Thread history is persisted locally as immutable append-only events and used directly as model context input.
- Operational controls are available in-thread via strict commands: `/stop` and `/delete`.
- The bot's identity, rules, and capabilities (system prompt + skills) are configurable per deployment via a host-side git working tree that the model can also read, edit, commit, and push from inside its sandbox.

### Non-Goals (v1)
- Multi-workspace tenancy.
- Rich retention/compliance controls beyond immediate deletion semantics.
- Token streaming of final assistant response into Slack.
- Runtime switching of provider/orchestrator implementations.

## 3) High-Level Architecture
- **Slack Adapter (Socket Mode):** receives events, performs dedupe, normalizes Slack messages/edits/deletes, dispatches `block_actions` payloads, and exposes a typed posting interface (`postInThread`, `editMessage`, `addReaction`, `removeReaction`). All outgoing text passes through a standard-markdown → Slack-mrkdwn converter at the boundary (#17).
- **Session Runtime:** one active agent loop per thread; handles turn scheduling, mid-turn steering (#18), command handling, single-message-per-turn progress UX, cancellation, and per-thread state persisted in `session.json`.
- **Model Gateway:** plain `fetch` against an OpenAI-compatible `chat/completions` endpoint. Wire format is OpenAI; auth is `Authorization: Bearer <api-key>`. No SDK.
- **Tool Execution Layer:** system-defined tools registered in `src/model/tools/`, one file per tool. Each tool declares its OpenAI schema, a human-readable `describe`, and an `invoke`. Tools that need a sandbox set `requiresSandbox: true`.
- **Sandbox Subsystem:** pluggable provider (`docker` or `fly`) (#6, #10) exposing a uniform HTTP client. Each per-thread sandbox runs an in-container Bun HTTP server with Bearer-auth'd endpoints and a per-thread persistent volume (#16).
- **Botspace + Git Transport:** the system prompt is composed from a host-side git working tree (`AGENTA_REPO_PATH`) consisting of `README.md` + `skills/<slug>/SKILL.md` files (#13). The same working tree is exposed inside the sandbox over a per-session WebSocket tunnel that multiplexes loopback TCP to a bot-local `git http-backend` (#24). The model can `git clone`, commit, and push back over `http://localhost:6000/<repo>.git` inside the sandbox.
- **Persistence Layer (Files):** per-thread directory under `data/{thread_key}/` containing `messages.jsonl`, `attachments/`, and `session.json`.

## 4) Tenancy and Identity
- **Tenancy:** single Slack workspace only.
- **Thread identity key:** `channel_id + thread_ts`.
- **Canonical `thread_key`:** `{channel_id}__{thread_ts}` with `thread_ts` normalized for filesystem safety (replace `.` with `_`). The same encoding doubles as a git ref-name-safe identifier and is used to name the per-thread session branch (`agenta/sessions/<thread_key>`).
- **Storage layout:**
  - `data/{thread_key}/messages.jsonl`
  - `data/{thread_key}/attachments/...`
  - `data/{thread_key}/session.json`

## 5) Session Lifecycle
### Session Mapping
- At most one active session per Slack thread.
- A non-thread channel mention of the bot auto-creates a thread and the session is bound to that thread.

### Creation and Ingestion
- First mention that activates a session backfills full thread history via `conversations.replies`, excluding the triggering message (which is recorded by the main handler).
- While a session is inactive, non-mention thread messages are still ingested and persisted.
- Mentions trigger agent turns; non-mentions do not trigger turns.
- On the first mention of a thread the bot:
  - resolves the originating Slack user via `users.info` and persists `{ email, name }` into `session.json.git.creator` so subsequent sandbox git commits are authored as that user (#25);
  - composes the system prompt from the configured botspace directory (`AGENTA_REPO_PATH` or `BOTSPACE_DIR`) and freezes it into `session.json.system_prompt` — every subsequent turn in that thread uses the same prompt (#13).

### Runtime States (Normative)
- Persisted `session.json.status` is exactly one of: `idle` | `running` | `stopping`.
- `idle`: no active agent loop; may have pending mentions queued in memory.
- `running`: agent loop in progress for the thread.
- `stopping`: `/stop` requested and cancellation is in progress.
- Allowed transitions:
  - `idle -> running` (mention dequeued / new mention),
  - `running -> idle` (normal completion),
  - `running -> stopping -> idle` (successful stop).
- `signalStop` MUST write `stopping` to disk **before** firing `abort.abort()` so the turn's `finally { clearSession }` cannot race ahead and leave a stale `stopping` entry.
- `/delete` does not have a persisted state; it removes the thread directory entirely.
- Runtime state is checkpointed via atomic temp+rename writes; event history remains immutable append-only regardless of state transitions.

### Deletion
- `/delete` fully replaces `/reset` (which is removed).
- `/delete` behavior:
  - best-effort interrupt the active run (if any),
  - tear down the per-session git transport (WS tunnel + local git server),
  - destroy the sandbox container/machine **and** its per-thread persistent volume,
  - remove the entire `data/{thread_key}/` directory (including `session.json` and `attachments/`),
  - next mention starts a fresh timeline/session state.
- `/delete` does **not** delete `agenta/sessions/<thread_key>` on the host botspace repo — that branch is the model's work product.
- `/delete` applies even when no active run exists.
- `/delete` is thread/session scoped only.

## 6) Commands and Parsing
### Supported Commands
- `/stop`
- `/delete`

### Parsing Rules
- Commands are recognized only in messages that mention the bot.
- Command body must be exact lowercase command text and nothing else.
- If extra text exists (e.g. `@bot /stop and ...`), treat as normal agent input, not command.

### Authorization
- Any participant in the thread may invoke `/stop` or `/delete`.

## 7) Turn Scheduling and Concurrency
- Exactly one agent loop executes per thread at a time.
- If mentions arrive during an active run, they are **steered** into the running turn at the next iteration boundary (#18): `injectSteering` reads new `slack.message` events that arrived since the last refresh, filters slash-commands, and appends them to the in-memory `messages[]` as `role: 'user'` before the next model call. A 🛞 reaction is added to each steered message.
- A no-tool-calls model response combined with new steering content does **not** terminate the turn — the candidate final reply renders as an italic intermediate (overwritten next round) and the loop continues.
- Real-time mid-API-call interruption is not supported; granularity is "between rounds".
- If a mention arrives after a turn completes (no steering occurred), it starts a fresh subsequent turn.

### Idempotency and Event Dedupe
- Slack event ingestion MUST be idempotent under retries/replays.
- Dedupe key priority:
  1) native Slack event identifier when present,
  2) otherwise deterministic fallback: `channel_id + thread_ts + user + ts + normalized_text_hash`.
- Duplicate events are ignored for scheduling while preserving first-seen ordering guarantees.
- At-least-once delivery from Slack MUST NOT create duplicate history records or duplicate turn triggers.
- `message_changed` events whose `new_text` matches `previous_text` are dropped as no-op link-unfurl metadata refreshes.

### Not yet implemented
- Persisted dedupe + pending-mention queue across restarts; the dedupe set is in-memory only and Slack redelivery on bot restart can re-process events (open #44).

## 8) `/stop` Semantics
- `/stop` cancels only the in-flight turn via the turn's `AbortController`; session/sandbox/history remain.
- Cancellation is signaled via the abort signal threaded through `runTurn`, the model gateway, the tool loop, and sandbox HTTP calls.
- If the currently-executing tool cannot stop, the runtime waits for it to complete, then halts the loop before the next iteration.
- Pending mentions queued during stop trigger a new turn after `stopping -> idle` completes.
- `/stop` never performs hard reset/deletion.
- Pending `ask_user` interactions are rejected via the abort signal so the model sees a structured cancellation.

## 9) Progress and Slack UX
### Single-Message-Per-Turn Model (Normative)
- A turn produces at most **one** Slack message that evolves in place via `chat.update`.
- The message is lazy-created on the first concrete content (a tool execution, a workspace status line, or a steered intermediate). A turn that goes straight to a text-only final reply MUST NOT create a "thinking…" placeholder — the bot posts the final reply directly.
- Each round (one model response = one iteration of the tool loop) overwrites the previous round's content in the same message. The final round replaces the content with clean prose.

### Reactions
- The originating mention gets a 🤔 reaction added at turn start as the cross-round "still working" signal.
- Steered mid-turn user messages get a 🛞 reaction.
- All reactions added during a turn MUST be removed in a `finally` block on success, abort, or error.

### Body Format
- An italic header line (`*reasoning*` standard markdown → `_reasoning_` Slack mrkdwn), blank line, then tool labels with `→ result-or-exit-code` summaries.
- Live `bash` previews stream under the bash bullet (debounced) and collapse to `→ exit: N` on completion (#7).
- Workspace status (`_waiting for workspace to become available…_`) renders inline only while provisioning is in flight; on success it disappears, on failure it mutates to a workspace-provisioning-failed line and the corresponding tool gets an error tool_result.

### Markdown Conversion
- All outgoing Slack text passes through `mdToMrkdwn` (#17): the model is instructed to emit standard GitHub markdown; the converter rewrites bold/italic/links/headings into Slack mrkdwn at the boundary.

### Completion and Stop
- On normal completion, the message is overwritten with the final assistant response.
- On `/stop`, the message ends with a stopped marker; no separate follow-up message is posted.

## 10) Error Handling
- Unhandled errors (including sandbox provisioning failures) post a separate Slack error message in thread.
- Include raw stack/error details in that message.
- Apply best-effort secret redaction (obvious key/token/PEM patterns) before posting.
- Sandbox HTTP failures mid-turn surface as tool errors to the model; the runtime does **not** auto-reprovision on failure.

## 11) Memory and Context Construction
- No automatic cross-thread memory.
- Thread-local history includes:
  - human Slack events,
  - assistant events,
  - tool call/result events,
  - edit/delete events.
- Canonical format: immutable append-only JSONL event stream under `data/{thread_key}/messages.jsonl`.
- Model context is reconstructed from raw event history by `buildMessages`: it emits `system | user | assistant | tool` messages, reattaches `tool_calls` to their parent assistant message, synthesizes orphan-tool_call stubs when a result was never persisted, and skips the `share_file` assistant-message envelope so `[shared X]` markers are not projected back as the model's voice.
- Attachment events store local file references only (`payload.files[].local_path`); base64 is materialized in memory per model call by reading the file from disk.
- Inbound attachments are also mirrored into the sandbox at `attachments/<file_id>-<safeName>` so the model can `read_file`/`bash` them; `buildMessages` appends `[attached: attachments/<file_id>-<safeName>]` to the user message text as a path hint for non-vision models (#12).

### Event Record Minimum Fields
- Every JSONL event record MUST include:
  - `event_id` (stable unique id in local store),
  - `thread_key`,
  - `source` (`slack` | `assistant` | `tool` | `system`),
  - `type` (message/edit/delete/tool_call/tool_result/status/error/etc.),
  - `ts` (event occurrence timestamp),
  - `ingested_at` (local ingest timestamp),
  - `payload` (type-specific object).
- Tool call/result events MUST be linkable via stable correlation ids; orphan tool_calls are synthesized as stub results during context construction.

### Not yet implemented
- **Edits/deletes projected into model context** (open #39). Edit and delete events are persisted in JSONL but `buildMessages` currently ignores them.
- **Context window trimming** (open #40). The full history is sent on every call; a token-based sliding window (e.g. 50% retain budget, oldest-first, with atomic tool call/result groupings) is not yet implemented.

## 12) Slack Edit/Delete and Attachments
- Slack edits/deletes are represented as immutable events in the JSONL history.
- Attachment content is eagerly ingested on receipt: bytes are downloaded via `url_private_download`, MIME-detected from bytes (not filename or Slack metadata), and saved under `data/{thread_key}/attachments/`.
- If attachment ingestion fails, the turn continues and emits a warning.
- On Slack message deletion, corresponding local attachment files are physically deleted; the JSONL audit trail (including the delete event) remains intact.

## 13) Workspace-Configurable vs System-Defined
### Workspace-Configurable (Dynamic — via the host-side botspace repo)
- System prompt (`README.md` at the root of `AGENTA_REPO_PATH`).
- Skills (`skills/<slug>/SKILL.md` with YAML frontmatter for `name` + `description`).
- Model settings via env (`MODEL_NAME`, `MODEL_BASE_URL`, `MODEL_API_KEY`).
- Botspace edits affect **new** threads only: the system prompt is frozen per-thread on first mention (#13), so README.md or skill changes do not propagate to threads that are already running.

### System-Defined (Code, Not Workspace Runtime Config)
- Tool/provider implementations (`src/model/tools/`).
- Orchestrator implementation (`src/runtime/`).
- Sandbox provider implementations (`src/sandbox/{docker,fly}.ts`).

## 14) Sandbox and Provider Requirements
### Provider Model
- The sandbox is implemented behind a `SandboxProvider` interface (`ensure / isReady / getEndpoint / remove / killAll / listAll / destroyById`) with two concrete implementations: `dockerProvider` (local Docker container) and `flyProvider` (per-thread Fly Machines VM over the shared `<app>.fly.dev` URL, routed via `fly-force-instance-id`) (#10).
- The provider is selected at boot via `SANDBOX_PROVIDER=docker|fly` (default `docker`).
- All bot↔sandbox traffic goes through an in-container **Bun HTTP server** exposing Bearer-authenticated endpoints: `/exec` (SSE-streamed bash), `/read`, `/read_binary`, `/write`, `/write_binary`, `/edit`, `/grep`, `/glob`, `/ls`, `/tunnel` (WS), `/health` (unauthenticated).
- Sandbox warmup is **background-eager**: `handler.ts` fires `kickoffEnsureContainer` immediately after the turn is committed; the first sandbox-touching tool awaits the same in-flight promise (deduped per-thread). The common case is "sandbox already ready by the time the first tool fires" with no workspace status line shown. If provisioning is still in flight, a single `_waiting for workspace to become available…_` line is rendered until it lands (#11).

### Per-Thread Persistent Volume
- The workspace lives on a per-thread named volume (`agenta-vol-<thread_key>` on docker, a Fly volume on fly) mounted at `/home/sandbox` (#16).
- Workspace state survives machine replacement (Fly trial auto-stops, image upgrades, OOM kills, bot restarts) — only `/delete` wipes it.
- Fly volumes are 1 GB (Fly minimum). Region resolves from `FLY_REGION` or the app's `primary_region`.

### Security and Access
- Container hardening: runs as **uid 1000 `sandbox`**, `--cap-drop ALL` + `--cap-add NET_ADMIN/SETUID/SETGID/SETPCAP` (entrypoint uses them then `setpriv`s them away), `--security-opt no-new-privileges`, `--pids-limit 256`, `--memory 1g`, `--cpus 1.0` (docker).
- Sandbox egress is controlled by `SANDBOX_EGRESS` (default `allow`): when set to `block`, the entrypoint installs in-container iptables OUTPUT rules permitting only loopback, RELATED/ESTABLISHED, RFC1918, and link-local (#21). On Fly the egress block has limited practical effect because Fly's overlay gateway is in 172.16/12 and falls under the RFC1918 allow.
- Bot↔sandbox authentication is per-container Bearer token. mTLS is not used.

### Git Transport (Per-Session WebSocket Tunnel)
- Each session gets a transport for the host botspace repo via a per-session WebSocket tunnel over the existing sandbox HTTP API (#24):
  - The sandbox `/tunnel` route binds `127.0.0.1:6000` inside the container; on each accepted TCP connection it allocates a u32 streamId and multiplexes bytes both ways using a 5-byte frame header (`streamId u32 BE | type u8`; type 0 = data, type 1 = close).
  - The bot side runs a per-session HTTP server on `127.0.0.1:0` that wraps `git http-backend` as a CGI subprocess. `core.hooksPath` is set via `GIT_CONFIG_*` env so the agenta `pre-receive` hook (ref-namespace restriction + fast-forward-only) runs without touching the configured repo's hook tree. `http.receivepack=true` is forced the same way so non-bare repos accept pushes.
  - On the first sandbox-touching tool of a turn, `ensureRepoBootstrap` starts the local git server, opens the WS tunnel (forwarding the **full** endpoint headers map from `getEndpoint`, including `fly-force-instance-id` on Fly), probes loopback inside the sandbox, clones `http://localhost:6000/<repo>.git` into `/home/sandbox`, configures the cached creator identity, and checks out `agenta/sessions/<thread_key>`.
  - The previous SSH-based transport (host sshd + per-session authorized_keys + dropbear + autossh + WireGuard) is removed.

### Orchestration
- Orchestrator concerns (capacity/concurrency/resource limits) are delegated to provider implementations.
- Runtime switching of provider is out of scope; flipping `SANDBOX_PROVIDER` between runs causes the old provider's sandboxes to leak.

## 15) Persistence and Recovery
- Primary datastore is filesystem-based (no DB).
- History is append-only JSONL per thread.
- `session.json` schema (atomic temp+rename writes): `{ status, updated_at, system_prompt?, sandbox?, git? }` where:
  - `status: 'idle' | 'running' | 'stopping'`,
  - `system_prompt` is frozen on first mention and persists across status transitions,
  - `sandbox` is the per-thread provider routing record (`{ provider, container_name|machine_id, token, volume_name?|volume_id? }`) populated by the provider on every `ensure` (#14, #16),
  - `git` is `{ ref, creator? }` for the session's branch and optional Slack-user identity used for sandbox commits (#22, #25).
- `clearSession` rewrites `session.json` as `idle` (preserving `system_prompt`, `sandbox`, and `git`); only `/delete` removes the thread directory.
- **On bot restart**, the next `ensureContainer` re-hydrates the sandbox record from `session.json` via a single liveness check (`docker inspect --format '{{.State.Running}}'` / `GET /v1/apps/<app>/machines/<id>`):
  - live container/machine + matching provider → adopt;
  - dead container/machine + live volume → spawn a fresh container/machine attached to the existing volume (same token, same workspace);
  - cross-provider mismatch (provider changed since last boot) → log + treat as no sandbox (the old container/machine leaks; no auto-migration).
- **At boot**, `reapOrphanSandboxes` (fire-and-forget; runs in the background after Socket Mode `listen` is registered) walks both containers/machines AND volumes via `listAll`, and destroys any sandbox or volume without a matching live `session.json` record.
- **At boot**, `recoverInterruptedSessions` scans `data/*/session.json`, filters to `status === 'running' | 'stopping'`, posts an "agent restarted — previous turn was interrupted" notice per match, then clears the entry to `idle` (preserving the frozen prompt). Idle entries are skipped to avoid re-announcement on every boot.
- A sandbox HTTP call failing mid-turn returns its error to the model; no auto-reprovision.

## 16) OpenAI-Compatible Model Interface
- Agent loop talks to model providers through the standard OpenAI `chat/completions` wire format.
- Default endpoint is Anthropic's OpenAI-compatible host (`https://api.anthropic.com/v1`); `MODEL_BASE_URL` switches to OpenRouter or any other OpenAI-compatible host.
- Authentication is `Authorization: Bearer <MODEL_API_KEY>` (falls back to `ANTHROPIC_API_KEY`).
- Multipart `content` arrays (image_url / text parts) are used for attachments on `user` role messages.
- External model provider backends MUST be swappable without changing core agent loop semantics.

## 17) Acceptance Criteria (v1)
- Mention in new channel message starts a thread-backed session and responds in-thread only.
- Mention in existing thread routes to the same thread session.
- `/stop` interrupts the in-flight loop per the semantics above, without deleting session, sandbox, or history.
- `/delete` removes the thread directory (including `session.json` and `attachments/`), destroys the sandbox container/machine and per-thread volume, and the next mention starts a clean session.
- The event stream persists all events immutably in JSONL order for each thread.
- A single Slack message per turn shows progress in-place via reactions + content updates; reactions are cleared in a `finally` block on success, abort, or error.
- Mid-turn mentions steer the running turn at the next iteration boundary instead of triggering a parallel turn.
- The sandbox is per-thread via the configured provider (docker or fly), runs as a non-root user with capabilities dropped, and is reachable only via Bearer-authenticated HTTP.
- The system prompt is composed from the host-side botspace repo on first mention and frozen for the thread's lifetime; subsequent botspace edits do not affect already-running threads.
- The model can `git clone` the host botspace repo into `/home/sandbox` over the WS tunnel, commit, and push back to `agenta/sessions/<thread_key>` (fast-forward-only against the per-session ref).
- Unhandled errors appear in thread as a separate message with stack trace and best-effort secret redaction.

## 18) Test Matrix (v1 Minimum)
- **Thread identity and storage**
  - deterministic `thread_key` derivation maps all events for one Slack thread into one directory.
- **Scheduling and steering**
  - mentions that arrive during an active run are appended to the running turn at the next iteration boundary (steering); the candidate final reply is suppressed and the loop continues if new steering arrived.
- **Stop behavior**
  - `/stop` during tool execution yields a stopped terminal marker, no history deletion, and no sandbox teardown.
- **Delete behavior**
  - `/delete` removes the thread directory and the sandbox (container/machine + volume); next mention starts fresh.
- **Idempotency**
  - replayed Slack events do not duplicate history records or retrigger turns.
- **Recovery**
  - process crash during `running` or `stopping` results in an interrupted notice posted to Slack on next boot, with `session.json` cleared back to `idle`.
- **Sandbox persistence**
  - bot restart re-adopts a live container/machine; a dead container/machine with a live volume spawns a fresh container reattached to the existing workspace.
- **Botspace round-trip**
  - the sandbox can `git clone` the host repo, create a commit on `agenta/sessions/<thread_key>`, and push back through the WS tunnel (gated on docker availability via `DOCKER_PROVIDER_ACTIVE`).
- **Attachment lifecycle**
  - inbound attachments are MIME-detected from bytes, persisted on disk, mirrored into the sandbox at `attachments/<file_id>-<safeName>`, and emitted as multipart `user` content to the model; on Slack delete the local file is removed while the JSONL audit trail remains.
- **Outbound attachments**
  - the `share_file` tool uploads from the sandbox to Slack via `files.uploadV2` and records the upload as an assistant-message event with a `files` payload.
- **Golden-run regression**
  - selected end-to-end flows exercise the real model gateway with a record/replay layer (`tests/golden/<test-file>/<kebab-test-name>.jsonl`) (#15).
- **Per-run isolation**
  - each `bun run e2e` invocation creates a fresh `#agenta-e2e-<stamp>` Slack channel, invites the agent, runs each `tests/e2e/*.test.ts` in its own bun subprocess sequentially, and archives the channel on exit (#20).
