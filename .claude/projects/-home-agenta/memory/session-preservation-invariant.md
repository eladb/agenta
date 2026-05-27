---
name: session-preservation-invariant
description: "When adding a new field to `SessionState`, MUST preserve it across every `writeSession` call site or it silently disappears each turn. The four-site pattern."
metadata: 
  node_type: memory
  type: project
  originSessionId: 06a63e51-c045-44e3-97ec-bc5ff88c400c
---

Today's #135 was caused by exactly this: handler.ts's #128 backfill called `setModel(tk, ...)` correctly, but `session.ts:startOrQueue`'s idle→running `writeSession({...})` didn't include `model` in the spread — so every turn dropped the freshly-saved field on the floor. Same pattern almost bit `display` in #141; PR #142 caught it.

**Why:** session.json has historically grown one field at a time (`system_prompt`, `sandbox`, `git`, `home`, `model`, `display`). Each new field must be explicitly mentioned in EVERY writeSession call. The harness has no "preserve-all-known-fields" helper.

**How to apply:** when adding a `SessionState.<X>?` field, grep `writeSession\(` and patch every match. There are currently three (system_prompt was removed in #188):

1. `src/runtime/session.ts:startOrQueue` — idle→running flip
2. `src/runtime/session.ts:startOrQueue` — in-loop re-flip (after `s.pending`)
3. `src/runtime/session.ts:signalStop` — running→stopping

(`clearSession` reads existing + re-spreads all known fields automatically.)

Pattern at each site:
```ts
...(prior?.<X> !== undefined ? { <X>: prior.<X> } : {}),
```

If you forget one, the field is gone after the next status transition and the bug is hard to spot (the in-memory state for the current turn still has it; only the persisted state is missing). The fix is mechanical; the cost of missing it is hours of debug like today's "JSON Parse error" hunt.

A safer long-term refactor would be `writeSession(tk, { status, updated_at, ...prior, ...overrides })` so preservation is the default and overrides are explicit — but nobody's filed that yet. Worth proposing if a future field bites the same way.

Related: [[debug-thread]] inspects session.json directly — that's how today's missing-`model`-field was first caught.
