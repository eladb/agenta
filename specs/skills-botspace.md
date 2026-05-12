# Skills + botspace

Status: ready for subagent
Owner: parent session (Claude)
Branch: dispatched in worktree

## Goal

Replace the hard-coded system prompt with a "botspace" — a directory in the
repo that owns the bot's identity, rules, and a library of optional skills.
Each thread freezes a snapshot of the composed prompt at first mention.

This is the first half of the "agent platform" picture: it makes the prompt a
data artifact (editable in the repo, copy-able into the sandbox) rather than a
const string in `src/index.ts`.

## Locked design

### Layout

```
sandbox/botspace/
  BOT.md                       canonical "bot prompt" — identity, persona, rules
  skills/
    <skill-slug>/
      SKILL.md                 YAML frontmatter + freeform body
      <any other files>        scripts, fixtures, reference docs the skill ships
  <anything else>              freely shipped into /workspace as-is
```

- `sandbox/Dockerfile` gets a new line that copies `botspace/` into
  `/workspace/` so a fresh sandbox starts with the bot's files in place.
  The copy preserves the layout: the model reads a skill from
  `/workspace/skills/<slug>/SKILL.md` and `/workspace/BOT.md`.
- The Dockerfile already creates `/workspace` owned by uid 1000 in an earlier
  layer. The COPY must apply that ownership (`COPY --chown=sandbox:sandbox`).
  Verify with a fresh `docker run` test that `ls -la /workspace` shows uid 1000
  ownership on the copied files (the sandbox user must be able to read them).

### SKILL.md frontmatter

A standard YAML frontmatter block delimited by `---`:

```markdown
---
name: python-charts
description: Make charts with matplotlib + numpy. Outputs PNG suitable for share_file.
---

# Python charts

(body — instructions, examples, anything else the model needs once it loads
this skill)
```

Required keys: `name` (string), `description` (string).
Any other keys are passed through verbatim into the skills map (open extension).

### Skills map → JSON array

Walk `sandbox/botspace/skills/*/SKILL.md`. For each, parse only the frontmatter
(not the body) and emit an entry:

```json
[
  {
    "path": "skills/python-charts/SKILL.md",
    "name": "python-charts",
    "description": "Make charts with matplotlib + numpy. Outputs PNG ..."
  },
  ...
]
```

`path` is relative to `/workspace` (i.e. relative to the botspace root) so the
model can hand it directly to `read_file`. Stable ordering: sort entries by
`path` so the JSON is deterministic for tests.

Skills with malformed or missing frontmatter: log a warning and skip — do NOT
fail prompt construction. A single bad skill must not crash all threads.

### System prompt composition

```
[SYSTEM_PROMPT env, if set, separated by a blank line]
[BOT.md verbatim]

# Available skills

The following skills are available in this workspace. If a skill looks
relevant to a request, read its SKILL.md before proceeding so its
instructions are loaded into context.

<JSON array, pretty-printed with 2-space indent>
```

The "Available skills" header and instruction block are emitted by the prompt
builder, not by BOT.md — so BOT.md stays purely about identity/rules and the
skills mechanism is operationally consistent across bots.

If there are zero skills, omit the entire "Available skills" section (don't
emit an empty array — keeps the prompt clean for skill-less bots).

### Per-thread freeze + persistence

- Place: `data/{thread_key}/runtime.json`, schema extended.
- `idle` becomes a real persisted status (currently file = non-idle).
- `clearRuntime(threadKey)` no longer deletes the file when going idle; it
  rewrites it as `{status: "idle", updated_at, system_prompt}` so the prompt
  survives across turns.
- `/delete` still `rm -rf`s the thread dir — runtime.json goes with it.
- `recoverInterruptedSessions` filters on `status === 'running' | 'stopping'`,
  so idle entries don't trigger boot announcements.

Schema (new):

```ts
export type RuntimeState = {
  status: 'idle' | 'running' | 'stopping';
  updated_at: string;
  system_prompt?: string;  // present once the first turn has composed it
};
```

Backward compat: existing files in the wild only have `status:
running|stopping` and no `system_prompt`. Recovery's idle filter handles the
former; for the latter, on a thread with runtime.json but no `system_prompt`,
the handler treats it as "first mention" and composes + writes the prompt.

