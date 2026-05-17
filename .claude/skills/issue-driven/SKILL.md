---
name: issue-driven
description: GitHub-issue-driven change workflow. Every non-trivial change starts with `gh issue create`; the implementation is then delegated to a subagent on a feature branch that opens a PR closing the issue. Issues double as long-term memory — closed phases, open gotchas, open proposals. Maintains a local ISSUES.md index. Invoke this when the user requests a change ("let's add X", "change Y to Z", "fix Z"). Skip for trivial edits.
---

# issue-driven

Goal: make GitHub issues the canonical place where change requests are specified, discussed, and remembered. Implementation happens on a feature branch driven by a subagent. The local `ISSUES.md` is the offline index — useful for fast recall without a `gh` round trip.

## When to invoke

**Use this for:**
- New features or tools
- Behavior changes (UX, defaults, schema)
- Refactors that change a core invariant
- Bug fixes whose root cause is non-obvious or whose context might recur
- Anything you'd want to find later by searching titles

**Skip for:**
- Typos, comment rewordings, formatter-only changes
- Reverting an unintended change made earlier in the session
- One-line config tweaks the user is doing right now interactively
- Direct edits the user explicitly says "just do it, no issue"

When in doubt, ask once via `AskUserQuestion` ("Create an issue for this?") and remember the answer for the session.

## Procedure

### 1. Draft the issue

Compose the body before creating. The body should answer:
- **Why** — the motivation (incident, gap, friction, follow-up from #NN)
- **What** — the proposed change in concrete terms
- **Scope / out-of-scope** — explicitly call out what this doesn't include
- **Notes** — open questions, alternatives considered, links to relevant code (`src/foo.ts:42`)

Title format: short and recall-friendly. The title is the search key. Examples:
- `Background sandbox warmup + lazy UI`
- `Socket Mode liveness watchdog`
- `Fix: WS tunnel must forward all sandbox endpoint headers`

Surface the draft via `AskUserQuestion` before creating — options: Apply as drafted / Edit before applying / Skip the issue.

### 2. Create the issue

```sh
gh issue create -R eladb/agenta \
  --title "<title>" \
  --label "<label>" \
  --body "$(cat <<'EOF'
<body>
EOF
)"
```

Pick the label:
- `phase` — only for substantive features that introduce new architecture or change a core invariant. Phase issues get a number (e.g. `Phase 26: ...`).
- `gotcha` — bugs, footguns, surprising behaviors discovered live.
- `proposed` — ideas / open questions / future work.
- `bug` / `enhancement` / `documentation` — fall back to GitHub defaults if none of the three fit.

Capture the issue number for the rest of the flow.

### 3. Spawn a subagent on a feature branch

Default to delegating the implementation. Don't do the work in the main session unless the user says "I'll just do it here".

```
Agent(
  subagent_type: "general-purpose",
  isolation: "worktree",
  description: "Implement #<NN>",
  prompt: "Implement the change spec'd in https://github.com/eladb/agenta/issues/<NN>.

  Steps:
  1. Read the issue body via `gh issue view <NN> -R eladb/agenta`. That's your spec.
  2. Create branch `issue-<NN>-<short-slug>` off main.
  3. Implement. Match the codebase conventions in CLAUDE.md (functional TypeScript, no classes in src/, biome, tests co-located).
  4. Run `bun test src` before committing — must be green.
  5. Commit with a **Conventional Commits** subject ending in `(#<NN>)` so GitHub auto-links. Format: `<type>(<scope>): <subject> (#<NN>)`. Types: feat, fix, docs, chore, refactor, test, perf, build, ci, style, revert. Do NOT include `Closes #<NN>` in commits (that goes on the PR).
  6. Push the branch and open a PR. The PR **title must also use Conventional Commits** (typically the same as the commit subject). PR body contains `Closes #<NN>` so merging closes the issue.
  7. Report the PR URL.

  Notes:
  - DO NOT run `bun run format` (biome rewrites unrelated files — see memory).
  - DO NOT touch CLAUDE.md unless the issue specifies a documentation change (the wrap-session skill handles docs).
  - DO NOT amend or force-push.
  - Use `pwd` to confirm worktree path; all paths must be relative to that root."
)
```

If the change is trivial enough to keep in this session (a one-line fix, a typo), still create the issue, commit with `(#NN)` in the main worktree, push, and open the PR yourself — but the default is delegate.

### 4. Keep the issue current

As the discussion evolves (new constraints, scope changes, alternatives chosen), update the issue body so a future reader sees the latest spec, not just the original draft. Use `gh issue edit <NN> -R eladb/agenta --body-file <path>` or pipe stdin.

Add comments for discrete decisions ("decided to use X over Y because Z"). Comments preserve history; body edits preserve currency.

### 5. After the PR merges

The merge closes the issue (via `Closes #<NN>` in the PR body). No manual close needed.

If the work uncovered new gotchas, file a follow-up `gotcha` issue with a back-reference (`Found while implementing #<NN>`). Don't bury it as a comment on the original — gotchas need to be findable on their own.

### 6. Refresh the local index

After any issue create / close / edit, run:

```sh
bun scripts/refresh-issues-index.ts
```

It rewrites `ISSUES.md` at the repo root. If anything actually changed, commit it (`docs(ISSUES): refresh index`). The `wrap-session` skill also calls this at the end of each session.

## Conventions

- **Conventional Commits is mandatory** for both commit subjects AND PR titles. Format: `<type>(<scope>): <subject> (#<NN>)`. Allowed types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `perf`, `build`, `ci`, `style`, `revert`. Scope is optional (use it when there's a clear area: `sandbox`, `SPEC`, `CLAUDE.md`, `slack`).
- **Issue numbers in commits**: always end the commit subject line with `(#<NN>)`. PR bodies should contain `Closes #<NN>` so the merge auto-closes.
- **Labels are exclusive**: an issue gets exactly one of `phase` / `gotcha` / `proposed`. GitHub default labels (`bug`, `enhancement`, `documentation`) can be added on top as descriptors.
- **One change request, one issue**. If a request grows new scope mid-flight, file a second issue for the new piece and reference it.
- **Don't open an issue retroactively** to "document" something that was committed without one. Leave history alone — the commit message and CLAUDE.md phase entry already serve that purpose. Backfill is a one-time migration, not an ongoing habit.

## Index file format

`ISSUES.md` lives at the repo root and is regenerated by the helper. Sections:

```
# Issues index

_Generated by scripts/refresh-issues-index.ts. Don't edit by hand._

## Open · gotcha (N)
- #12 — Socket Mode silent disconnect
- ...

## Open · proposed (N)
- ...

## Open · other (N)
- ...

## Closed · phase (N)
- #1 — Slack adapter (thin)
- ...

## Closed · other (N)
- ...
```

The titles are the recall surface; click through for the body.

## What NOT to do

- Don't open an issue for every micro-edit during an interactive session. The threshold is "would someone want to find this later by title?"
- Don't put implementation details in the title. The title is for recall; the body is for spec.
- Don't let the issue body and the PR description drift. The issue is the canonical spec; the PR description should say `Closes #NN` and briefly note anything PR-specific.
- Don't combine a `phase` and a `gotcha` in one issue. Phases are designed work; gotchas are discovered problems. Split them.
- Don't skip the subagent on real work just because it feels faster to do inline. The subagent isolation keeps the main thread's context clean and means the user can review the PR independently.
