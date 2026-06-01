---
name: github-auto-merge-wedge
description: "GitHub auto-merge can wedge when the legacy combined-status API returns `pending` even though check-runs are SUCCESS — fix is close + redo PR on a fresh branch."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: fcb8bb53-9c2f-4ca5-83b3-9382e86553c5
---

When a PR has auto-merge armed, `unit-tests` check-run is SUCCESS, branch is up to date, and `mergeable: true` — but `mergeStateStatus: BLOCKED` persists indefinitely and `gh pr merge --squash` rejects with "base branch policy prohibits the merge":

The cause is GitHub's legacy combined-statuses API (`GET /repos/.../commits/<sha>/status`) returning `state: "pending"` with zero statuses, because our CI publishes via check-runs (not the legacy statuses API). Auto-merge consults both, and the "pending with zero entries" never resolves. Saw this live on PR #160 (and earlier #155/#156 self-recovered after a delay; #160 didn't).

**Why:** This was a fresh GitHub-side quirk on 2026-05-22. The asymmetry between check-runs and combined-status APIs apparently changed how auto-merge gates. Slowly self-recovering for some PRs, hard-wedging others.

**How to apply:** If a PR is wedged for >10 min with all signals green, don't fight it — close the PR with a one-line note, push the same commit on a fresh branch off current `origin/main`, open a new PR, re-arm auto-merge. That cost ~3 min and reliably worked.

**Do NOT** try `gh pr merge --admin` to bypass — the Claude Code auto-classifier will (correctly) deny it as a branch-protection bypass that the CLAUDE.md ruleset explicitly forbids ("No bypass actors — applies to admins too").

Related: [[session-preservation-invariant]] (this happened during the same restart-safety arc).
