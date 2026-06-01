---
name: socket-mode-redelivery
description: "Slack Socket Mode redelivers events that arrived while the bot was disconnected — pollutes any e2e test that posts to a channel before `startAgent`."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: fcb8bb53-9c2f-4ca5-83b3-9382e86553c5
---

Slack Socket Mode redelivers events that occurred while the bot was disconnected (window is ~minutes). So if an e2e test does something like:

```ts
// tester posts a message — agent NOT yet connected
const parent = await tester.web.chat.postMessage({ channel, text: 'foo' });
// ... inject JSONL events ...
agent = await startAgent();  // agent's listener now picks up "foo"
```

The agent's listener WILL receive the parent message via Socket Mode after `startAgent` connects, and `handler.ts` will record it to JSONL — *after* anything the test injected. This pollutes the model's context for subsequent recovery / replay flows.

**Why:** Real Slack behavior, not configurable. We learned it the hard way when `restart-resume.test.ts` (added in #153 for #44) kept failing in CD because the parent message was getting recorded after the injected queued mention, making the stub return `stub: <parent text>` instead of `stub: <queued mention>`. Fixed in #166 / #165.

**How to apply:** When writing e2e tests that need to control JSONL precisely:

1. Start the agent FIRST.
2. Post any setup messages as real mentions, let the agent process them (real turn → real assistant `message` event in JSONL = boundary).
3. THEN modify session.json / inject JSONL events.
4. THEN trigger the path under test.

If you must post a parent without a mention, expect it to land in JSONL after the agent connects. Filter for it or design around it.
