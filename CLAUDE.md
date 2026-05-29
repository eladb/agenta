# agenta — Claude collaboration notes

Read in full before starting work.

## How to work with this user (Elad)

- **Functional TypeScript only.** No classes in `src/` or tests. Using third-party class APIs (`SocketModeClient`, `WebClient`) is fine.
- **No redundant abstractions.** Plain functions + callbacks. `EventEmitter` only for a real one-to-many. No interfaces / "provider" types until a second concrete impl exists.
- **Stop and ask before non-trivial decisions or implementing.** Surface forks via `AskUserQuestion`; confirm direction before writing code. Don't bundle "while I'm here" cleanup or scope creep.
- **Honest over enthusiastic.** When something's hard or impossible, say so and offer real options instead of grinding.
- **Never instruct manual Slack UI ops.** All app-config changes go through `apps.manifest.update` (manifest files are the source of truth). If `SLACK_CONFIG_ACCESS_TOKEN` is expired, ask for a fresh one.

## Project

Implementation of `SPEC.md` (v1): a Slack thread-backed agentic sandbox bot. Greenfield — **don't copy from `~/agents`** without asking.

**Stack (locked in):** Bun 1.3.x (`bun test`, loads `.env`) · Slack `@slack/socket-mode` + `@slack/web-api` (not Bolt) · Anthropic via OpenAI-compat endpoint (`/v1/chat/completions`, `Authorization: Bearer`, plain `fetch`, default `claude-sonnet-4-6`) · `file-type` magic-byte MIME · `biome` lint/format · unit tests co-located in `src/`, e2e in `tests/e2e/`.

## Implementation state