### Prompt resolution flow

In `handler.ts` for an incoming mention:

1. `readRuntime(tk)` — read existing state, if any.
2. If state exists and has `system_prompt`: use it.
3. Otherwise: compose via `buildSystemPrompt()`, persist as
   `{status: 'idle', updated_at: nowIso(), system_prompt: composed}`, use it.
4. Pass into `startOrQueue(web, callModel, prompt, input)`.

The state machine in `session.ts` already overwrites runtime.json on
running→stopping→idle transitions. Update those writes to preserve
`system_prompt` (read first, or thread it through as an argument). The
simplest is: `writeRuntime` callers pass `system_prompt`; `startOrQueue`
receives it and passes it through to each transition.

### Migration

- Move the multi-line default prompt (currently in `src/index.ts:33-44`)
  verbatim into `sandbox/botspace/BOT.md`. Keep the wording identical
  including the "File handling rules (strict)" block — small models depend on
  it.
- `src/index.ts` no longer builds a system prompt. It passes no prompt
  parameter to `makeEventHandler` (or passes `undefined` if cleaner). The
  handler owns prompt resolution per thread.
- `SYSTEM_PROMPT` env var changes semantics: it now **prepends** to BOT.md
  rather than **replacing** the default. Note this in CLAUDE.md.

### Ship one example skill

To prove the read-this-file flow works inside the sandbox e2e, ship one
skill:

```
sandbox/botspace/skills/python-charts/SKILL.md
```

Frontmatter `name: python-charts`, short description. Body: one paragraph
referencing the matplotlib/numpy already installed in the image. Doesn't need
to be long or perfect — its job is to be a load-target for tests.

## File-by-file change plan

### New

- `src/prompt.ts` — exports `buildSystemPrompt(botspaceDir?: string,
  envPrefix?: string): Promise<string>`. `botspaceDir` defaults to
  `process.env.BOTSPACE_DIR ?? join(process.cwd(), 'sandbox/botspace')`.
  `envPrefix` defaults to `process.env.SYSTEM_PROMPT`. Internally uses the
  `yaml` package to parse frontmatter; walks `skills/*/SKILL.md`; composes
  the final string per the spec above. Pure (no Slack/sandbox deps), unit
  testable.
- `src/prompt.test.ts` — unit tests.
- `sandbox/botspace/BOT.md` — migrated default prompt.
- `sandbox/botspace/skills/python-charts/SKILL.md` — example skill.

### Modified

- `package.json` — add `yaml` dep. Run `bun add yaml` in the worktree.
- `sandbox/Dockerfile` — add `COPY --chown=sandbox:sandbox botspace
  /workspace/` after the existing `mkdir/chown /workspace` line. The COPY
  source path is relative to the Dockerfile's context (which is
  `sandbox/` per existing usage). Verify with `bun scripts/...` or manual
  test that this works given how `ensureImage` invokes docker build.
- `src/runtime/runtime-store.ts` — extend `RuntimeState` schema; update
  `writeRuntime`/`readRuntime`/`clearRuntime` semantics; `clearRuntime` now
  writes idle state preserving system_prompt. `listRuntimes` still returns
  all entries; recovery filters.
- `src/runtime/recovery.ts` — filter to non-idle entries.
- `src/runtime/session.ts` — accept system prompt as an argument (already
  does); ensure all runtime writes carry the prompt forward (read existing
  state and merge, OR thread the prompt through `startOrQueue` and pass to
  every write). Choose whichever is simpler — both are correct.
- `src/runtime/handler.ts` — resolve per-thread prompt before
  `startOrQueue`. Stop accepting the `systemPrompt` parameter from
  `makeEventHandler` (or accept it as the env-prepend source only).
- `src/index.ts` — drop the const default prompt block. `makeEventHandler`
  signature updates accordingly.
- `CLAUDE.md` — add a Phase 13 (or similar) note about skills + botspace +
  per-thread frozen prompt + SYSTEM_PROMPT-now-prepends. Update the
  "Implementation state" list. Update the repo layout block to mention
  `sandbox/botspace/` and `src/prompt.ts`.

## Tests

### Unit (`src/prompt.test.ts`)

