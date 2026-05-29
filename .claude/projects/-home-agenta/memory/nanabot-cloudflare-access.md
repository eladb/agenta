---
name: nanabot-cloudflare-access
description: "Published pages live at bensadeh.nanabot.me/<agent>/ (NOT the nanabot.me apex the skill doc shows); the whole domain is behind Cloudflare Access — pages are NOT open-internet."
metadata: 
  node_type: memory
  type: reference
  originSessionId: a68e68cc-0504-48af-b39e-c837f17ed40b
---

**Canonical published-page host is `bensadeh.nanabot.me/<agent>/...`** (per Elad), e.g. `https://bensadeh.nanabot.me/agenta/status/`. The `publish-web` skill doc shows the bare `nanabot.me/<agent>/` apex; that apex also resolves to the same Cloudflare origin and routes the same paths, but use the `bensadeh.` family subdomain when giving Elad a link.

Both hosts are gated by **Cloudflare Access** (org `bensadehfamily.cloudflareaccess.com`). Every path — including `/<agent>/*` app paths like `/agenta/status/` — 302-redirects to the CF Access login *at the Cloudflare edge*, before reaching the Caddy origin, on both `nanabot.me` and `bensadeh.nanabot.me`. Domain-wide.

This **contradicts the `publish-web` skill doc** (`/usr/lib/nanabox/skills/publish-web/SKILL.md`), which claims Cloudflare Access covers only `/console` and that `/<agent>/*` apps are "reachable from the open internet."

**How to apply:** Anything published via `publish-web` is viewable only after authenticating through the `bensadehfamily` Cloudflare Access org — treat it as private-to-the-household, not public. Don't promise a "public URL" for published pages without first arranging a CF Access *bypass* policy for that path (a host-infra change, not editable from this agent). Discovered 2026-05-29 building the agenta/salto status page (eladb/agenta #245 → #246). Related: [[host-shared-config-rules]].
