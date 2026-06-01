---
name: slack-app-bootstrap-gotchas
description: "Bootstrapping a Slack app variant via apps.manifest.create — bot user display name vs app display name, tester-app dedupe, post-create rename via apps.manifest.update."
metadata: 
  node_type: memory
  type: gotcha
  originSessionId: 06a63e51-c045-44e3-97ec-bc5ff88c400c
---

When creating a new agenta app variant (e.g. `agenta-dev` from `slack-manifests/agent.json`) two name fields matter:

- `display_information.name` → the App's display name (e.g. in the Apps directory).
- `features.bot_user.display_name` → the bot USER's display name in messages, channel listings, mentions.

Today's #149: I patched only the first when bootstrapping `agenta-dev`. Slack saw the bot user's name still set to `agenta`, found a duplicate with the prod bot, and silently auto-suffixed it to `agenta2`. The user thought I'd given them a typo.

**How to apply:** when calling `apps.manifest.create` (or extending `scripts/setup-slack-apps.ts:readManifest`) with an override name, patch BOTH fields. PR #149 fixed the script; if you're driving `apps.manifest.create` by hand, this is the trap.

**Recovery:** Slack lets you `apps.manifest.update` after the fact with the corrected manifest. `permissions_updated: false` in the response means no reinstall is needed for a display-name-only change. Tested live today on A0B5ZQ802F2.

**Tester is shared.** When bootstrapping ANY agent variant, the `.slack-apps.json` cache should already have a `tester` entry — `ensureTester` is a no-op if so. If the cache is missing (fresh checkout), pre-populate it with the existing tester app id (`A0B33L7CVRA`) BEFORE running setup, or you'll create a duplicate tester app.

Related code: `scripts/setup-slack-apps.ts:readManifest` (now patches both), `slack-manifests/agent.json:features.bot_user`.
