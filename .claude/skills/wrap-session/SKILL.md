---
name: wrap-session
description: End-of-session documentation pass. Walks recent commits, identifies what's missing from CLAUDE.md and memory, drafts updates, surfaces each via AskUserQuestion before writing. Invoke via /wrap-session before clearing context. Useful before /clear so the next Claude instance picks up where this one left off.
---

# Wrap-session

Goal: leave the project in a state where a fresh Claude (post-`/clear`) can pick up exactly where the current one left off. That means **CLAUDE.md** (project-state, code, ops) and **memory/** (cross-session collaboration patterns) are caught up to whatever this session accomplished.

## Procedure

### 1. Establish the baseline

Find the commit range that defines "this session":
- Default: `git log --since="24 hours ago" --oneline`
- If the user has been working multi-day: ask them. Reference any `pre-*` or `session-*` tags as candidates.
- Show the commit list to the user; confirm the range covers what they consider "this session".

### 2. Survey what's already documented

Read these in parallel:
- `CLAUDE.md` — note the section structure (look for `### Implementation state (current)`, `### Known issues`, `### Env vars`, `### Repo layout`, `### Running things`, `### Production runtime notes`)
- `~/.claude/projects/-Users-bensadeh-agenta/memory/MEMORY.md` and the files it references
- The CLAUDE.md should already contain phase entries (numbered list under "Implementation state"). The highest existing number is your baseline; new phases continue from there.

### 3. Classify each commit

For each commit in the session range, decide which (if any) of these it produces an update for:

- **New phase entry in CLAUDE.md** — only for substantive features that introduce new architecture or change a core invariant. Bug fixes, test fixes, prompt edits don't get their own phase; they ride along in the phase entry they belong to, or in "Known issues".
- **Known issues / gotchas** — anything that bit us live during the session (silent failures, footguns, surprising defaults, infra quirks). Be concrete: state the symptom, the cause, the workaround.
- **Production runtime notes** — changes to env vars, paths, deploy scripts, app scopes, runbook procedures.
- **Memory entry** — cross-session collaboration patterns. NOT project facts (those go in CLAUDE.md). Examples that warrant memory: a recurring failure mode in subagent briefing, a preference the user expressed for how to surface decisions, a hard lesson about a tool's behavior. Keep these terse and link them with `[[other-memory-slug]]` references.

If a commit doesn't fit any of these, it doesn't need documentation. Trust the commit message — it's already in `git log`.

### 4. Draft inline + surface via AskUserQuestion

For each proposed update, draft the actual text (don't make the user write it). Then present via `AskUserQuestion` with options:
- "Apply as drafted"
- "Edit before applying" (user provides edits inline)
- "Skip"

Batch related proposals into a single question where possible — but if any are heavyweight (a whole new phase entry), give it its own question so the user can read carefully.

### 5. Apply approved edits

- Use `Edit` for surgical changes; never overwrite CLAUDE.md wholesale.
- Memory files: use `Write` to create new ones; update `MEMORY.md` index with a one-line `- [Title](file.md) — hook` entry per new file.
- Commit CLAUDE.md as `docs(CLAUDE.md): <one-line summary>` with a body listing the sections touched. Memory files don't get committed — they're outside the repo.

### 6. Optional: tag HEAD

If the session represents a meaningful milestone (multi-phase work, big refactor, before/after a destabilizing change), suggest tagging HEAD as `session-<YYYYMMDD>` or `pre-<next-thing>`. Ask before tagging.

## What NOT to do

- **Don't** unilaterally decide what's "worth" documenting. The user's judgment about what to preserve is better than yours; surface, don't filter.
- **Don't** propose memory entries that duplicate CLAUDE.md content. Memory is for cross-session lessons that don't fit in project-state docs.
- **Don't** run `bun run format` or any tool that produces noise outside the session's actual changes.
- **Don't** auto-commit. The CLAUDE.md commit is the only commit this skill should produce, and it should reflect approved edits only.
- **Don't** write a session summary unless asked. The commits themselves are the record; double-summarizing creates churn.

## When to invoke this skill

Right before `/clear` at the end of a substantive session. Quick chats, one-off questions, or sessions that produced no commits don't need it — there's nothing to document.
