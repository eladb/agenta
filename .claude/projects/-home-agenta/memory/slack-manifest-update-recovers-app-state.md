---
name: slack-manifest-update-recovers-app-state
description: "When a Slack bot WS-connects but no events flow, first diagnostic is to re-push the manifest via apps.manifest.update — it re-asserts Socket Mode toggle + event subscriptions that can drift server-side without the checked-in manifest changing."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2c39036d-3357-4679-8941-5e865798a190
---

Symptom: `[bot/socket] connected` fires, then nothing ever arrives. No `dropped`, no `forward error`, no `slack_event` warnings — the listener is just never invoked. Diff against `slack-manifests/<name>.json` looks clean and the bot xapp token still handshakes fine.

Cause: Slack tracks Socket Mode enable + per-event subscriptions in the app's *server-side* config, not just whatever JSON you've committed. That state can flip without a manifest change (UI tweak, install rotation, internal Slack ops, app rate-limited and toggled off). `bun scripts/update-manifest.ts <name>` re-writes the FULL manifest including `settings.socket_mode_enabled` + `event_subscriptions.bot_events`, so a push re-asserts what the JSON declares.

**Why:** Tripped the agenta-ci app twice on 2026-05-31 — once making every e2e test stall on "bot connected → 30s timeout" after #254 landed (looked like the multi-tenant split broke ingress in CI; was actually agenta-ci's Socket Mode flipped off), and once during fix-forward. Manifest re-push cleared it both times. The push reports `permissions_updated: false` (no scope diff) which makes it tempting to read as a no-op; the toggle/event-sub state doesn't go through `permissions_updated`.

**How to apply:** First diagnostic on "bot connects, no events" → `bun scripts/update-manifest.ts <name>`. Cheap, idempotent. Needs fresh `SLACK_CONFIG_ACCESS_TOKEN` + `SLACK_CONFIG_REFRESH_TOKEN` (12h rotation, single-use refresh; regenerate at api.slack.com/authentication/config-tokens). If `.slack-apps.json` lacks the app's id, look it up from CLAUDE.md's Slack apps section and pre-seed before running. See also [[slack-app-bootstrap-gotchas]].
