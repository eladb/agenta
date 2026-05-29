---
name: publish-web-serving-model
description: How publish-web ACTUALLY works on this host — each agent must run its own web server on a unix socket; Caddy proxies to it. The skill doc is stale.
metadata: 
  node_type: memory
  type: reference
  originSessionId: a68e68cc-0504-48af-b39e-c837f17ed40b
---

The `publish-web` skill doc is **stale** (predates the unix-socket substrate that landed ~2026-05-29; nana confirmed, and nana's CLAUDE.md flags it too). It claims Caddy serves `~/apps/` directly with "no restart, no deploy." Reality on this host:

**Caddy reverse-proxies `https://bensadeh.nanabot.me/<agent>/*` to a per-agent unix socket `/run/nanabox/agents/<agent>.sock`, full path preserved (the `/<agent>` prefix is NOT stripped — the per-agent server strips it).** Nothing is auto-started: if no server is bound to the socket, the path 502s ("Host Error"). Each agent runs its own server.

**The setup (nana's model, now in place for agenta):**
- `~/webserver/serve.py` — agent-agnostic Python server (handle from `$AGENT_NAME`/`$USER`; `REPO = serve.py.parent.parent`; serves `$REPO/apps`; static + CGI per the publish-web layout; path-traversal-guarded). Reference copy came from nana at `/tmp/nana-serve.py`.
- systemd **--user** unit `~/.config/systemd/user/agenta-web.service` → `python3 ~/webserver/serve.py --unix /run/nanabox/agents/%u.sock`, `Restart=always`, logs to `~/.web.log`. (`%u` = username = `agenta`.)
- These live in `~` (untracked in the eladb/agenta repo) — host infra, NOT product code; don't commit them.

**Enabling/restarting (gotchas that bite):**
- `systemctl --user` from a non-login shell needs: `export XDG_RUNTIME_DIR=/run/user/$(id -u); export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus`
- Reboot survival needs linger: `loginctl show-user "$USER" -p Linger` must be `yes` (it is on this host).
- Then: `systemctl --user daemon-reload && systemctl --user enable --now agenta-web.service`
- Socket dir `/run/nanabox/agents` is `root:agents 2770` setgid → the socket lands group `agents` and Caddy (in that group) reaches it; no chmod needed.

**If a published page 502s:** the per-agent server is down — `systemctl --user restart agenta-web.service` (after the env exports above); check `~/.web.log`. Verify with `curl --unix-socket /run/nanabox/agents/agenta.sock http://x/agenta/...`.

Discovered building the agenta/salto status page (eladb/agenta #245/#246). Related: [[nanabot-cloudflare-access]].
