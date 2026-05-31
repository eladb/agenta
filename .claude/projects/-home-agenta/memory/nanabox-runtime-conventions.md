---
name: nanabox-runtime-conventions
description: "Mobile-composer attachments land in ~/.attachments/<uuid>/<basename> with an `[attached]` marker; ~/.nana/config.json holds per-agent knobs (RTL, tool_display, gh_dispatch_conclusions, icons)."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 1f759eb6-c0dd-48c0-970d-134c47c13237
---

## Mobile composer attachments (nanabox-runtime ≥ v0.2.19)

When a user attaches photos / videos / arbitrary files from the mobile chat composer, the files land at `~/.attachments/<uuid>/<basename>` owned by my unix user. The chat message arrives as a single user turn whose body is:

```
<optional message text>
[attached]
/home/agenta/.attachments/<uuid>/<basename>
/home/agenta/.attachments/<uuid>/<basename>
...
```

The literal `[attached]` line is the separator; everything after it is one absolute path per line. My `Read` tool resolves image paths natively, so I can view + describe attached photos with no extra plumbing — just `Read` the path.

**How to apply:** if a user message ends with an `[attached]` block, treat the paths below it as files the user wants me to look at and `Read` them (don't ignore them or ask the user to paste contents). The paths are absolute and stable for the life of that attachment dir.

## ~/.nana/config.json (per-agent knobs)

The runtime reads `~/.nana/config.json` for per-agent UI / notification settings. Known keys (as of v0.2.18):

- `direction`: `"rtl"` flips the mobile chat to right-to-left (user bubble stays physically right, à la iMessage Hebrew).
- `tool_display`: `"cycle"` hides tool chips at end-of-turn (vs. the default which keeps them).
- `gh_dispatch_conclusions`: array of GitHub `workflow_run` conclusions that should wake me. Defaults to `["failure", "timed_out", "cancelled"]`. Adding `"success"` pings me on green builds; `[]` silences all CI pings. Allowed values: `success, failure, cancelled, timed_out, skipped, neutral, action_required, stale`.

Agent icons: prefer `~/.nana/icon.svg` or `~/.nana/icon.png`; the box console probes there first. The legacy `~/.claude/icon.{svg,png}` still works as a fallback (gitignore explicitly un-ignores `.claude/icon.svg`).

**How to apply:** when the user asks to tune CI ping noise, RTL, tool-chip display, or icon, write `~/.nana/config.json` (create if absent) or drop a file at `~/.nana/icon.{svg,png}`. Don't touch box-wide config — these knobs are per-agent.

Related: [[nanabot-cloudflare-access]] (published-page hosting).
