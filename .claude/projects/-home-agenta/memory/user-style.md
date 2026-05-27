---
name: user-style
description: "Elad's collaboration preferences — surgical changes, plain URL formatting, dev-bot iteration loop, pause-for-review cadence."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 06a63e51-c045-44e3-97ec-bc5ff88c400c
---

Cumulative feedback from 2026-05-19/20 — none of this came in a single nudge, but the pattern is clear:

- **Plain URLs.** When posting an issue/PR link in chat, never bold (`**…**`) and never markdown link `[label](url)`. Just the raw URL on its own line. Terminal-style UIs render the asterisks literally.

  **Why:** he reads chat output in a terminal renderer where markdown bold becomes noise.
  **How to apply:** anywhere I print a github URL — issues, PRs, branch links. The `change-workflow` skill already encodes this in step 2.5.

- **Don't re-ask after forks are resolved.** If I already used `AskUserQuestion` to settle design choices before drafting an issue body, do NOT also surface the draft for an "approve/edit" round. The post-creation pause (step 2.5) is the canonical review surface.

  **Why:** redundant gate adds friction without new signal.
  **How to apply:** in `change-workflow` step 1, draft and create directly after forks are resolved; only pause once, post-creation.

- **Dev-bot test before auto-merge.** For meaningful feature PRs, offer to run `bun start` against the dev bot (now wired via `.env`) and iterate together in Slack before arming auto-merge. The change-workflow skill's step 3.5 implements this.

  **Why:** closes the CD feedback loop (~3 min round-trip → near-instant).
  **How to apply:** after subagent reports PR URL, ask via `AskUserQuestion`; skip for trivial doc/config changes.

- **Iteration is allowed and expected.** When pretty-mode UX took three PRs across one evening (#144 add per-tool sub-line → #145 strict replace, no stacking → #146 thinking beat), he was fine with it. Don't pre-optimize the spec to anticipate every variation; ship the first reasonable version and iterate from real usage.

  **How to apply:** prefer shipping one focused PR per refinement over a single big PR that tries to be perfect.

- **Concise responses.** Tight summaries beat verbose ones. End-of-turn = 1–2 sentences max.
