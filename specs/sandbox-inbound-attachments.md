# Spec: Inbound Slack attachments → sandbox `/workspace`

## Goal

When a user uploads files in a Slack thread (CSV, image, PDF, archive,
anything), the bot should make those files available inside the per-thread
sandbox at `/workspace/attachments/<unique>` so the model can `read_file` /
`grep` / `bash` over them without the user having to re-upload anything.

Today the files are downloaded to `data/{thread_key}/attachments/` and
optionally projected to vision-capable models as `image_url` content parts.
They never reach the sandbox filesystem.

## User-facing behavior

1. User uploads `customers.csv` in a thread, mentions `@agenta` with
   `summarize the file please`.
2. The bot runs as today, but on the first sandbox-touching tool call in
   that turn, syncs the ingested files into the sandbox.
3. The model's view of the user's message now ends with
   `[attached: attachments/F0123-customers.csv]` so it knows the path.
4. The model issues `read_file path=attachments/F0123-customers.csv` and
   gets the contents.

## Design decisions (locked)

- **Sync timing: lazy.** First sandbox-touching tool call in the turn
  triggers the sync (after `ensureContainer` succeeds). Mentions that never
  use the sandbox don't pay for the sync.
- **Path layout: `/workspace/attachments/<file_id>-<safe_filename>`.**
  Always unique via Slack file_id prefix. Mirrors the existing local
  `data/{tk}/attachments/{file_id}-{name}` naming so paths are easy to
  reason about end-to-end.
- **Filter: all ingested files.** Don't filter by MIME — if it's in
  `data/{tk}/attachments/`, it gets synced.
- **Discovery hint:** `context.ts:buildMessages` appends
  `[attached: attachments/<file_id>-<name>]` to the user message text for
  every file on that message. Hint is in plain text so non-vision models
  see it too; vision models still get the `image_url` content part for
  images on top.
- **Idempotency.** Re-syncing is safe (writes overwrite). Track which
  files have been synced per thread in process memory so we don't churn
  on every sandbox tool call; reset on bot restart (a fresh sandbox needs
  a fresh sync anyway since workspace is ephemeral).

## File-by-file changes

### `sandbox/server/server.ts`
- New endpoint **`POST /write_binary`** with body `{ path, content_b64 }`.
  Decodes base64, mkdir's the parent, writes to the resolved workspace
  path. Mirrors `/write` but accepts arbitrary bytes. Same auth header.
- Update the comment block at the top to list the new endpoint.

### `src/sandbox/index.ts`
- New `writeBinary(threadKey, path, data: Buffer, signal?)` HTTP client
  that POSTs `{ path, content_b64: data.toString('base64') }` to
  `/write_binary` and returns `DockerResult`.
- New `syncAttachmentsToSandbox(threadKey): Promise<{ synced: number }>`:
  1. List `data/{tk}/attachments/` (use `node:fs/promises.readdir`).
  2. For each file not already in the per-thread "synced" set, read its
     bytes from disk and `writeBinary` to
     `attachments/<basename>` (basename already has `file_id-name` form).
  3. Track synced filenames in a module-level `Map<threadKey, Set<string>>`.
  4. Returns the count newly synced (for logging).
  - Cleared on `removeContainer(threadKey)` and on `killAllSandboxContainers()`.

### `src/runtime/turn.ts`
- In the per-tool loop, immediately after the existing
  `ensureContainer` provisioning block (i.e. after the bullet has been
  mutated to "✅ workspace ready" or after an existing-ready bypass),
  call `syncAttachmentsToSandbox(threadKey)`. If it returns
  `synced > 0`, push a checklist line
  `• synced N attachment(s) to workspace` (no emoji per project style).
  Sync failures are logged as a warning and don't block the tool — the
  tool will surface its own error if it can't find the expected path.

