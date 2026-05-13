# Golden-run tests (deterministic record/replay model)

Status: ready for subagent
Owner: parent session (Claude)
Branch: dispatched in worktree

## Goal

Stand up a real-model regression suite. Today's e2e tests use
`stubCallModel` in `tests/e2e/helpers.ts` — it returns `stub: <last user text>`
which is deterministic but tests nothing about model behavior. Golden-run
tests capture real model output once, save it to disk, then replay it on
every run so CI catches behavior drift when we change tools, prompts, or
skills.

Out of scope: replacing the existing stub-based e2e tests. They still test
plumbing (event flow, persistence, attachments) without model variance.
Goldens are an additional layer that tests model-shaped behavior.

## Locked design

### Recording scope: model API only

Only the OpenAI-compatible `/chat/completions` request → response is
recorded. Sandbox HTTP, Slack API, persistence all run live during replay —
same external dependencies as today's e2e. This keeps recordings small and
focused on the thing that actually varies non-deterministically (the model).

### Match strategy: positional

Each test owns an ordered list of (request, response) pairs. The Nth model
call in the test gets the Nth recorded response. If the test's model-call
count drifts from the recording, the test fails with a clear error
identifying the index of the mismatch. Test ordering doesn't matter (each
test owns its own file); only within-test call ordering does.

### File layout: one JSONL per test

```
tests/golden/<test-file>/<test-name>.jsonl
```

For example, `tests/golden/skills/loads-the-python-charts-skill.jsonl`.
Format: one JSON object per line, each:

```json
{ "request": { /* full chat/completions body */ },
  "response": { /* full chat/completions response */ } }
```

Stored as JSONL so a single record is easy to inspect; the array as a whole
is implicit. Sort key inside the directory: test name kebab-cased.

### Recording trigger: auto-record on missing, CI guards

- **Replay (default, no env):** read the golden file, return responses
  positionally. Missing file in replay mode → throw a clear error
  ("golden file not found; running outside CI, will record next time").
- **Record (auto, file missing, not CI):** call the real model via the
  underlying CallModel, capture each (request, response) pair, write the
  file at end of test. Subsequent runs replay.
