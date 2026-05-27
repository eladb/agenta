---
name: cd-e2e-chronic-flakes
description: agenta CD is chronically flaky on e2e; expect serial whack-a-mole when CD red — each fix surfaces the next failure underneath.
metadata: 
  node_type: memory
  type: project
  originSessionId: fcb8bb53-9c2f-4ca5-83b3-9382e86553c5
---

agenta's CD pipeline (`.github/workflows/cd.yml`) runs e2e + deploy + canary post-merge only. Branch protection requires just `unit-tests` on PRs, so e2e regressions land freely. CLAUDE.md flags this asymmetry, but the experience on a CD-red streak is worth knowing in advance:

When CD is red, every fresh fix that lands tends to surface another flake underneath. On 2026-05-22 I shipped six fixes in one streak — each merge fixed one named failure and exposed a different one:

- #157 (45s waitForReply/waitFor defaults) — fixed `skills.test.ts /delete` 20s timeout.
- #159 / #161 (`test.skipIf(!ENABLED)`) — fixed `skills-golden tester.web undefined` crash on Fly.
- #162 / #164 (120s hook timeouts + `safeShutdown`) — fixed `asks.test.ts beforeAll 60s` timeout + secondary `agent.socket undefined`.
- #165 / #166 (restructure test setup) — fixed `restart-resume.test.ts` parent-context pollution.
- Filed #163 (`dedupe.json ENOENT` race at shutdown — logs-only, not blocking).

**Why:** Multiple independent flakes were silently red for ~100 CD runs (doc-only PRs skip e2e and read as green, masking it). The first non-doc PR that ran e2e in a while exposed the whole queue.

**How to apply:**
- Don't be surprised when each CD fix unblocks the next failure. Expect 3–5 rounds.
- Each named flake should get its own gotcha issue + small focused PR, not one mega-cleanup.
- Prod is unaffected during these streaks — CD fail-stops at e2e, so deploy + canary don't run, prod keeps running the last successful commit. Don't panic-merge.
- The dev-bot test step in `change-workflow` is optional and was always skipped during this streak — totally fine for test-only PRs.
- `tools.test.ts tool_call + tool_result` test hit 45s waitForReply in CD #64 even after #157's bump — there's still slack in the timeout floor. May need another bump or per-test override eventually.

Related: [[socket-mode-redelivery]], [[github-auto-merge-wedge]].
