---
name: change-workflow
description: GitHub-issue-driven change workflow. Every non-trivial change starts with `gh issue create`; the implementation is then delegated to a subagent on a feature branch that opens a PR closing the issue. Issues double as long-term memory — closed phases, open gotchas, open proposals. Invoke this when the user requests a change ("let's add X", "change Y to Z", "fix Z"). Skip for trivial edits.
---

# change-workflow

Goal: make GitHub issues the canonical place where change requests are specified, discussed, and remembered. Implementation happens on a feature branch driven by a subagent. When you need to look up issues, query GitHub directly with `gh` (see "Looking up issues" below) — there is no local index to keep in sync.

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
- Small, self-contained changes the user clearly wants applied now — a new short CI workflow, a single-file script, a tweaked Dockerfile line, a `.gitignore` entry, a one-step PR fixing the obvious thing. If a future reader wouldn't gain anything from a long-form spec beyond the diff + PR description, skip the issue.
- Direct edits the user explicitly says "just do it, no issue"

The default for small, obviously-scoped changes is: skip the issue, make the change directly on a branch, open a PR with a clear description, enable auto-merge. Reach for an issue when there's spec/discussion worth preserving — alternatives considered, scope debates, future-reader context that won't fit in a PR body.

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

If there are genuine design forks the user hasn't already weighed in on (provider choice, scope of phase 1, persistence strategy, etc.), resolve them via `AskUserQuestion` BEFORE drafting the body. Once forks are resolved, just create the issue — don't ask the user to approve a draft they've effectively already specified. The post-creation pause in step 2.5 is where they get to see the result and push back.

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

### 2.5. Post the link and pause for feedback

Before delegating, surface the freshly-created issue URL to the user and ask if they have comments or changes. Use `AskUserQuestion` with options like "Looks good, proceed" / "I have comments" / "Cancel". Do NOT spawn the subagent until the user confirms — they may want to edit the body, narrow scope, or kill the idea entirely now that they see it in GitHub.

Print the URL plain — no markdown bold (no `**…**`), no link syntax. Just the raw `https://github.com/eladb/agenta/issues/<NN>` on its own line. Slack-style users read these in the terminal and the asterisks render as literal asterisks there.

If the user provides comments, update the issue body (`gh issue edit <NN> -R eladb/agenta --body-file -`) before delegating. The issue is the canonical spec — the subagent will read it, not this conversation.

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
  - DO NOT enable auto-merge. The main session arms it after an optional local test pass against the dev bot — see the change-workflow skill's step 3.5.
  - DO NOT run `bun run format` (biome rewrites unrelated files — see memory).
  - DO NOT touch CLAUDE.md unless the issue specifies a documentation change (the wrap-session skill handles docs).
  - DO NOT amend or force-push.
  - Use `pwd` to confirm worktree path; all paths must be relative to that root."
)
```

### 3.5. Optional: test against the dev bot before arming auto-merge

After the subagent reports the PR URL, ask the user whether they want to try the change live against the dev bot (`agenta-dev`, A0B5ZQ802F2) before the PR auto-merges. Use `AskUserQuestion` with options like "Yes, let's try it" / "Skip — just merge" / "Show me the diff first".

If the user wants to test:
1. Fetch the branch into the main repo: `git fetch origin <branch>` then `git checkout <branch>` (or `git worktree add` if the main checkout has dirty state you can't lose).
2. Start the dev bot in the background: `bun start` via `Bash run_in_background: true`. On the claude-agents host, `.env` is wired to the dev bot (agenta-dev). The bot acquires the `'agent'` lockfile; only one of `bun start` / `bun run e2e` can run at a time on this host.
3. Tell the user the dev bot user is `@agenta-dev` (U0B596TUNTW) and pick a channel both the dev bot and they are in. Wait for their feedback.
4. Iterate: if they spot a bug, edit the code on the branch, commit + push, the dev bot will need a restart (kill the background process via `kill -9 <pid>` then start a new one) to pick up changes. SIGTERM via `pkill -f "bun.*src/index"` sometimes doesn't take — go straight to `kill -9` after one polite attempt. If the issue spec needs to change, update it via `gh issue edit` and consider re-delegating.
5. When they say "looks good", stop the background dev bot (kill the process — DON'T close the chrome browser or other shared services), check out main locally, then arm auto-merge:
   `gh pr merge <PR#> -R eladb/agenta --auto --squash --delete-branch`

