---
name: prompt-unfrozen
description: System prompt rebuilds from disk on every mention (not frozen in session.json). Home/model/display still freeze. Prompt caching would need a re-think.
metadata: 
  node_type: memory
  type: project
  originSessionId: 268efc8b-02cc-4c15-9a3a-0152b3289ba2
---

As of #188 (2026-05-25), the system prompt is **NOT** persisted in `session.json`. `handler.ts:resolveSystemPromptAndModel` calls `buildSystemPrompt()` + `refreshHomeMirror()` on every mention so edits to:
- `src/prompt.ts:UNIVERSAL_PROMPT_SUFFIX`
- The home repo's `README.md` / `skills/`

...propagate to existing threads on their next mention. No `/delete` needed.

Home config / model triplet / display style STILL freeze per thread (mid-thread swaps would surprise users). Only the prompt rebuilds.

**Why:** Eliminates the "edits only reach new threads" friction. No prompt caching today so there's no cost to rebuilding.

**How to apply:** When changing prompt logic or home repo content, know it takes effect on the next mention in ANY thread. If Anthropic prompt caching is ever added (`cache_control`), revisit — every rebuild busts the cache.
