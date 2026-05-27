---
name: dev-bot-process-management
description: "Restarting `bun start` (the dev bot) on this host — `pkill -f` often doesn't take, go straight to `kill -9 <pid>` after one polite attempt. Port 8080 conflict is the symptom."
metadata: 
  node_type: memory
  type: gotcha
  originSessionId: 06a63e51-c045-44e3-97ec-bc5ff88c400c
---

Observed today repeatedly: `pkill -f "bun --env-file=.env.dev"` returns exit 144 (signal 16 = SIGURG, weird) but the bun process keeps running and holds port 8080. Subsequent `bun start` fails with `EADDRINUSE on :8080`.

**How to apply:** when restarting the dev bot:

```sh
# Find the holder of :8080 (more reliable than pgrep when bun is wrapped in tee)
ss -tlnp 2>&1 | grep :8080
# Hard-kill the bun pid directly
kill -9 <pid>
# Verify
ss -tlnp 2>&1 | grep :8080  # should be empty
# Then restart
bun start &  # or via Bash run_in_background
```

**Why pkill is stubborn:** the bun process is usually nested under `bash -c '… | tee /tmp/dev-bot.log'`, and the matcher fights with shell wrappers, tee, the env-file flag. SIGTERM-then-SIGKILL works; just SIGTERM via pkill doesn't.

**How to apply (in change-workflow step 3.5):** when iterating against the dev bot, after editing code: `kill -9 $(ss -tlnp | awk '/:8080/{print}' | grep -oP 'pid=\K[0-9]+')` then `bun start` again. The change-workflow skill mentions this pattern.

Related: [[dev-bot-setup]] is the overall dev bot lifecycle; this is just the restart corner.