- **CI guard:** if `process.env.CI` is set and the golden file is missing,
  fail with a strict error ("golden file missing in CI: <path> — run the
  test locally first to record"). Never auto-record in CI.

The `MODEL_API_KEY` env var is required for recording (a real call must
fire). Replay needs no API key.

### Architecture

New module `src/model/golden.ts` exports:

```ts
export function withGolden(
  inner: CallModel,
  goldenPath: string,
): { callModel: CallModel; flush: () => Promise<void> };
```

- Wraps a real `CallModel`.
- In replay mode: ignores `inner`, returns recorded responses positionally.
- In record mode: forwards each call to `inner`, captures
  (request, response), buffers in memory until `flush()` writes the JSONL.
- Mode is decided at construction by reading the file. File missing + CI =
  throws (won't construct). File missing + non-CI = record mode. File
  present = replay mode.

New `tests/e2e/helpers.ts` helper: `createGoldenCallModel(testFile,
testName): CallModel`. Resolves the golden path; constructs `withGolden`;
returns the `callModel`. Tests use it in place of `stubCallModel`.

Lifecycle (record mode): the helper must trigger `flush()` after the test
body. Two options for the subagent to choose:
- Register an `afterEach` hook from the helper (cleanest, automatic).
- Return `{callModel, flush}` from the helper and require the test to
  call flush explicitly (more boilerplate but explicit).

Subagent picks; whichever is cleaner with `bun:test`'s lifecycle hooks.

### Determinism within a single recording

The model is non-deterministic; even with `temperature: 0` two calls can
diverge. The recording captures one *sample* of model behavior; the test
asserts on that sample's downstream effects (JSONL state, Slack messages,
sandbox file state, etc.). When the test's user input changes, re-record.

The replay must NOT re-validate the request body against the recording —
if it did, every prompt tweak would force re-recording. We only check that
*the request count matches* and return the recorded response positionally.
The request body changing is fine; the test will pass or fail on its own
assertions about downstream effects.

### Existing stub-based e2e tests stay

`stubCallModel` in `tests/e2e/helpers.ts` is not removed. It's still useful
for tests that exercise plumbing (event flow, persistence, attachments)
where the model's content doesn't matter. Goldens are an additional layer.

## File-by-file change plan

### New

- `src/model/golden.ts` — the recorder/replayer module.
  `withGolden(inner, goldenPath)` returns `{callModel, flush}`. Reads the
  golden file on construction; chooses mode; the returned `callModel`
  routes to replay or record paths accordingly.
- `src/model/golden.test.ts` — unit tests for the module:
  - Replay returns recorded responses positionally.
  - Replay throws when call count exceeds recording length.
  - Record mode calls `inner` and buffers; `flush` writes the JSONL.
  - Missing file + `CI=true` throws (mock `process.env.CI`).
  - Missing file + no CI returns a record-mode CallModel.
  - File-present mode never calls `inner` (regression: belt-and-suspenders
    so a flaky test can't accidentally hit the real model in CI).
- `tests/e2e/skills-golden.test.ts` — first real golden test as a worked
  example. Use the python-charts skill as the scenario:
  1. Mention the bot with a request that should trigger reading
     `skills/python-charts/SKILL.md` (e.g. "make a quick chart").
  2. Assert: the bot reads the skill file (check JSONL or tool-call
     history), uses bash to produce a PNG, calls share_file, and the
     final reply doesn't restate the filename (verify file-handling
     rules took effect).

  This is the proof-the-system-works test. It exercises:
  - skills loading
  - sandbox + bash
  - share_file
  - file-handling rules in the system prompt

  Golden file lives at `tests/golden/skills-golden/loads-and-uses-python-charts.jsonl`.

  Use `createGoldenCallModel` to wrap the real gateway.

- `tests/golden/skills-golden/loads-and-uses-python-charts.jsonl` —
  recorded by running the test once locally. Committed to the repo.

### Modified

- `tests/e2e/helpers.ts` — add `createGoldenCallModel(testFile, testName)`.
  Does NOT remove `stubCallModel`. Imports from `src/model/golden.ts`.
- `package.json` — no new dependencies (golden module uses built-in
  `node:fs/promises` only). If the subagent ends up wanting a JSON-diff
  library for nicer assertion messages, that's optional and they should
  pick something small (e.g. `microdiff`).
- `.gitignore` — confirm `tests/golden/` is NOT ignored. (It isn't today;
  this is a sanity-check item, not a code change.)
- `CLAUDE.md` — add a Phase 15 note about goldens + the
  record/replay/CI-guard semantics. Add `tests/golden/` to the repo
  layout block.

## Tests

### Unit (`src/model/golden.test.ts`)

Listed under "New" above. Use `mkdtempSync` for golden paths in tests so
they don't pollute the real `tests/golden/` dir. Stub `inner` as a function
that returns a deterministic `ModelResponse`.

### E2E (the worked example)

The one test described above. Recording it requires:
- `MODEL_API_KEY` env var set
- Slack tester credentials (same as today's e2e)
- A live Slack channel + sandbox image

Subagent should record the golden file as part of completing this task
(run the test once with the file missing) and commit the recording. The
file should be ~5-20 KB.

If the production agent on pid 67445 is still consuming Slack events when
the subagent runs the test, the test will fail to receive a reply — that's
the environmental flake, not a bug. The subagent should mention the
production agent in the report and either:
- Ask the parent session to stop it before recording, OR
- Skip recording, note that the helper module is fully unit-tested, and
  let the parent session record after merging.

Both are valid; the helper module's correctness can be fully verified
via unit tests.

### Manual verification before declaring done

1. `bun run test` — all green (with new unit tests).
2. `bun run lint` — clean for new/touched files.
3. `tsc --noEmit` — clean.
4. `bun run e2e` — all green except the documented Slack flakes.
5. Delete `tests/golden/skills-golden/loads-and-uses-python-charts.jsonl`
   locally, run the e2e test → it should auto-record. Re-run → should
   replay successfully. Set `CI=true` and delete the file → should fail
   loudly.

## Out of scope

- Recording sandbox HTTP or Slack APIs.
- Migrating existing stub-based e2e tests to goldens.
- Tool-level golden tests (we already have model-level coverage).
- A `bun run record-goldens` batch script (auto-record on missing file
  covers the use case).
- A UI / report for golden file diffs when re-recording (commit the diff;
  PR review handles it).

## Open questions to NOT decide silently

Stop and report if any of these come up:

- Where to fire `flush()` (`afterEach` hook vs. explicit). Pick whichever
  fits `bun:test` cleanly. If neither feels right, ask.
- What to do if `inner`'s call signature changes between record and replay
  (e.g. a new `options` field on `CallModel`). The current `CallModel`
  type is `(messages, options) => Promise<ModelResponse>` — straightforward
  to record. If the signature gets richer mid-task, ask.
- Whether to add a request-count assertion at the *end* of replay (catch
  cases where the test made fewer calls than the recording). Default:
  do it, fail with a clear message. If this becomes annoying, revisit.

## Self-check before reporting done

- [ ] All unit tests pass (`bun run test`).
- [ ] `bun run lint` clean for files I touched.
- [ ] Typecheck clean.
- [ ] Worked-example test exists and passes in replay mode.
- [ ] Either the golden file is committed and the test passes in replay,
  OR the helper is fully unit-tested and the recording is deferred to the
  parent session (clearly stated in the report).
- [ ] CI=true + missing file → strict failure path verified (unit test).
- [ ] No regression in existing stub-based e2e tests.
- [ ] CLAUDE.md updated.

## Worktree setup hint

1. Read CLAUDE.md and this spec end-to-end.
2. Skim `src/model/gateway.ts` and `tests/e2e/helpers.ts` (the
   `stubCallModel` helper) before writing the golden module — the
   `CallModel` shape and how e2e wires it.
3. Sandbox-persistence landed in `7ae6b9d`; your worktree should be at or
   after that.
4. Run unit + lint + typecheck before e2e. E2E is environmentally flaky
   due to Slack token sharing — note flakes; do not try to fix Slack.