If the user skips testing, arm auto-merge immediately:
`gh pr merge <PR#> -R eladb/agenta --auto --squash --delete-branch`

Auto-merge from here behaves exactly as before — PR lands when branch protection's `unit-tests` check passes.

If the change is trivial enough to keep in this session (a one-line fix, a typo), still create the issue, commit with `(#NN)` in the main worktree, push, open the PR, and `gh pr merge <N> --auto --squash --delete-branch` so it lands on green — but the default is delegate.

### 4. Keep the issue current

As the discussion evolves (new constraints, scope changes, alternatives chosen), update the issue body so a future reader sees the latest spec, not just the original draft. Use `gh issue edit <NN> -R eladb/agenta --body-file <path>` or pipe stdin.

Add comments for discrete decisions ("decided to use X over Y because Z"). Comments preserve history; body edits preserve currency.

### 5. After the PR merges

The merge closes the issue (via `Closes #<NN>` in the PR body). No manual close needed.

If the work uncovered new gotchas, file a follow-up `gotcha` issue with a back-reference (`Found while implementing #<NN>`). Don't bury it as a comment on the original — gotchas need to be findable on their own.

### 6. Looking up issues

There is no local index — query GitHub directly:

```sh
# All open gotchas
gh issue list -R eladb/agenta --label gotcha

# All open proposals (the backlog)
gh issue list -R eladb/agenta --label proposed

# All shipped phases
gh issue list -R eladb/agenta --label phase --state closed

# Read a specific issue's body
gh issue view <NN> -R eladb/agenta

# Search titles
gh issue list -R eladb/agenta --state all --search "socket mode"
```

`gh` returns canonical state — no drift, no refresh chore.

## Conventions

- **Conventional Commits is mandatory** for both commit subjects AND PR titles. Format: `<type>(<scope>): <subject> (#<NN>)`. Allowed types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `perf`, `build`, `ci`, `style`, `revert`. Scope is optional (use it when there's a clear area: `sandbox`, `SPEC`, `CLAUDE.md`, `slack`).
- **Issue numbers in commits**: always end the commit subject line with `(#<NN>)`. PR bodies should contain `Closes #<NN>` so the merge auto-closes.
- **Labels are exclusive**: an issue gets exactly one of `phase` / `gotcha` / `proposed`. GitHub default labels (`bug`, `enhancement`, `documentation`) can be added on top as descriptors.
- **One change request, one issue**. If a request grows new scope mid-flight, file a second issue for the new piece and reference it.
- **Don't open an issue retroactively** to "document" something that was committed without one. Leave history alone — the commit message and CLAUDE.md phase entry already serve that purpose. Backfill is a one-time migration, not an ongoing habit.
- **Auto-merge is the default, but armed by the main session, not the subagent.** Step 3.5 inserts an optional local-test pass against the dev bot before arming. If the user skips the test, arm immediately after the subagent reports the PR. Skip auto-merge entirely ONLY when the user has said something like "let me review this one first" or the change is unusually risky (irreversible migration, scope-creeping refactor).

## What NOT to do

- Don't open an issue for every micro-edit during an interactive session. The threshold is "would someone want to find this later by title?"
- Don't put implementation details in the title. The title is for recall; the body is for spec.
- Don't let the issue body and the PR description drift. The issue is the canonical spec; the PR description should say `Closes #NN` and briefly note anything PR-specific.
- Don't combine a `phase` and a `gotcha` in one issue. Phases are designed work; gotchas are discovered problems. Split them.
- Don't skip the subagent on real work just because it feels faster to do inline. The subagent isolation keeps the main thread's context clean and means the user can review the PR independently.
