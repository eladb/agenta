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

### Non-Goals (v1)
- Multi-workspace tenancy.
- Rich retention/compliance controls beyond immediate deletion semantics.
- Token streaming of final assistant response into Slack.
- Runtime switching of provider/orchestrator implementations.

## 3) High-Level Architecture
- **Slack Adapter (Socket Mode):** receives events, performs dedupe, maps events to thread state.
- **Session Runtime:** one active agent loop per thread; handles turn scheduling, mention batching, command handling, progress updates, and cancellation.
- **Model Gateway:** provider-agnostic OpenAI-format interface for model calls.
- **Tool Execution Layer:** system-defined tool/provider functions (not workspace-config-defined code).
- **Sandbox Subsystem:** per-session isolated sandbox lifecycle + API surface for shell/filesystem operations.
- **Persistence Layer (Files):** thread event streams, attachment artifacts, and runtime checkpoints on disk.

## 4) Tenancy and Identity
- **Tenancy:** single Slack workspace only.
- **Thread identity key:** `channel_id + thread_ts`.
- **Canonical `thread_key`:** `{channel_id}__{thread_ts}` with `thread_ts` normalized for filesystem safety (replace `.` with `_`).
- **Storage layout:**
  - `data/{thread_key}/messages.jsonl`
  - `data/{thread_key}/attachments/...`
  - `data/{thread_key}/session.json` (or equivalent runtime checkpoint file)

## 5) Session Lifecycle
### Session Mapping
- At most one active session per Slack thread.
- A non-thread channel mention of the bot auto-creates a thread and the session is bound to that thread.

### Creation and Ingestion
- First mention that activates a session backfills full thread history (including messages before first bot mention).
- While a session is inactive, non-mention thread messages are still ingested and persisted.
- Mentions trigger agent turns; non-mentions do not trigger turns.

### Expiration
- Inactivity timeout: 24 hours.
- Inactivity expiry behaves exactly like `/delete` for that thread/session.

### Runtime States (Normative)
- `idle`: no active agent loop; may have pending mention queue.
- `running`: agent loop in progress for the thread.
- `stopping`: `/stop` requested and cancellation is in progress.
- `deleting`: `/delete` requested and teardown is in progress.
- Allowed transitions:
  - `idle -> running` (pending mention dequeued),
  - `running -> idle` (normal completion),
  - `running -> stopping -> idle` (successful stop),
  - `idle|running|stopping -> deleting -> idle` (delete completed; fresh state),
  - `running -> idle` on crash/restart with interrupted marker persisted.
- Runtime state is checkpointed; event history remains immutable append-only regardless of state transitions.

### Deletion
- `/delete` fully replaces `/reset` (which is removed).
- `/delete` behavior:
  - best-effort interrupt active run (if any),
  - delete thread/session stored history,
  - delete local attachment files for that thread/session,
  - tear down sandbox,
  - next mention starts fresh timeline/session state.
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
- If mentions arrive during an active run:
  - do not interrupt automatically,
  - batch them into the next turn payload,
  - preserve chronological order,
  - preserve author/time/message boundaries in serialized form.
- Batched payload should use canonical history event serialization (JSONL-derived structure).

### Idempotency and Event Dedupe
- Slack event ingestion must be idempotent under retries/replays.
- Dedupe key priority:
  1) native Slack event identifier when present,
  2) otherwise deterministic fallback: `channel_id + thread_ts + user + ts + normalized_text_hash`.
- Duplicate events are ignored for scheduling while preserving first-seen ordering guarantees.
- At-least-once delivery from Slack must not create duplicate history records or duplicate turn triggers.

## 8) `/stop` Semantics
- `/stop` cancels only the in-flight turn; session/sandbox/history remain.
- Cancellation is tool-provider-abstracted (stop API), not hardcoded signal policy.
- If current tool cannot stop, runtime waits for tool completion, then halts loop before next step.
- If mentions are pending when stop completes, those pending mentions immediately trigger a new turn.
- `/stop` never performs hard reset/deletion.

## 9) Progress and Slack UX
### During Turn
- On turn start, bot posts `thinking...` in thread.
- Bot edits that message into a growing checklist of intermediate steps.
- Checklist must include tool executions; include human-friendly descriptions when available.
- Prefer status transitions (`pending -> running -> done/failed`) when feasible.
- Throttle/coalesce checklist edits to avoid Slack rate limits.

### Completion and Stop
- On normal completion, replace the checklist message content with the final assistant response.
- On `/stop`, keep checklist and append final stopped marker (e.g. `stopped by user`), with no extra follow-up message.

## 10) Error Handling
- Unhandled errors (including sandbox provisioning failures) post a separate Slack error message in thread.
- Include raw stack/error details in that message.
- Apply simple best-effort secret redaction (obvious key/token/PEM patterns).

## 11) Memory and Context Construction
- No automatic cross-thread memory.
- Thread-local history includes:
  - human Slack events,
  - assistant events,
  - tool call/result events,
  - edit/delete events.