- BOT.md alone (no skills dir) → output = BOT.md verbatim.
- BOT.md + 2 skills with valid frontmatter → output contains BOT.md, the
  "Available skills" header, and a JSON array with 2 entries sorted by path.
- Skill with malformed frontmatter (e.g. no `name` key) → logged warning,
  skill skipped, other skills still emitted, no exception.
- Skill with extra frontmatter fields → those fields appear in the JSON entry.
- `SYSTEM_PROMPT` env (passed explicitly as arg) → prepended with a blank
  line separator, BOT.md follows.
- Skills with zero entries → no "Available skills" section in output.

Use a `mkdtempSync` botspace dir per test; clean up in afterEach. No
filesystem touches outside the temp dir.

### Unit (`src/runtime/runtime-store.test.ts` if it exists, else inline)

- `clearRuntime` preserves `system_prompt` across the running→idle
  transition.
- `listRuntimes` includes idle entries (recovery's responsibility to filter).
- `readRuntime` returns `idle` state correctly.

### E2E (`tests/e2e/skills.test.ts`)

Two mentions, same thread, model stubbed: the recorded `messages[0]` (the
system message) must be byte-identical across both calls. Edit BOT.md between
the two mentions and assert the system prompt has NOT changed for that thread
(frozen).

New thread after the edit: system prompt reflects the new BOT.md.

E2E (HAS_DOCKER-gated): start a turn that calls `read_file('skills/python-charts/SKILL.md')`
via a stubbed model script and assert the file content comes back. Skip this
test on machines without Docker (consistent with other Docker-gated tests).

E2E: `/delete` removes runtime.json (already exercised; just confirm the
existing test still passes given the new schema).

### Manual verification before declaring done

1. `bun run test` — all green.
2. `bun run lint` — biome clean.
3. `bun run typecheck` (or `tsc --noEmit` if no script) — clean.
4. `bun run e2e` — all green. If Docker is available locally, this covers the
   sandbox COPY too.
5. `git diff sandbox/Dockerfile` reads as one COPY line addition.
6. Spot-check that the composed prompt for an empty skills dir is identical to
   what `src/index.ts` used to emit (modulo the SYSTEM_PROMPT prepend
   semantics — which is now prepend, was replace, that's the only intentional
   behavior delta).

## Out of scope (do not implement)

- Cloning the botspace from a git repo — locked as "later", in
  `BOTSPACE_DIR` env style.
- Per-bot tool catalog (separate task).
- Multi-bot deployments / bot-id routing in Slack adapter (separate task).
- Hot-reloading SKILL.md changes mid-process (the prompt is per-thread frozen
  anyway; new threads will pick up changes on next bot restart, which is
  consistent with how Dockerfile changes work today).
- Validating SKILL.md body content against frontmatter — body is opaque to us.

## Worktree setup hint

Subagent should:

1. Read CLAUDE.md and this spec end-to-end first.
2. Skim the files in the "Modified" list before touching anything.
3. Make all changes on the worktree branch only; commit when green.
4. Run `bun run test`, `bun run lint`, `bun run e2e` before reporting done.
5. If a design decision arises that isn't covered here, STOP and report
   instead of guessing. Common forks to watch for: how to thread
   `system_prompt` through `session.ts` writes (read-merge vs.
   argument-passing); the exact docker build context root (test that the
   `COPY botspace /workspace/` line works given how `ensureImage` invokes
   build).

## Self-check before reporting done

- [ ] All tests pass (`bun run test`, `bun run e2e`).
- [ ] `bun run lint` clean.
- [ ] Typecheck clean.
- [ ] BOT.md content is byte-identical to the old default in `src/index.ts`
  (the migration is meant to be behavior-preserving for skill-less bots).
- [ ] `SYSTEM_PROMPT` env semantics documented in CLAUDE.md.
- [ ] A fresh sandbox container shows `/workspace/BOT.md` and
  `/workspace/skills/python-charts/SKILL.md` owned by uid 1000.
- [ ] Two mentions in one thread produce byte-identical system messages in
  the stubbed model calls (frozen-per-thread invariant verified).
- [ ] No reference to `botspace/` outside `sandbox/`, `src/prompt.ts`, and
  the spec/docs.