Phase history, gotchas, and backlog live as GitHub issues — query directly, there's no local index:
- `gh issue list -R eladb/agenta --label phase --state closed` — what shipped
- `gh issue list -R eladb/agenta --label gotcha` — open footguns (#27 silent disconnect, #29 Fly DNS, #35 SIGTERM unreliable)
- `gh issue list -R eladb/agenta --label proposed` — backlog
- `gh issue view <NN> -R eladb/agenta` — read one

**Fresh-session checklist:** read this file · `git log -25 --oneline` (what's actually merged vs. claimed) · `ps aux | grep "bun src/index"` (don't restart a running agent; the lockfile blocks dupes) · skim the gotcha issues.

## Production runtime

- **Bot on Fly** as `agenta-bot` (one shared-cpu-1x in `iad`, 1 GB volume `agenta_data` at `/data`). Deploy by pushing to `main` → `.github/workflows/cd.yml` runs e2e (against the `agenta-ci` app so prod Socket Mode is untouched) → deploy → canary, fail-stopping at each step. No inbound surface (Slack = outbound WS, model + Fly API = outbound HTTPS).
- **Also runs as `salto` on ECS** — the same image is deployed by the same CD run to AWS ECS (acct `271443695230`, `us-east-1`, cluster+service `agenta-bot`, `SANDBOX_PROVIDER=ecs`, Fargate sandboxes in cluster `agenta-sandbox`) as a *different* Slack app (`A0B5VLX7QUT`, bot `salto`/`U0B65LMHRLL`). Different app ⇒ separate event streams ⇒ **no split-brain** with the Fly `agenta` bot. ECS on-disk state + exec → the `debug-thread` skill.
- **Canary watchdog** (host-local, not CD). `install.sh` installs a `*/30` cron on the claude-agents host running `~/.local/bin/canary-monitor.sh` → the double canary (agenta/Fly + salto/ECS); on a confirmed red it Slack-alerts `C0B307LP274` and `agents send`s the agenta agent (oncall) to investigate + bounded-remediate (restart only — redeploy/scale/destroy/secret changes escalate). Reusable recipe = the `/canary` skill.
- **Per-channel home config** (`config/homes.json`, #87). Transport inferred from `remote` URL scheme: `file://` = tunneled no-mirror; `https://` = tunneled + mirror clone at `<AGENT_HOMES_ROOT>/<slug>` (PAT in `auth_env`); `ssh://`/`git@` = direct (#88 — sandbox clones/pushes straight to GitHub via deploy-key PEM in `auth_env`; bot keeps a read-only mirror for prompt-source). `entrypoint.sh` clones https mirrors on boot. Snapshot frozen into session.json on first mention (config edits affect new threads only). Default → `https://github.com/eladb/agenta-test-home`. First direct channel `C0B4MU6GCFQ` → `git@github.com:eladb/agenta-test-home-alone.git`, key in Fly secret `AGENTA_TEST_HOME_ALONE_DEPLOY_KEY`.
- **Health check** `/health` on `HEALTH_PORT` (8080, `fly.toml` polls every 30s): 200 when Socket Mode connected, else 503. Process+socket only — silent-deaf (#27) undetected.
- **Prod bot user** `U0B2WQUHK6Z` (app `A0B2WL8UYAZ`). Reinstall after a scope change: https://api.slack.com/apps/A0B2WL8UYAZ/install-on-team.
- **Config tokens** for `apps.manifest.update` cached in `.slack-apps.json` (gitignored); `getConfigTokens()` reads env once, persists, auto-rotates. Recover by regenerating at https://api.slack.com/authentication/config-tokens and re-exporting `SLACK_CONFIG_ACCESS_TOKEN`+`SLACK_CONFIG_REFRESH_TOKEN`.
- **`bun run deploy` works locally with the org-scoped `FLY_API_TOKEN`** (`.env`, swapped 2026-05-29). The old `agenta-sandbox`-only deploy token failed `deploy-bot-fly.ts`'s `flyctl apps list` (couldn't see the bot app); the org token clears `auth whoami` + `apps list` (verified) so that blocker is gone — not run end-to-end here (avoids a prod redeploy). CD deploys via its own secret regardless. The same org token lets the canary read `agenta-bot`'s machines for the Fly health gate.
- **CD gating is asymmetric** — branch protection requires only `unit-tests`; e2e+deploy+canary run post-merge only, so e2e regressions can land red. Two skip tiers: `.ci-ignore` skips e2e+deploy+canary (doc-only); `.ci-e2e-ignore` skips just e2e (prod-only paths like `config/homes.json`, `fly.toml`, `slack-manifests/*`, deploy/canary scripts) — canary is then the only net, so be conservative adding paths.

## Repo layout

```
src/
  index.ts          entry: lock → connect → listen → reap orphans + recover sessions; teardownAllSessions on shutdown
  log.ts            scoped console logger
  lockfile.ts       acquire/release O_CREAT|O_EXCL lockfile + stale-pid steal ('agent','tester')
  prompt.ts         buildSystemPrompt(homeDir, envPrefix?): [prefix] + README.md + skills JSON. Pure, no Slack/sandbox deps.
  git/
    git-server.ts   per-session HTTP git http-backend on 127.0.0.1:0; core.hooksPath wires the pre-receive hook
    ws-tunnel.ts    per-session WS to sandbox /tunnel; demuxes binary frames into TCP to bot git server; reconnect w/ backoff
    bootstrap.ts    ensureRepoBootstrap: tunneled (file/https) = git server+tunnel+clone; direct (ssh) = write key + clone over SSH. Idempotent. teardownSession/All.
  slack/
    connect.ts      SocketModeClient + WebClient + auth.test
    events.ts       message → IncomingEvent (message|edit|delete); drops bot-authored + no-op link-unfurl edits
    post.ts         post/edit/delete/reactions/blocks; all text via mdToMrkdwn at the boundary
    mrkdwn.ts       GitHub markdown → Slack mrkdwn
    interactive.ts  block_actions → asks registry
    ask-blocks.ts   block-kit builders for ask_user
  runtime/
    handler.ts      dedupe → resolveByThreadText → persist → backfill-if-first → command | startOrQueue
    commands.ts     parseCommand: exact "/stop" | "/delete" only
    dedupe.ts       dedupeKey + createDedupe
    thread.ts       threadKey + decodeThreadKey
    redact.ts       secret scrubber for error messages
    session.ts      per-thread state machine (idle/running/stopping); writes session.json
    session-store.ts atomic session.json; setSandbox/setGit/setHome; clearSession→idle (preserves fields), /delete removes
    home-config.ts  loadHomesConfig + resolveHome(channel) + resolveTransport(home) (pure: slug+transport+paths)
    recovery.ts     recoverInterruptedSessions: boot notice + clear stale running/stopping
    asks.ts         pending ask_user registry (≤1/thread); resolveByThreadText for text-override
    turn.ts         runTurn: one Slack message/turn overwritten as it progresses; 🤔 reaction; injectSteering at boundaries; clears reactions in finally
  persistence/
    store.ts        data/{thread_key}/{messages.jsonl, attachments/, session.json}; AGENTA_DATA_DIR override
    events.ts       AgentaEvent union + record()
    mime.ts         detectMime: file-type → UTF-8 plaintext → octet-stream
    attachments.ts  downloadFiles via url_private_download; MIME from bytes
    backfill.ts     conversations.replies → record each, excluding the triggering ts
  model/
    gateway.ts      createCallModel: fetch /chat/completions; tool_calls; OpenRouter-friendly headers
    context.ts      buildMessages: JSONL → OpenAI messages; reattaches tool_calls; synthesizes orphan stubs
    tools/          one file per tool (def + describe + invoke); index.ts = TOOLS registry; _registry.test.ts = contracts.
                    get-current-time, fetch_url, bash, read-file, write-file, edit-file, grep, glob, list-dir, ask-user, share-file
  sandbox/
    provider.ts     SandboxProvider interface + SandboxEndpoint
    persistence.ts  load/save/clear/sweep sandbox (wraps session-store)
    docker.ts       dockerProvider: container + per-thread volume; re-hydrates from session.json
    fly.ts          flyProvider: Fly machine + volume via Machines REST; fly-force-instance-id routing
    index.ts        provider selector (SANDBOX_PROVIDER); HTTP client (runBash/read/write/edit/grep/glob/ls + SSE parser); reapOrphanSandboxes
git-hooks/
  pre-receive       FF-only + allowed-ref enforcement (tunneled mode only; direct mode relies on GitHub branch protection)
  known_hosts       pinned SSH host keys for direct mode; refresh via ssh-keyscan + re-prepend header
sandbox/
  Dockerfile        oven/bun build → ubuntu:24.04 + tools + python; uid-1000 sandbox user; no home bake-in (cloned per session)
  entrypoint.sh     chown home (Fly mounts root:root); install iptables block iff SANDBOX_EGRESS=block; setpriv → sandbox user → server
  fly.toml          agenta-sandbox app; bot creates per-thread machines on demand
  server/server.ts  Bun HTTP API (Bearer): /exec(SSE) /read /read_binary /write /edit /grep /glob /ls /tunnel(WS) /health; cwd=/home/sandbox
scripts/
  setup-slack-apps.ts  apps.manifest.create
  update-manifest.ts   push slack-manifests/<agent|tester>.json
  deploy-bot-fly.ts / deploy-sandbox-fly.sh  Fly provisioning + image push
  run-e2e.ts           fresh channel per run, one bun process per test file, archives on exit
  canary.ts            3-step prod smoke (chat → bash → /delete); AGENTA_DEPLOY_TARGET=fly|ecs picks the health gate
  canary-monitor.sh    */30 double-canary watchdog (deployed by install.sh → ~/.local/bin; wakes the oncall agent on red)
tests/e2e/   helpers.ts (startAgent/startTester/mention/upload/waitForReply/shutdown) · fixtures.ts · *.test.ts
tests/golden/  <file>/<name>.jsonl recorded (request,response) replayed positionally
```

## Gotchas (not derivable from code)

- **JSONL never contains base64.** `payload.files[].local_path` is the only attachment ref; base64 is built in-memory per model call (`context.ts:fileToContentPart`). Add a regression test if you change this.
- **MIME from bytes, not extension/Slack metadata.** `attachments.ts:downloadFiles` overwrites Slack's reported type. Hard product requirement.
- **The tester is also a bot** (`event.bot_id` set). Filter only `event.user === agent.botUserId`, never `if (event.bot_id) return`.
- **Slack uploads arrive as `subtype: "file_share"`.** `normalize()` whitelists `undefined | file_share | thread_broadcast`; everything else is dropped.
- **Backfill excludes the triggering message** by `slack_ts` — the handler records it itself, else double-record.
- **`waitForReply` swallows `thread_not_found`** — Slack materializes a thread only after its first reply.
- **Anthropic images have a min size** (~8×8 px); a 1×1 PNG is rejected. Use `tests/e2e/fixtures.ts`.
- **`xapp-` tokens are UI-only** — no API mints them; the setup script pauses for the manual click.
- **`gh repo create agenta` already exists** (private, `eladb`). Push to the existing remote.
- **Direct-mode home repos need GitHub branch protection on `main`** — the bot runs no pre-receive hook in direct mode (#88); nothing else stops a rogue agent rewriting `main`. Deploy keys are per-repo so blast radius is bounded.
- **`git-hooks/known_hosts` is pinned** (`StrictHostKeyChecking=yes`) — a stale bundle fails the clone instead of TOFU. Refresh: `ssh-keyscan -t rsa,ecdsa,ed25519 github.com > git-hooks/known_hosts` + re-prepend the header.
- **Bot Dockerfile must include `openssh-client`** — without it the direct-mode mirror clone fails → entrypoint exits 128 → Fly restart-loop → outage (tripped 2026-05-19, fixed #116).
- **`scripts/canary.ts:waitForFlyHealth` uses `.every()`** — fine for one machine; switch to "≥1 started + all checks passing" before any multi-machine rolling deploy.
- **`--cap-drop ALL` strips `CAP_CHOWN`** inside the Docker container (root included) — don't rely on chown there; Fly mounts volumes root:root so `entrypoint.sh` chowns `/home/sandbox` on that path.
- **`setpriv` needs SETUID+SETGID+SETPCAP** (last for the bounding-set wipe); server ends as uid 1000 with `CapEff=0`.
- **Ubuntu 24.04 ships a default `ubuntu` uid-1000 user** — Dockerfile `userdel`s it. PEP 668: `pip install` needs `--break-system-packages`.
- **In-container egress block is in-container only** — a root shell could flush it, but the non-root sandbox user can't reach iptables. Host-side `DOCKER-USER` defense deferred.
- **Docker re-reads the host port every call** — Desktop reassigns ports on container restart; cache only the Bearer token.

## Session + recovery semantics

- **`session.json` per thread**: `{status, updated_at, sandbox?, git?, home?, model?, display?}`, atomic temp+rename. `clearSession` rewrites `idle` (preserves sandbox/git/home/model/display); only `/delete` removes the file + thread dir + sandbox. `signalStop` writes `stopping` **before** `abort()` (else the turn's `finally{clearSession}` races ahead and leaves a stale `stopping`).
- **System prompt rebuilds every mention** (not persisted) — edits to `UNIVERSAL_PROMPT_SUFFIX` and the home repo's `README.md`/`skills/` propagate to existing threads on next mention; `refreshHomeMirror` runs first. home/model/display still freeze per thread. Adding Anthropic prompt caching would break this.
- **On boot** `recoverInterruptedSessions` posts an "agent restarted" notice per running/stopping entry, then clears (→idle). Per-entry errors don't abort the sweep.

## Slack apps + IDs (workspace `agentalabs` / T0B304AJPUZ)

- **Agent** A0B2WL8UYAZ (bot `U0B2WQUHK6Z`, `agenta`) — prod on Fly. Scopes: `app_mentions:read, chat:write, channels:history, files:read, files:write, reactions:write, users:read, users:read.email`; events `message.channels`; interactivity on.
- **Tester** A0B33L7CVRA (`agenta-tester`) — drives e2e + canary.
- **CI** A0B49GHNG22 (`agenta-ci`, #66) — e2e step in CD, keeps prod Socket Mode untouched.
- **Dev** A0B5ZQ802F2 (bot `U0B596TUNTW`, `agenta-dev`) — local iteration on the `claude-agents` host where `.env` IS the dev bot. Prod `xapp-` deliberately absent here (two Socket Mode clients on one app token split-brain delivery). The `'agent'` lockfile = only one of `bun start`/`bun run e2e` at a time.
- **Salto** A0B5VLX7QUT (bot `U0B65LMHRLL`, `salto`) — same codebase deployed on **ECS** (not Fly), Bedrock model, its own home config. Distinct app ⇒ no Socket Mode split-brain with `agenta`.
- Test channel `C0B307LP274`. Canary uses `CANARY_CHANNEL_ID`; e2e creates a fresh channel per run.
- After a scope change, `permissions_updated: true` ⇒ reinstall required (bot token usually survives).

## Env vars

**Required (`bun start`):** `SLACK_APP_TOKEN` (xapp-) · `SLACK_BOT_TOKEN` (xoxb-) · `MODEL_API_KEY` (falls back to `ANTHROPIC_API_KEY`) · `AGENT_HOMES_CONFIG` (default `<repo>/config/homes.json`; schema `{default:{remote,auth_env?}, channels:{[id]:{remote,auth_env?}}}`; `auth_env` absent for `file://`, REQUIRED PAT for `https://`, REQUIRED PEM for `ssh://`/`git@`; validated at boot) · `AGENT_HOMES_ROOT` (mirror root, default `/data/homes`; slug = `<host>-<sanitized-path>` lowercased) · `GITHUB_TOKEN` (PAT for the default https home; Fly secret).

**E2E:** all runtime vars + `TEST_APP_TOKEN`, `TEST_BOT_TOKEN`, `TEST_CHANNEL_ID`.

**Optional:** `AGENTA_DATA_DIR` · `MODEL_NAME` (default `claude-sonnet-4-6`) · `MODEL_BASE_URL` (default `https://api.anthropic.com/v1`; **prod sets API_KEY+BASE_URL+NAME together as Fly secrets — if BASE_URL is unset the key goes to api.anthropic.com → 401; rotate all three together**) · `SYSTEM_PROMPT` (prepended to README) · `AGENT_HOME_DIR` (test-only prompt-source override) · `SANDBOX_PROVIDER` (docker|fly) · `SANDBOX_EGRESS` (allow|block) · `FLY_APP_NAME`+`FLY_API_TOKEN` (when fly) · `FLY_REGION` · `SANDBOX_EXEC_TIMEOUT_MS` (default 60s).

**Setup script (rotate every 12h):** `SLACK_CONFIG_ACCESS_TOKEN`, `SLACK_CONFIG_REFRESH_TOKEN`.

**CD secrets (GH Actions, not `.env`):** `CI_SLACK_APP_TOKEN`, `CI_SLACK_BOT_TOKEN`, `TEST_APP_TOKEN`, `TEST_BOT_TOKEN`, `MODEL_API_KEY`, `FLY_API_TOKEN`, `SLACK_BOT_TOKEN` (canary user-id resolve only), `CANARY_CHANNEL_ID`.

`.env*` + `.slack-apps.json` are gitignored (`.env.example` excepted).

## Running things

```sh
bun install
bun run test     # unit tests in src/
bun run e2e      # fresh channel, one process per tests/e2e/*.test.ts, archives on exit
bun run canary   # 3-step prod smoke (chat → bash → /delete)
bun start        # agent process; reads .env; acquires the 'agent' lock
bun run lint / format
bun run setup    # apps.manifest.create (--app-name agenta-dev for the dev variant)
bun run deploy   # deploy-bot-fly.ts: agenta-bot + agenta_data in iad
./install.sh     # provision a box: bun/flyctl/aws/docker + jq/unzip/curl + the */30 canary watchdog cron. Idempotent; installs the prod watchdog → run on ONE host only.
# scripts/update-manifest.ts <agent|tester> · scripts/deploy-sandbox-fly.ts
```

## Tests

- **Unit** next to source; never touch Slack/Anthropic (`attachments`/`gateway` stub `fetch`).
- **E2E** start a real in-process agent against real Slack; **the model is stubbed** (`stubCallModel` records each `messages` array into `stubCalls[]`, returns `stub: <last user text>`). Clean up Slack mutations in `afterAll`. No real-model e2e (cost/flake) — gate behind a flag if ever needed. `--timeout 30000` (model + backfill exceed 5s).

## Git / GitHub

- Repo `git@github.com:eladb/agenta.git` (private, `eladb`). Default branch `main`. Commit trailer `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- **Conventional Commits mandatory** for commit subjects AND PR titles: `<type>(<scope>): <subject> (#NN)`. Types: feat/fix/docs/chore/refactor/test/perf/build/ci/style/revert. `(#NN)` required.
- **Branch protection** `main-protection` (id `16501910`): requires `unit-tests`, blocks force-push + deletion, no bypass.
- **Auto-merge is the default** — `change-workflow` runs `gh pr merge <N> --auto --squash --delete-branch` right after create.
- **Never push without being asked. Never amend / force-push.**
