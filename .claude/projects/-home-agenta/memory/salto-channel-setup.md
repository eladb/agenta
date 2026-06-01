---
name: salto-channel-setup
description: "Salto channel (C0B5L9S2Q4Q) setup — Bedrock model, salto-cloud CLI on bot host, salto-claude-plugin submodule in home repo, SALTO_API_TOKEN + AWS_BEARER_TOKEN_BEDROCK as Fly secrets."
metadata: 
  node_type: memory
  type: project
  originSessionId: 268efc8b-02cc-4c15-9a3a-0152b3289ba2
---

Channel C0B5L9S2Q4Q is the salto demo channel. Key facts:

- **Slack app:** `salto` (A0B5VLX7QUT, bot user U0B65LMHRLL). Replaced the old `agenta` app on 2026-05-25. The old agenta app (A0B2WL8UYAZ / U0B2WQUHK6Z) is decommissioned — tokens rotated in Fly + GH Actions secrets.
- **Model:** AWS Bedrock via `bedrock://us-east-1`, model `us.anthropic.claude-opus-4-7`. Auth is a long-term Bedrock API key (bearer token) in `AWS_BEARER_TOKEN_BEDROCK` Fly secret.
- **Home repo:** `git@github.com:eladb/salto-salesforce-playground.git` (direct SSH mode, deploy key in `SALTO_SALESFORCE_PLAYGROUND_DEPLOY_KEY`).
- **Home layout:** README.md (1st-person Salto persona + doc references), skills/salto/SKILL.md (full workflow router adapted for agenta tools), submodules: `salto-claude-plugin/` (upstream workflow definitions) + `sftest210526/` (real Salesforce workspace NaCl).
- **Bot-host tools:** `salto_cli` (wraps `salto-cloud` 1.4.4, uses `SALTO_API_TOKEN`), `github_create_pr` / `github_update_pr` / `github_pr_comment` (use `GITHUB_TOKEN`).
- **Display mode:** `pretty` (configurable per-thread via `/verbose` and `/pretty` commands).

**Why:** The salto channel is a Salto-as-product demo — the bot speaks as "Salto", uses Salto's vocabulary, cites their docs, and orchestrates NaCl deploy workflows end-to-end.

**How to apply:** When working on the salto channel, know that the model goes through Bedrock (not Anthropic direct), the system prompt is a 1st-person Salto persona, and the home repo submodules ship on `--recurse-submodules` via bootstrap.ts.
