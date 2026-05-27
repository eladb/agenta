---
name: slack-per-app-scoping
description: "Slack manifest features (unfurl_domains, scopes, event subscriptions) are per-app, not per-channel. But agenta's multi-app architecture (agenta, salto, agenta-dev, agenta-ci) gives natural per-channel scoping via app→channel membership."
metadata: 
  node_type: memory
  type: project
  originSessionId: 39c1516b-e1ca-4445-9051-208de64a2337
---

Slack `unfurl_domains`, scopes, and `bot_events` are declared at the **app** level — there is no per-channel manifest. Channel-level gating has to happen in the event handler (the `link_shared` / `message` payload carries `channel`).

**But** agenta is multi-app: separate Slack apps (`agenta` A0B2WL8UYAZ, `salto` A0B5VLX7QUT, `agenta-dev` A0B5ZQ802F2, `agenta-ci` A0B49GHNG22) all run the same codebase with different `.env` + `homes.json`. Each app is invited to its own channels. So features like `unfurl_domains: ["salto.io"]` registered on Salto's manifest only fire `link_shared` in Salto channels — agenta channels are naturally untouched because the agenta app isn't subscribed.

**Why:** Explored 2026-05-26 when designing salto.io link unfurling (#205). Per-channel `unfurl_domains` doesn't exist in Slack's API; multi-app boundaries solve the problem without per-channel handler gating.

**How to apply:** When a Slack feature needs to be active in some channels but not others, the simplest path is to add it to a sub-app's manifest, not to all manifests + gate in code. Code-level gating is only needed for finer-than-app granularity (e.g. "only some salto channels"). Same pattern would work for Workflows, App Home, slash commands, etc. — anything that's manifest-declared.

Linked: [[salto-channel-setup]] for the existing salto app config.
