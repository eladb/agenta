---
name: bedrock-translation-gotcha
description: Bedrock (Anthropic Messages API) has two strict shape rules — tool_result before user text in the same turn, and no trailing assistant message (no prefill support). translateToBedrock must enforce both.
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 268efc8b-02cc-4c15-9a3a-0152b3289ba2
---

Bedrock (Anthropic Messages API on AWS) has two shape rules the OpenAI-format → Anthropic translator must enforce. Both rules live in `src/model/gateway.ts:translateToBedrock`:

### Rule 1 — tool_result must come BEFORE user text in the same turn (#192, 2026-05-25)

When `context.ts:buildMessages()` produces `assistant(tool_calls) → user(text) → tool(result)` (valid in OpenAI format due to mid-turn steering), `translateToBedrock` must insert tool_result blocks BEFORE the user text in the same Anthropic user turn. The API rejects the reverse order with a 400: "tool_use ids were found without tool_result blocks immediately after".

Fix: when appending a tool_result to an existing user turn, splice at the front (after existing tool_results) rather than at the end.

**Why:** Caught in prod after the acme channel's first real deploy workflow — user replied "yes" mid-turn, tool result arrived after → 400 crash.

### Rule 2 — no trailing assistant message (#204, 2026-05-26)

Bedrock does not support assistant-message prefill. If the last message in the array is `role: 'assistant'`, the API rejects with: `"this model does not support assistant message prefill"`. This can happen when recovery (`src/runtime/recovery.ts`) auto-retries an interrupted turn whose last recorded event was a pure assistant text (no tool_calls, so `context.ts` doesn't synthesize an orphan-tool stub after it).

Fix: at the end of `translateToBedrock`, pop trailing assistant messages until the last is user-or-system.

**Why:** Caught in prod after #201 (auto-retry recovery) landed — recovery'd turns immediately 400'd on Bedrock channels.

### How to apply both rules

Any future changes to `translateToBedrock` must maintain:
1. tool_results always cluster at the front of a user turn, text/image blocks come after.
2. Last message is never `role: 'assistant'` — strip trailing assistants in a final pass.

Both rules are covered by tests in `gateway.test.ts`. OpenAI-compat / Anthropic-native endpoints don't need either rule (they accept prefill and either ordering), so the rules are Bedrock-specific.