- Canonical format: immutable append-only JSONL event stream.
- Model context uses raw event history (not reconstructed “latest visible only” thread state).
- Attachment events store local file references (no embedded base64 blobs in history records).

### Event Record Minimum Fields
- Every JSONL event record must include:
  - `event_id` (stable unique id in local store),
  - `thread_key`,
  - `source` (`slack` | `assistant` | `tool` | `system`),
  - `type` (message/edit/delete/tool_call/tool_result/status/error/etc.),
  - `ts` (event occurrence timestamp),
  - `ingested_at` (local ingest timestamp),
  - `payload` (type-specific object),
  - `causal_parent_ids` (optional list for tool/result linkage or edit/delete ancestry).
- Tool call/result events must be linkable via stable correlation ids.

### Context Window Policy
- Token-based sliding window.
- Default retain budget: 50% of effective context budget.
- Apply after reserving budget for system prompt, tool schemas, and reply buffer.
- Trimming is oldest-first.
- Tool interaction trimming must be atomic (do not leave orphaned call/result fragments).

## 12) Slack Edit/Delete and Attachments
- Slack edits/deletes are represented in immutable event history.
- Attachment content is eagerly ingested on receipt when model-ingestible.
- If attachment ingestion fails, continue turn and emit warning.
- On Slack message deletion, physically delete corresponding local attachment files.
- Event stream remains intact (including delete/edit events).

## 13) Workspace-Configurable vs System-Defined
### Workspace-Configurable (Dynamic)
- System prompt.
- Skills.
- Model settings (provider/model/temperature/etc.).
- Updates are dynamic and apply to active sessions.

### System-Defined (Code/Functions, Not Workspace Runtime Config)
- Tool/provider implementations.
- Orchestrator implementation.
- Sandbox provider implementation.

## 14) Sandbox and Provider Requirements
### Provider Model
- Agent tools like bash/filesystem are implemented via providers.
- Default execution behavior uses sandbox provider.

### v1 Sandbox Implementation
- Implement sandbox provider with Docker containers.
- Fresh sandbox container per session; no reuse across sessions.
- Sandbox state (filesystem/processes) persists across turns within a session.
- Sandbox torn down on `/delete` and inactivity deletion.

### Security and Access
- Bot↔sandbox API requires mTLS.
- Sandbox egress network is blocked by default and Linux-kernel enforced.
- Optional egress allowlisting may be applied by policy.
- SSH is enabled; bot-side tools may SSH as `root` or `sandbox`.
- SSH keys are ephemeral per session and non-exportable (never exposed in model context/log output).

### Orchestration
- Orchestrator concerns (capacity/concurrency/resource limits) are delegated to orchestrator implementation.
- Orchestrator is pluggable at system-design level, but runtime switching is out of scope in v1.

## 15) Persistence and Recovery
- Primary datastore is filesystem-based (no DB required for v1).
- History is append-only JSONL per thread.
- Runtime state is checkpointed to disk.
- On process crash/restart, in-flight turns are marked interrupted; no auto-resume in v1.
- Interrupted/failure status should be surfaced to Slack thread.
- On startup, runtime performs best-effort recovery scan of `session.json` files to reconcile stale `running/stopping/deleting` states into deterministic interrupted/deleted terminal states.

## 16) OpenAI-Compatible Model Interface
- Agent loop talks to model providers through standard OpenAI-format API compatibility.
- System must permit external model provider backends without changing core agent loop semantics.

## 17) Acceptance Criteria (v1)
- Mention in new channel message starts thread-backed session and responds in-thread only.
- Mention in existing thread routes to same thread session.
- `/stop` interrupts in-flight loop per semantics above, without deleting session.
- `/delete` hard-deletes thread session data + attachments and recreates clean session path on next mention.
- Event stream persists all events immutably in JSONL order for each thread.
- Context builder enforces 50% token-budget sliding window with atomic tool-block trimming.
- Sandbox is per-session Docker, mTLS-protected API, kernel-enforced network block default.
- Unhandled errors appear in thread as separate message with stack trace and simple redaction.

## 18) Test Matrix (v1 Minimum)
- **Thread identity and storage**
  - deterministic `thread_key` derivation maps all events for one Slack thread into one directory.
- **Scheduling and batching**
  - concurrent mentions during active run are queued in order and executed in exactly one subsequent turn.
- **Stop behavior**
  - `/stop` during tool execution yields stopped terminal marker and no history deletion.
- **Delete behavior**
  - `/delete` removes history files, attachments, runtime checkpoint, and sandbox; next mention starts fresh.
- **Idempotency**
  - replayed Slack events do not duplicate history records or retrigger turns.
- **Recovery**
  - process crash during `running` results in interrupted status surfaced to Slack after restart scan.
- **Context trimming**
  - oldest-first sliding trim preserves atomic tool call/result groupings.
- **Attachment lifecycle**
  - attachment files are deleted on corresponding Slack delete events while JSONL audit trail remains.
