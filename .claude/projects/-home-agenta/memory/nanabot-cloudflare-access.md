---
name: nanabot-cloudflare-access
description: "Published pages live at bensadeh.nanabot.me/<agent>/ (NOT the nanabot.me apex the skill doc shows); the whole domain is behind Cloudflare Access — pages are NOT open-internet."
metadata: 
  node_type: memory
  type: reference
  originSessionId: a68e68cc-0504-48af-b39e-c837f17ed40b
---

Canonical published-page host on this box is `https://bensadeh.nanabot.me/<agent>/...` — the `bensadeh.` family subdomain. The `nanabot.me` apex resolves to the same Cloudflare origin and routes identically, but use the subdomain when giving Elad a link.

**Cloudflare Access** (org `bensadehfamily.cloudflareaccess.com`) gates every path on both hostnames — `/<agent>/*` 302s to the Access login at the CF edge, before reaching the Caddy origin. So `publish-web` pages are **not** open-internet; they're viewable only after authenticating through the `bensadehfamily` org.

**How to apply:** when posting a published-page link to Elad, use the `bensadeh.` host; don't promise a "public URL" without an explicit CF Access *bypass* policy for that path (operator-only host change). Discovered 2026-05-29 building the agenta/salto status page (eladb/agenta #245). Related: [[host-shared-config-rules]].
