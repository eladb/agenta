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

**Fresh-session checklist:** read this file · `git log -25 --oneline` (what's actually merged vs. claimed) · `ps aux | grep "bun src/\(bot\|tenant\)"` (don't restart a running bot/tenant; the lockfile blocks dupes) · skim the gotcha issues.

## Production runtime

- **Bot on Fly** as `agenta-bot` (one shared-cpu-1x in `iad`, 1 GB volume `agenta_data` at `/data`). Runs the **combo** entrypoint role — bot + tenant co-located in one machine, the bot's `tenants.json` rendered at boot from env (see `Combo entrypoint (single-tenant deployment)` below). Deploy by pushing to `main` → `.github/workflows/cd.yml` runs e2e (against the `agenta-ci` app so prod Socket Mode is untouched) → deploy → canary, fail-stopping at each step. No inbound surface (Slack = outbound WS, model + Fly API = outbound HTTPS).
- **Also runs as `salto` on ECS** — same image, combo entrypoint, on AWS ECS (cluster+service `agenta-bot`, `SANDBOX_PROVIDER=ecs`, Fargate sandboxes in cluster `agenta-sandbox`) as a *different* Slack app (`A0B5VLX7QUT`, bot `salto`/`U0B65LMHRLL`). Different app ⇒ separate event streams ⇒ **no split-brain** with the Fly `agenta` bot. ECS on-disk state + exec → the `debug-thread` skill. **Live** as of 2026-06-01 in AWS account `870494683302` / `eu-central-1` — stood up by hand from `infra/ecs/` (combo-ified bot + sandbox CFN stacks; the templates predate #253 so the bot stack now sets `Command: [combo]` + the combo params/env + `TENANT_SECRET`). Model is Bedrock `us.anthropic.claude-opus-4-7` via `bedrock://us-east-1` (the bearer lives in SSM `/agenta-bot/MODEL_API_KEY` — post-#253 the gateway pins `api_key_env=MODEL_API_KEY`, so `AWS_BEARER_TOKEN_BEDROCK` is no longer read); home is `github.com/eladb/salto-salesforce-playground` over **HTTPS** via `GITHUB_TOKEN` (not the SSH deploy key). 6 SSM SecureStrings under `/agenta-bot`: SLACK_APP_TOKEN, SLACK_BOT_TOKEN, MODEL_API_KEY, TENANT_SECRET, GITHUB_TOKEN, SALTO_API_TOKEN. The CD ECS lane deploys via **GitHub OIDC** — it assumes role `agenta-cd-github` in `870494683302` (region-locked to eu-central-1 via `aws:RequestedRegion`, trust-scoped to `repo:eladb/agenta:ref:refs/heads/main`), so there are **no static AWS keys** in GH secrets. The salto/ECS canary check stays **paused** in `~/.local/bin/canary-monitor.sh` until the claude-agents host itself can auth to `870494683302` (host-side creds for the new account — separate from CD's OIDC, still TODO). (Resource IDs + SSO/OIDC details in the `aws-account-migration` memory.)
- **ECS image builds** run via **AWS CodeBuild** (project `agenta-image-build` in `870494683302`), not local docker — the box the agent runs on has no Docker daemon. Source is a zip in s3 `agenta-codebuild-src-870494683302` (built excluding `.env`/secrets), role `agenta-codebuild`, Docker Hub creds in SSM `/agenta-codebuild/DOCKERHUB_{USERNAME,TOKEN}` to clear the anonymous-pull 429. The bot/sandbox CFN task-defs pin `:latest`, so a CodeBuild build+push is sufficient — no task-def re-register. On a box *with* docker, `scripts/deploy-bot-ecs.ts` / `deploy-sandbox-ecs.ts` are the normal path.
- **Canary watchdog** (host-local, not CD). `install.sh` installs a `*/30` cron on the claude-agents host running `~/.local/bin/canary-monitor.sh` → the double canary (agenta/Fly + salto/ECS); on a confirmed red it Slack-alerts `C0B307LP274` and `agents send`s the agenta agent (oncall) to investigate + bounded-remediate (restart only — redeploy/scale/destroy/secret changes escalate). Reusable recipe = the `/canary` skill.
- **AWS access on this host = Identity Center SSO** (not static keys). Profile `default` in `~/.aws/config` → sso-session `agenta` (start URL `https://identitycenter.amazonaws.com/ssoins-6684efb401bab46f`, region `us-east-2`), account `870494683302` (Dev), role `AdministratorAccess`. So bare `aws …` Just Works; no `--profile`/`--region` needed. SSO accounts reachable: `954242454057` Staging/PowerUserAccess · `074993325816` tulip-staging/SaltoDevsTulip · `870494683302` Dev/AdministratorAccess · `691811225051` Salto/{ViewOnlyAccess,SaltoDevs}.
  - **Re-login "dance" (headless remote host).** The token expires (~hours); `aws sso login --sso-session agenta` uses a PKCE auth-code flow whose redirect targets `http://127.0.0.1:<port>/oauth/callback` — but that loopback is on *this* box, unreachable from the operator's browser. So: run `aws sso login --sso-session agenta --no-browser` (in the background — it blocks on the listener), give the operator the printed `https://oidc.us-east-2.amazonaws.com/authorize?…` URL, they approve in their browser and the redirect *fails* — they copy the full `http://127.0.0.1:<port>/oauth/callback?code=…&state=…` URL from the address bar and paste it back. `curl` that exact URL **on this host** (`curl -s "http://127.0.0.1:<port>/oauth/callback?code=…&state=…"`) → the listener consumes the code → "Successfully logged into Start URL". The port is random per invocation; read it from the printed authorize URL's `redirect_uri`. (Cleaner alternative if it ever gets annoying: SSH-tunnel that callback port to the operator's laptop.)
- **Per-deployment tenants config** (`config/tenants.json`, #253). Lives on the bot side and merges the route table (workspace + channel → `{ tenant, home }`) with the home spec — one channel-keyed file replaces the old separate routing + `homes.json`. Transport inferred from the home `remote` URL scheme: `file://` = tunneled no-mirror; `https://` = tunneled + mirror clone at `<AGENT_HOMES_ROOT>/<slug>` (PAT in `auth_env`); `ssh://`/`git@` = direct (#88 — sandbox clones/pushes straight to GitHub via deploy-key PEM in `auth_env`; tenant keeps a read-only mirror for prompt-source). Home spec arrives in each `/events` envelope; the tenant clones lazily on first use (no boot-time prefetch). Snapshot frozen into session.json on first mention (config edits affect new threads only). Default → `https://github.com/eladb/agenta-test-home`. First direct channel `C0B4MU6GCFQ` → `git@github.com:eladb/agenta-test-home-alone.git`, key in Fly secret `AGENTA_TEST_HOME_ALONE_DEPLOY_KEY`.
- **Health check** `/health` on `HEALTH_PORT` (8080, `fly.toml` polls every 30s). Bot: 200 iff Socket Mode connected, else 503 (process+socket only — silent-deaf (#27) undetected). Tenant: 200 iff the HTTP server is up and post-recovery `readyRef` has latched true, else 503 (during boot recovery the bot's drain loop treats non-200 as "skip" so Slack will redeliver).
- **Prod bot user** `U0B2WQUHK6Z` (app `A0B2WL8UYAZ`). Reinstall after a scope change: https://api.slack.com/apps/A0B2WL8UYAZ/install-on-team.
- **Config tokens** for `apps.manifest.update` cached in `.slack-apps.json` (gitignored); `getConfigTokens()` reads env once, persists, auto-rotates. Recover by regenerating at https://api.slack.com/authentication/config-tokens and re-exporting `SLACK_CONFIG_ACCESS_TOKEN`+`SLACK_CONFIG_REFRESH_TOKEN`.
- **`bun run deploy` works locally with the org-scoped `FLY_API_TOKEN`** (`.env`, swapped 2026-05-29). The old `agenta-sandbox`-only deploy token failed `deploy-bot-fly.ts`'s `flyctl apps list` (couldn't see the bot app); the org token clears `auth whoami` + `apps list` (verified) so that blocker is gone — not run end-to-end here (avoids a prod redeploy). CD deploys via its own secret regardless. The same org token lets the canary read `agenta-bot`'s machines for the Fly health gate.
- **CD gating is asymmetric** — branch protection requires only `unit-tests`; e2e+deploy+canary run post-merge only, so e2e regressions can land red. Two skip tiers: `.ci-ignore` skips e2e+deploy+canary (doc-only); `.ci-e2e-ignore` skips just e2e (prod-only paths like `config/tenants.json`, `fly.toml`, `slack-manifests/*`, deploy/canary scripts) — canary is then the only net, so be conservative adding paths.

### Multi-tenant (#253)

The runtime splits into two roles, both built from one Docker image (two CMDs):

- **Bot** (`bun run start:bot`) is the Slack ingress. It opens one Socket Mode connection per xapp, acks each envelope on receipt, resolves `(team_id, channel_id?)` against `config/tenants.json`, and POSTs an `EventEnvelope` (`envelope_id, type, workspace_id, xoxb, home, payload`) to the chosen tenant's `/events` URL. No disk writes, no model calls, no secrets beyond the per-tenant bearer + the Slack xoxb the envelope carries. `/health` is 200 iff Socket Mode is connected.
- **Tenant** (`bun run start:tenant`) is the agent harness — the rest of `src/` (sessions, sandboxes, model gateway, JSONL store, git transport). It exposes `POST /events` (bearer-auth, SSE status stream: heartbeat/error/done) and `GET /health`. Slack ops use the request-scoped `xoxb` from the envelope — never persisted to disk. Recovery still clears stale `running`/`stopping` on boot but no longer posts a Slack notice (no WebClient at boot — accepted spec trade-off).

A **deployment** is `{ bot, N tenants, sandboxes }` all on one cloud. Two deployments today: **agenta-Fly** (bot + `agentalabs` tenant + Fly sandboxes) and **salto-ECS** (bot + `agentalabs` tenant + Fargate sandboxes). Tenant names are deployment-local — same name in two deployments = two separate tenants. The customer is the tenant; the persona (agenta vs. salto) comes from the home repo.

`config/tenants.json` schema (per-deployment, on the bot side; tenant never reads it):

```json
{
  "tenants": {
    "<tenant_name>": { "url": "https://...", "auth_env": "<ENV_VAR_NAME>" }
  },
  "routes": {
    "<team_id>": {
      "default":  { "tenant": "<tenant_name>", "home": { "remote": "...", "auth_env": "<ENV_VAR_NAME>" } },
      "channels": { "<channel_id>": { "tenant": "...", "home": { "remote": "...", "auth_env": "..." } } }
    }
  }
}
```

Routing is most-specific-wins: `routes[team].channels[channel]` beats `routes[team].default`; missing workspace = drop + log + metric. `auth_env` is always an env-var NAME, never a value — the bot resolves `tenants[name].auth_env` against its own env (bearer to call the tenant), and forwards `home.auth_env` verbatim to the tenant (the tenant resolves it against its own env to get the git PAT or SSH key PEM). Secrets stay on whichever side owns them. Adding a tenant / binding a channel = PR to `tenants.json` + bot restart.

### Combo entrypoint (single-tenant deployment)

For the two single-tenant deployments today (agenta-Fly + salto-ECS), bot + tenant run **co-located** in the same container via the `combo` entrypoint role. The split in #253 was correct, but standing up a separate ingress bot app per cloud is operator work that hadn't happened yet; combo collapses both roles into one machine until the cutover, mirroring the dev pattern (`bun run start:bot` + `bun run start:tenant` on one box pointing at loopback).

`/entrypoint.sh combo` renders `/tmp/tenants.json` at boot from env (`WORKSPACE_ID`, `DEFAULT_HOME_REMOTE`, optional `DEFAULT_HOME_AUTH_ENV` + `CHANNEL_HOMES_JSON`), starts the tenant in the background on `TENANT_INTERNAL_PORT` (default 8081), waits for its `/health`, then runs the bot in the foreground on `HEALTH_PORT` (8080) with `TENANTS_JSON_PATH=/tmp/tenants.json`. Fly's `[[checks]]` and ECS's container health check both hit the bot's `/health`. The bot's loopback tenants.json declares `auth_env: TENANT_SECRET`; both processes read that env var, so the bearer matches by construction.

- Fly: `fly.toml` has `[processes] app = "combo"` — the string is passed as argv[1] to the Dockerfile ENTRYPOINT (`/entrypoint.sh combo`).
- ECS: set the container's `command: ["combo"]` in the task def alongside the new env + `TENANT_SECRET` secret.

Combo-specific env (Fly secrets / ECS task-def env, on top of the per-role required set):
- `TENANT_SECRET` (required) — random secret both processes read; auth_env for the loopback tenant.
- `WORKSPACE_ID` (required) — Slack team_id the workspace-default route is keyed under.
- `DEFAULT_HOME_REMOTE` (required) — default home repo URL.
- `DEFAULT_HOME_AUTH_ENV` (optional) — env-var NAME for the default home's PAT / SSH key. Omit for public + `file://` homes.
- `CHANNEL_HOMES_JSON` (optional) — raw JSON for per-channel overrides (`routes[WORKSPACE_ID].channels`), e.g. `{"C0B4MU6GCFQ":{"tenant":"default","home":{"remote":"git@...","auth_env":"..."}}}`.
- `TENANT_INTERNAL_PORT` (optional, default 8081) — loopback port for the in-container tenant.

When the bot↔tenant cutover happens (separate ingress app per cloud), drop `combo` from the deployment's process command and run `bot` + `tenant` as two apps; the same env vars + secrets fan out per side.

## Repo layout

Bot and tenant are two roles in one repo, one image. `bun run start:bot` boots the ingress router; `bun run start:tenant` boots the agent harness. `src/shared/` is the small cross-cutting layer they both import — wire envelope + route resolver + lockfile + logger.

```
src/
  bot/              ingress router. `bun run start:bot`. Stateless: no disk writes, no Slack ops beyond ack, no model calls.
    index.ts        entry: env-check → load tenants.json → lockfile('bot') → openSocketMode → route+forward; /health watches socket
    config.ts       loadTenantsConfig: read+parse config/tenants.json at boot; refuses startup on schema error
    socket.ts       openSocketMode: SocketModeClient + ack-on-receipt; emits normalized SocketEnvelope to caller
    routing.ts      decideRoute(socketEnv, config, xoxb): extracts (team_id, channel_id?), runs resolveRoute, mints EventEnvelope
    forward.ts      forwardToTenant: POST /events with bearer; drains SSE status stream (heartbeat/error/done)
    health.ts       startHealth: 200 iff Socket Mode connected, else 503
  tenant/           agent harness. `bun run start:tenant`. Owns data volume, sessions, sandboxes, model gateway.
    index.ts        entry: env-check → lockfile('agent') → recoverInterruptedSessions (silent) → reap orphans → startHttp
    http.ts         POST /events (bearer-auth, SSE status events) + GET /health; hands envelope to runtime/handler
    prompt.ts       buildSystemPrompt(homeDir, envPrefix?): [prefix] + README.md + skills JSON. Pure, no Slack/sandbox deps.
    git/
      git-server.ts   per-session HTTP git http-backend on 127.0.0.1:0; core.hooksPath wires the pre-receive hook
      ws-tunnel.ts    per-session WS to sandbox /tunnel; demuxes binary frames into TCP to bot git server; reconnect w/ backoff
      bootstrap.ts    ensureRepoBootstrap: tunneled (file/https) = git server+tunnel+clone; direct (ssh) = write key + clone over SSH. Idempotent. teardownSession/All.
    slack/
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
      home-config.ts  resolveHomeFromEnvelope(home, env) + resolveTransport(home) (pure: slug+transport+paths). No file IO — home spec arrives per request.
      recovery.ts     recoverInterruptedSessions: silently clears stale running/stopping (no boot-time Slack notice under #253)
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
  shared/           cross-cutting layer imported by both roles. Wire types + small process-level utilities.
    types.ts        EventEnvelope + HomeSpec + TenantsConfig + RouteTarget — single source of truth for the bot↔tenant wire
    routes.ts       parseTenantsConfig (schema validator) + resolveRoute (pure most-specific-wins lookup)
    lockfile.ts     acquire/release O_CREAT|O_EXCL lockfile + stale-pid steal ('bot','agent','tester')
    log.ts          scoped console logger
config/
  tenants.example.json  per-deployment operator config example: tenants {url,auth_env} + routes by team_id → {default, channels}
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
- **On boot** the tenant's `recoverInterruptedSessions` silently clears stale `running`/`stopping` entries to `idle`. Under the bot↔tenant split (#253) there's no WebClient at boot, so the "agent restarted" Slack notice is gone — interrupted threads see a frozen partial message until the next mention re-triggers work. Per-entry errors don't abort the sweep.

## Slack apps + IDs (workspace `agentalabs` / T0B304AJPUZ)

- **Agent** A0B2WL8UYAZ (bot `U0B2WQUHK6Z`, `agenta`) — prod on Fly. Scopes: `app_mentions:read, chat:write, channels:history, files:read, files:write, reactions:write, users:read, users:read.email`; events `message.channels`; interactivity on.
- **Tester** A0B33L7CVRA (`agenta-tester`) — drives e2e + canary.
- **CI** A0B49GHNG22 (`agenta-ci`, #66) — e2e step in CD, keeps prod Socket Mode untouched.
- **Dev** A0B5ZQ802F2 (bot `U0B596TUNTW`, `agenta-dev`) — local iteration on the `claude-agents` host where `.env` IS the dev bot. Prod `xapp-` deliberately absent here (two Socket Mode clients on one app token split-brain delivery). Two lockfiles after the split: `'bot'` (one `bun run start:bot` per xapp) and `'agent'` (one `bun run start:tenant` per data volume). Dev `tenants.json` points the workspace route at `http://localhost:<tenant-port>/` so both halves run on the same box.
- **Salto** A0B5VLX7QUT (bot `U0B65LMHRLL`, `salto`) — same codebase deployed on **ECS** (not Fly), Bedrock model, its own home config. Distinct app ⇒ no Socket Mode split-brain with `agenta`.
- Test channel `C0B307LP274`. Canary uses `CANARY_CHANNEL_ID`; e2e creates a fresh channel per run.
- After a scope change, `permissions_updated: true` ⇒ reinstall required (bot token usually survives).

## Env vars

**Bot (`bun run start:bot`):** `SLACK_APP_TOKEN` (xapp-) · `SLACK_BOT_TOKEN` (xoxb-) · `TENANTS_JSON_PATH` (default `<repo>/config/tenants.json`; schema in `src/shared/types.ts`/`config/tenants.example.json`; route table + per-tenant URL + per-channel home spec; `auth_env` references resolve against the bot's env for the tenant-secret slot and stay unresolved for the home slot — the bot forwards the NAME, the tenant resolves it) · per-tenant `<auth_env>` (shared bearer the bot uses to call the tenant's `/events`).

**Tenant (`bun run start:tenant`):** `TENANT_SECRET` (the bot's matching bearer) · `MODEL_API_KEY` (falls back to `ANTHROPIC_API_KEY`) · `AGENT_HOMES_ROOT` (mirror root, default `/data/homes`; slug = `<host>-<sanitized-path>` lowercased) · `GITHUB_TOKEN` (PAT for the default https home; Fly secret) · `auth_env` referenced by any direct (`ssh://`/`git@`) channel home (Fly secret holding the deploy-key PEM).

**E2E:** all runtime vars + `TEST_APP_TOKEN`, `TEST_BOT_TOKEN`, `TEST_CHANNEL_ID`.

**Optional, bot-only:** `HEALTH_PORT` (default 8080; `fly.toml` polls this).

**Optional, tenant-only:** `AGENTA_DATA_DIR` · `MODEL_NAME` (default `claude-sonnet-4-6`) · `MODEL_BASE_URL` (default `https://api.anthropic.com/v1`; **prod sets API_KEY+BASE_URL+NAME together as Fly secrets — if BASE_URL is unset the key goes to api.anthropic.com → 401; rotate all three together**) · `SYSTEM_PROMPT` (prepended to README) · `AGENT_HOME_DIR` (test-only prompt-source override) · `SANDBOX_PROVIDER` (docker|fly|ecs) · `SANDBOX_EGRESS` (allow|block) · `FLY_APP_NAME`+`FLY_API_TOKEN` (when fly) · `FLY_REGION` · `SANDBOX_EXEC_TIMEOUT_MS` (default 60s) · `HEALTH_PORT` (default 8080; `/events` + `/health` share the same Bun.serve).

**Setup script (rotate every 12h):** `SLACK_CONFIG_ACCESS_TOKEN`, `SLACK_CONFIG_REFRESH_TOKEN`.

**CD secrets (GH Actions, not `.env`):** `CI_SLACK_APP_TOKEN`, `CI_SLACK_BOT_TOKEN`, `TEST_APP_TOKEN`, `TEST_BOT_TOKEN`, `MODEL_API_KEY`, `FLY_API_TOKEN`, `SLACK_BOT_TOKEN` (canary user-id resolve only), `CANARY_CHANNEL_ID`.

`.env*` + `.slack-apps.json` are gitignored (`.env.example` excepted).

## Running things

```sh
bun install
bun run test           # unit tests in src/
bun run e2e            # fresh channel, one process per tests/e2e/*.test.ts, archives on exit; helpers boot bot+tenant in-process
bun run canary         # 3-step prod smoke (chat → bash → /delete)
bun run start:bot      # ingress router; reads .env; acquires the 'bot' lock; needs SLACK_APP_TOKEN + SLACK_BOT_TOKEN + tenants.json
bun run start:tenant   # agent harness; reads .env; acquires the 'agent' lock; needs TENANT_SECRET + MODEL_API_KEY
bun start              # alias for `start:tenant` (back-compat)
bun run lint / format
bun run setup          # apps.manifest.create (--app-name agenta-dev for the dev variant)
bun run deploy         # deploy-bot-fly.ts: agenta-bot + agenta_data in iad
./install.sh           # provision a box (Linux OR macOS): bun/flyctl/aws-v2 (+docker on Linux only) + jq/unzip/curl + the */30 canary watchdog cron. macOS: aws v2 via the .pkg (current-user, no sudo; needed for `aws sso login`), no docker (use the CodeBuild path). Idempotent; installs the prod watchdog → run on ONE host only.
# scripts/update-manifest.ts <agent|tester> · scripts/deploy-sandbox-fly.ts
```

## Tests

- **Unit** next to source; never touch Slack/Anthropic (`attachments`/`gateway` stub `fetch`).
- **E2E** boot bot + tenant in-process against real Slack (`helpers.ts:startBotAndTenant` opens Socket Mode in the bot and `POST /events` on a loopback port for the tenant, then wires a one-tenant `tenants.json` pointing at it); **the model is stubbed** (`stubCallModel` records each `messages` array into `stubCalls[]`, returns `stub: <last user text>`). Clean up Slack mutations in `afterAll`. No real-model e2e (cost/flake) — gate behind a flag if ever needed. `--timeout 30000` (model + backfill exceed 5s).

## Git / GitHub

- Repo `git@github.com:eladb/agenta.git` (private, `eladb`). Default branch `main`. Commit trailer `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- **Conventional Commits mandatory** for commit subjects AND PR titles: `<type>(<scope>): <subject> (#NN)`. Types: feat/fix/docs/chore/refactor/test/perf/build/ci/style/revert. `(#NN)` required.
- **Branch protection** `main-protection` (id `16501910`): requires `unit-tests`, blocks force-push + deletion, no bypass.
- **Auto-merge is the default** — `change-workflow` runs `gh pr merge <N> --auto --squash --delete-branch` right after create.
- **Never push without being asked. Never amend / force-push.**
