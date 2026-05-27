---
name: host-shared-config-rules
description: "Three rules from CLAUDE.host.md on this shared host — scope confirmation for skill/CLAUDE edits, prefer /schedule over cron, and agent-host owns CLAUDE.host.md edits."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: acfe1a75-a270-4ba0-90e2-e0afb4d720cf
---

When working on this `claude-agents` shared host, three global rules apply (canonical text in `/home/agent/agent-host/CLAUDE.host.md` under "User preferences"):

1. **Confirm scope before editing skills or CLAUDE.md.** State explicitly whether the change is local (this repo) or host-wide (`agent-host/skills/<name>/SKILL.md` or `agent-host/CLAUDE.host.md`). Ask only when truly ambiguous.
2. **Prefer `/schedule` over systemd/cron** for recurring work. Only fall back to systemd/cron if it must run as a non-Claude process.
3. **Only the `agent-host` agent edits `CLAUDE.host.md`.** If I want to change host-wide system text, ask the user first — `agent-host` will usually be the right hands.

**Why:** User added these to CLAUDE.host.md on 2026-05-21 and broadcast them. Cross-agent coordination on a single host requires clear ownership boundaries; otherwise multiple agents fight over the same shared files.

**How to apply:** Before touching any skill or CLAUDE-style doc, name the scope out loud. For recurring work, default to `/schedule`. Never edit `agent-host/CLAUDE.host.md` from this agent — surface the desired change and let the user route it through the agent-host session. See also [[user-style]].