### `src/model/context.ts`
- In `buildMessages`, when the slack `message` event has `files`, append
  one suffix per file to the user message text:
  `[attached: attachments/<file_id>-<safeName>]`. This applies whether
  the content is a string or a multipart array (in the multipart case,
  modify the first text part if any, otherwise prepend a new text part).
- `<safeName>` matches `attachments.ts:sanitize` already used in
  `downloadFiles` — re-use that helper (export it if needed).

### `src/sandbox/docker.ts` and `src/sandbox/fly.ts`
- No changes. The new HTTP client + endpoint work uniformly through
  whichever provider is active.

## Acceptance criteria

- The unit tests below pass.
- The e2e test below passes against the docker provider.
- After uploading a text file in a Slack thread and mentioning the bot
  with "read the file", the model's tool call resolves with the file's
  contents.
- Mentions that don't use a sandbox tool still pay zero sync cost.

## Test plan

### Unit
- `src/sandbox/inbound-attachments.test.ts` (new):
  - Stub `globalThis.fetch` for the sandbox HTTP. Pre-populate
    `data/{tk}/attachments/{fileId}-foo.txt` on disk.
    `syncAttachmentsToSandbox('tk')` should issue exactly one
    `POST /write_binary` with the right path + base64 body. Calling
    again should be a no-op (`synced: 0`).
- `src/model/context.test.ts` (extend):
  - A slack `message` event with two files appends two
    `[attached: …]` lines to the user message text.
  - Files on a multipart user message (with an existing text part) get
    the suffix appended to that text part, not as a new part.
- `src/sandbox/docker.test.ts` (extend):
  - `consumeExecStream` unaffected; no test changes needed here, but
    add one for the new `writeBinary` shape (mock fetch).

### E2E (`tests/e2e/inbound-attachments.test.ts`, new, HAS_DOCKER-gated)
1. `setupTempDataDir`, `startAgent(scriptedCallModel)`, `startTester`.
2. Tester creates a new thread by uploading a small `.txt` file with a
   mention `@agenta read the file I sent`. Capture `threadTs`.
3. Scripted `callModel` returns a `bash` tool_call:
   `bash command=cat attachments/<file_id>-<name>`.
4. Then a final reply: `done`.
5. Assert:
   - The bash tool_result contains the file's exact contents.
   - The first call's `messages` array shows the user message text
     ending with `[attached: attachments/<file_id>-<name>]`.
   - The thread's JSONL has a slack `message` event with
     `files[].local_path` pointing under `attachments/`.
6. `deleteThread` cleanup (existing helper already removes the
   container too).

A second test using `write_file` + the inbound file should NOT exercise;
keep this focused on read-side.

## Out of scope

- File size caps inside the sandbox (rely on Slack's existing file size
  for uploads + the existing 25 MB share_file cap as the natural limit).
- Per-thread persistence of the synced set across bot restarts —
  workspaces are ephemeral on Fly and on Docker the next restart
  rebuilds anyway.
- "Re-sync if user edits / replaces a file" — Slack edits to files are
  rare and out of the main path.
- Auto-discovery for vision-capable image attachments beyond the existing
  `image_url` projection (untouched here).

## Subagent self-check before reporting done

- `bun run lint` clean (no new warnings).
- `bunx tsc --noEmit` clean.
- `bun run test` passes (~165 unit, all green).
- `bun run e2e` passes against docker (~28+ e2e, all green; the new test
  adds one).
- Image rebuild needed because the server gained `/write_binary`:
  `docker rmi agenta-sandbox:latest && docker build -t agenta-sandbox:latest sandbox/`.
- Commit message: `feat(sandbox): sync inbound Slack attachments into /workspace`.

## Worktree setup hints (subagent)

- The worktree won't have `.env` (it's gitignored). Before running e2e:
  `cp ../<original-repo-root>/.env ./.env` so Slack/model tokens are
  loaded by Bun.
- The local Docker daemon must be running for e2e. If not, skip e2e
  and note it in the final report.
