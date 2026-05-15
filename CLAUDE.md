# agenta — Claude collaboration notes

This file is your context for a new session. Read it in full before starting work.

## How to work with this user (Elad)

- **Functional TypeScript only.** No classes anywhere in `src/` or tests. Using class APIs from third-party packages (`SocketModeClient`, `WebClient`) is fine — we just don't author them.
- Keep things simple. **No redundant abstractions.** Prefer plain functions and callbacks. Reach for an `EventEmitter` only when there's a real one-to-many pattern.
- Don't introduce interfaces / "provider" types unless a second concrete implementation actually exists. Single implementation = single concrete function.
- **Stop and ask before non-trivial decisions or implementing.** Surface forks via `AskUserQuestion` (library choice, module layout, scope of the next phase, persistence strategy, etc.) and confirm direction before writing code. Don't bundle "while I'm here" cleanup or scope expansion.
- Honest is better than enthusiastic. When something is hard or impossible (Slack reCAPTCHA, App-Level token API gap, Anthropic image size limits), say so plainly and offer the realistic options instead of grinding.
- **Never instruct manual Slack UI operations.** All app-configuration changes (scopes, event subscriptions, interactivity, etc.) must go through `apps.manifest.update` so the manifest file in this repo stays the single source of truth. If the `SLACK_CONFIG_ACCESS_TOKEN` is expired or missing, ask the user to generate a fresh one — don't fall back to "go to the UI and toggle this."

## Project: agenta

Implementation of `SPEC.md` (v1) in this repo — a Slack thread-backed agentic sandbox bot. Greenfield; **do not copy code from `~/agents`** (an earlier scratch repo) without asking.

### Stack (locked in)

- **Runtime / package manager:** Bun 1.3.x. Default test runner is `bun test`. Bun loads `.env` automatically.
- **Slack SDK:** `@slack/socket-mode` + `@slack/web-api` (not Bolt). Explicit event routing in `src/slack/events.ts`.
- **Model gateway:** Anthropic via the **OpenAI-compatible endpoint** (`https://api.anthropic.com/v1/chat/completions`). Wire format is OpenAI; auth is `Authorization: Bearer $ANTHROPIC_API_KEY`. Default model: `claude-sonnet-4-6`. Plain `fetch`, no SDK.
- **MIME detection:** `file-type` npm package, magic-byte based. Never trust filename or Slack-reported `mimetype`.
- **Lint/format:** `biome` (single tool, `biome.json`). Tests: `bun:test` co-located with src under `src/`; e2e tests in `tests/e2e/`.

## Implementation state (current)

Phases completed (in order):

1. **Slack adapter (thin)** — Socket Mode connect, event normalization, dedupe, command parsing (`/stop`, `/delete`), `thread_key`, ephemeral `• thinking…` checklist UI.
2. **Persistence + attachments + real `/delete`** — JSONL event store under `data/{thread_key}/`, ingest mentions + non-mention thread messages + edits + deletes, eager attachment download, `/delete` rm's the thread dir + sandbox container. Backfill on first mention only.
3. **Model gateway + agent loop** — pluggable `CallModel` against any OpenAI-compatible endpoint, `runTurn` posts checklist → buildMessages → callModel → tools loop → final reply.
3.x **Attachments → model** — byte-based MIME detection, multipart `content` in OpenAI-compat messages.
4. **Session state machine** — per-thread `idle`/`running`/`stopping`, real `/stop` via `AbortController`, mention batching during a turn (queues, runs one extra turn after current). `session.json` checkpoint per thread; on boot, `recoverInterruptedSessions(web)` posts an "agent restarted" notice and clears the entry.
5. **Tool calling** — multi-iteration loop. Built-in tools registered in `src/model/tools/` (one file per tool). Tool events (`tool_call`, `tool_result`) recorded to JSONL; `context.ts` reattaches them on reconstruction. Includes orphan-tool_call guard (synthetic stub if no result was persisted).
6. **Sandbox** — Docker container per thread (image `agenta-sandbox:latest`, built from `sandbox/Dockerfile`). All bot↔sandbox traffic goes through an in-container **Bun HTTP server** (`sandbox/server/server.ts`, compiled to a static binary) over a random `127.0.0.1:<port>` with a per-container Bearer token. Endpoints: `/exec` (SSE-streamed bash), `/read`, `/write`, `/edit`, `/grep`, `/glob`, `/ls`, `/health`. Hardening: runs as **uid 1000 `sandbox`**, `--cap-drop ALL` + `--cap-add NET_ADMIN/SETUID/SETGID/SETPCAP` (entrypoint uses them then `setpriv`s them away), `--security-opt no-new-privileges`, `--pids-limit 256`, `--memory 1g`, `--cpus 1.0`, egress blocked via in-container iptables OUTPUT rules. Per-thread named volume mounted at `/home/sandbox` (= workspace = sandbox user's home).
7. **Live-streamed bash** — `consumeExecStream` fires `onChunk` per SSE event; `runTurn` shows a debounced (800ms) live preview line under the bash bullet, replaces it with a one-line `→ exit: N` summary on completion.
8. **Interactive Slack asks** — `ask_user` tool posts block-kit messages (buttons / static_select / multi_static_select / text-via-thread-reply). The tool's `invoke()` registers a deferred in `src/runtime/asks.ts` and awaits. `src/slack/interactive.ts` dispatches `block_actions` payloads to the registry. 10-min timeout, `/stop`-cancellable, text reply in the same thread auto-resolves the ask. The ask blocks render *on* the checklist message (chat.update with blocks) rather than as a separate post — keeps the thread chronologically coherent. Settled answer is appended inline to the ask bullet (`• ask_user (buttons): pick db → postgres`).
9. **`share_file` tool** — uploads a file from the sandbox to the Slack thread via `files.uploadV2`. Bytes are read from the sandbox over `/read_binary` (new server endpoint; base64 over HTTP), MIME detected from bytes, persisted locally under `data/{thread_key}/attachments/{file_id}-{name}`, and recorded as an `assistant message` event with `files` payload mirroring the user-attachment shape. Tool_result intentionally omits the permalink and the upload uses no `initial_comment` — the model's final reply is the only place prose lives, which removes a class of duplicate-message UX bugs. System prompt has a "File handling rules (strict)" block enforcing this for smaller models.
10. **Sandbox provider abstraction + Fly Machines provider** — `src/sandbox/provider.ts` defines `SandboxProvider { ensure, getEndpoint, remove, killAll, isReady }`. `src/sandbox/docker.ts` and `src/sandbox/fly.ts` implement it. `src/sandbox/index.ts` selects via `SANDBOX_PROVIDER=docker|fly` and exports the unified HTTP client (runBash/readFile/…). The Fly provider creates a per-thread Firecracker VM via the Machines REST API, routes via `fly-force-instance-id` on the shared `<app>.fly.dev` URL, with a per-machine `SANDBOX_TOKEN` in env. `scripts/deploy-sandbox-fly.ts` provisions the app, allocates shared v4 + dedicated v6, and `fly deploy --build-only --push --image-label latest` so the registry tag is stable.
11. **Lazy sandbox provisioning + UI** — the sandbox is no longer created on every mention. Each `Tool` carries a `requiresSandbox?: boolean` flag; the first tool with that flag in a turn triggers `ensureContainer` if `isSandboxReady(threadKey)` is false. While provisioning is in flight the checklist gets a `• 🛠️ provisioning workspace…` line, which mutates to `• ✅ workspace ready` on success or `• ❌ workspace provisioning failed: <err>` on failure. On failure the tool gets an error tool_result synthesized in turn.ts (invoke isn't called), so the model can recover. Mentions that never use a sandbox-touching tool (chat-only, `get_current_time`, `fetch_url`, `ask_user`) skip provisioning entirely.
12. **Inbound attachments → sandbox** — user-uploaded files are mirrored into the workspace at `attachments/<file_id>-<safeName>` (i.e. `/home/sandbox/attachments/...`) so the model can `read_file`/`bash` over them. Sync is lazy (runs after `ensureContainer` on the first sandbox-touching tool of a turn) and idempotent via a per-thread `Map<threadKey, Set<basename>>` in `src/sandbox/index.ts` (cleared on `removeContainer`/`killAllSandboxContainers`). The sandbox server exposes `POST /write_binary` (`{ path, content_b64 }`) for the upload. `buildMessages` also appends `[attached: attachments/<file_id>-<safeName>]` to the user message text so non-vision models see the path hint.
13. **Skills + botspace + per-thread frozen prompt** — the system prompt is no longer a const in `src/index.ts`. It lives in `sandbox/botspace/`: `README.md` for identity/rules + `skills/<slug>/SKILL.md` files with YAML frontmatter (`name`, `description`, anything else flows through verbatim). `src/prompt.ts:buildSystemPrompt` walks the dir, parses frontmatter (malformed = warn + skip, never crash), and composes `<SYSTEM_PROMPT env prefix?>\n\n<README.md>\n\n# Available skills\n…\n<JSON array, sorted by path>` (the skills section is omitted entirely when there are zero skills). The whole `sandbox/botspace/` tree is `COPY --chown=sandbox:sandbox`'d into `/opt/botspace/` at image-build time (NOT into `/home/sandbox/` — that path is overlaid by the per-thread volume mount); `entrypoint.sh` seeds a fresh volume with `cp -a /opt/botspace/. /home/sandbox/` on first boot (copy-if-missing keyed on `README.md`), so the model loads a skill by `read_file('skills/<slug>/SKILL.md')`. The composed prompt is **frozen per thread**: `session.json` schema now persists `{status, updated_at, system_prompt?, sandbox?}` with `status: 'idle' | 'running' | 'stopping'`, `handler.ts` composes on the first mention and writes it into the file, and every subsequent turn in that thread reads `system_prompt` back from session.json. `clearSession` rewrites the file as idle (preserving the prompt + sandbox record) instead of deleting it; only `/delete` removes the thread dir. `recoverInterruptedSessions` filters on status !== 'idle' so we don't re-announce on every boot. `SYSTEM_PROMPT` env var semantics changed: it **prepends** to README.md (used to **replace** the default).
14. **Sandbox persistence across bot restarts** — per-thread sandbox routing (`{provider, container_name|machine_id, token}`) is persisted into `session.json`'s `sandbox` field by the provider on every `ensure`. On bot restart, the next `ensureContainer` re-hydrates from disk: a single liveness check (`docker inspect --format '{{.State.Running}}'` / `GET /v1/apps/<app>/machines/<id>`) decides whether to adopt the existing sandbox or re-provision. Cross-provider records (`SANDBOX_PROVIDER` changed since last boot) are logged + treated as no sandbox; the old container/machine leaks (we don't try to migrate). `src/index.ts` no longer calls `killAllSandboxContainers()` at boot — instead it calls `reapOrphanSandboxes()` (in `src/sandbox/index.ts`), which destroys provider-owned sandboxes (`listAll`) with no matching `session.json` record. Routine cleanup remains `/delete`. The provider interface gained `listAll()` and `destroyById(id)` to serve the reap; `verifyAlive` lives inside each provider. Sandbox-store helpers live in `src/sandbox/persistence.ts` (`loadSandbox`/`saveSandbox`/`clearSandbox`/`sweepAllSandboxes`) which wrap `setSandbox` on session-store. A sandbox HTTP call failing mid-turn returns its error to the model — we don't auto-reprovision on failure.
15. **Golden-run tests (record/replay model)** — real-model regression layer that lives alongside the existing stub-based e2e suite. `src/model/golden.ts:withGolden(inner, goldenPath)` wraps a `CallModel`, decides mode at construction (file present → replay; file missing + `process.env.CI` set → throw; file missing + not CI → record), and returns `{ callModel, flush }`. Replay is positional only — the Nth recorded response is returned for the Nth call, the request body is NOT re-validated (so prompt tweaks don't churn recordings). `flush()` is a no-op in replay (with a safety check that the test consumed every recorded call) and writes the buffered JSONL in record mode. Test helper `createGoldenCallModel(testFile, testName)` in `tests/e2e/helpers.ts` resolves `tests/golden/<test-file>/<kebab-test-name>.jsonl`, constructs the gateway lazily (no `MODEL_API_KEY` required in replay) and pins to a known-good `MODEL_NAME`/`MODEL_BASE_URL` per-test. The worked example is `tests/e2e/skills-golden.test.ts:'loads and uses python-charts'` — it exercises skills loading + sandbox + bash + share_file + the file-handling rules in one go. Existing `stubCallModel`-based tests stay — goldens are an additional layer, not a replacement.
16. **Per-thread persistent sandbox volumes** — the workspace now lives on a per-thread named volume (`agenta-vol-<threadKey>` on docker, a Fly volume on fly) mounted at `/home/sandbox`. State survives machine replacement, not just bot restart: Fly trial machines auto-stopping at 5 min, image upgrades, OOM kills — none of those wipe the workspace any more. `SandboxRecord` gained an optional `volume_name` (docker) / `volume_id` (fly); fresh provisions always populate it, but the field is optional for backwards-compat with records written before this landed. `ensure` re-hydration handles a new case: dead container/machine + live volume → create a fresh container/machine attached to the existing volume (same token, same workspace). `remove(threadKey)` destroys the machine **then** the volume (best-effort on volume errors), so `/delete` is the only way to wipe a thread's state. `reapOrphanSandboxes` walks both containers/machines AND volumes; a volume without an owning session is destroyed. `entrypoint.sh` seeds a fresh volume from `/opt/botspace/` (copy-if-missing, keyed on `~/README.md`) — second-boot is a no-op so user-modified files survive. Cost model on Fly: ~$0.15/mo per 1 GB volume × active threads. The volume is fixed at 1 GB (Fly minimum) for now.
17. **Slack mrkdwn converter** — `src/slack/mrkdwn.ts`. Slack's "mrkdwn" flavor differs from standard GitHub markdown (`*bold*` not `**bold**`, `_italic_` not `*italic*`, `<url|text>` not `[text](url)`, no headings). To stay deterministic the bot prompt instructs the model to always emit STANDARD markdown, and `postInThread`/`editMessage` run `mdToMrkdwn` on every outgoing text. The converter protects fenced + inline code, then rewrites links, then handles bold + italic in a single alternation pass (bold first so `**x**` is consumed before `*x*` matches the inner content), then headings → bold. Single known input dialect = no detection ambiguity. 16 unit tests including the screenshot regressions that triggered this.
18. **Single-message-per-turn UX with reactions + steering** — the older "checklist of bullets" and the brief "rolling rounds (one Slack message per round)" experiments are gone. Current model: ONE Slack message per turn that evolves in place. Each round (one model response = one iteration of the tool loop) overwrites the previous round's content in the same message; the final reply replaces the message with clean text at the end. The message is lazy-created on the first concrete content (a tool bullet, a provisioning status, a steered intermediate); a turn that goes straight to a text-only final never creates a "thinking…" placeholder — the bot just posts the final reply. Cross-round "still working" signal is the 🤔 reaction added to the user's originating mention; mid-turn steering messages get a 🛞 reaction. All reactions added during a turn are removed in a `finally` block on success, abort, or error. The bot prompt has a "Narration rules" block telling the model to write one short sentence before each tool call so the round message reads as an explanation + tools (free / weaker models still skip narration sometimes — that's a model-behavior tradeoff, not a system bug). Round body format: italic header text (`*reasoning*` standard markdown → `_reasoning_` Slack mrkdwn via the converter), blank line, then plain-text tool labels with `→ result-or-exit-code` summaries underneath; status lines like `_provisioning workspace…_` italicized inline. "Workspace ready" doesn't persist on success (only on failure). **Steering**: at every iteration boundary `injectSteering` reads new `slack.message` events that arrived since `consumed` was last refreshed, filters out slash-commands (`/stop`, `/delete`), and appends them to the in-process `messages[]` as `role: 'user'`. The next model call sees them. No-tool-calls + new steering message = the would-be-final renders as an italic intermediate (overwritten by the next round) and the loop continues instead of returning. Real-time mid-API-call interruption isn't possible — granularity is "between rounds". `session.ts` passes an `onMidTurnConsume` callback to `runTurn` so consuming steering clears the `pending` flag and doesn't trigger a redundant follow-up turn. Reaction calls in `addReaction`/`removeReaction` use `try/catch` (not just `.catch()`) so a stub WebClient without a `reactions` field doesn't crash; production needs `reactions:write` scope on the agent app (added).
19. **Per-bot lockfile** — `src/lockfile.ts`. Two bots can run on the same machine without coordinating, and the failure mode was silent: Slack Socket Mode load-balances events across all connected clients on the same app token, so two agenta instances each got ~50% of events. `acquire(name)` creates `${tmpdir}/agenta-${name}.lock` with `O_CREAT|O_EXCL` containing `pid timestamp`. Stale lockfiles (owning pid no longer alive) are stolen automatically; live conflicts throw with a clear error pointing at the running pid. Released on `process.on('exit')` and on SIGINT/SIGTERM (re-raises the signal so default termination still fires). Wired in `src/index.ts:acquire('agent')` for production and `tests/e2e/helpers.ts:acquire('agent')`/`acquire('tester')` for in-process test agents/testers. `shutdown(agent, tester)` releases both so sequential test files in the same process can re-acquire.
20. **Per-run e2e channels + sequential file execution** — `scripts/run-e2e.ts` wraps `bun test tests/e2e` so every `bun run e2e` invocation gets its own fresh Slack channel (`#agenta-e2e-<YYMMDDhhmmss>-<rand>`). The wrapper creates the channel as the tester bot, invites the agent, sets `TEST_CHANNEL_ID` for the child process, and archives the channel on exit (success, failure, or signal). It also spawns each `tests/e2e/*.test.ts` file in its own `bun test` subprocess sequentially — bun's default parallelism would have multiple files contending for the per-bot lockfile (and the underlying Slack socket). Slower than full parallelism but each file gets a fresh process, lockfile, socket pair, and data dir → no cross-file leakage. Tester scopes upgraded to support channel create/archive/invite (`channels:manage`, `channels:write.invites`). Docker-gated tests now consistently use `DOCKER_PROVIDER_ACTIVE` exported from `helpers.ts` (both docker installed AND `SANDBOX_PROVIDER=docker`) so they skip cleanly on Fly runs.
21. **Sandbox egress toggle + image extras** — `SANDBOX_EGRESS` env (default `allow`): when `block`, `entrypoint.sh` installs the iptables OUTPUT block (ACCEPT loopback + RELATED/ESTABLISHED + RFC1918 + link-local; DROP rest); otherwise no rules are installed and the sandbox can `curl`/`pip install`/`apt update` freely. Plumbed through both providers (`docker.ts` passes `-e SANDBOX_EGRESS=…` only when set, `fly.ts` adds it to the machine env). Note: Fly egress was already wide-open in practice because Fly's overlay gateway sits in 172.16/12 which the block policy allowed through — this change just makes the intent explicit. Docker, however, genuinely flips from blocked-by-default to allow-by-default. Image got `python3-pip` and `zip`/`unzip` so the model doesn't have to fall back to `python3 -m zipfile` or similar workarounds. Note: Ubuntu 24.04 enforces PEP 668 — `pip install` outside a venv needs `--break-system-packages` or the model uses `python3 -m venv`.
22. **Per-session git-backed botspace over SSH** — the prompt (README.md + skills/) used to be baked into the image at `/opt/botspace/` and seeded into every fresh volume by entrypoint.sh. That tree is gone. There is now exactly one configured git working tree on the bot host (`AGENTA_REPO_PATH`); each session generates an ed25519 keypair on the host, drops a `command="<repo>/bin/agenta-git-shell --session <tk> --repo <repo> --allowed-ref refs/heads/agenta/sessions/<tk>",no-port-forwarding,…` line into `~/.ssh/authorized_keys` tagged with `agenta-<thread_key>`, then writes the private key + an `ssh://agenta-repo` config + a pinned `known_hosts` into the sandbox volume. The sandbox `git clone --depth 1`s the host repo into `/home/sandbox`, checks out `agenta/sessions/<thread_key>`, and is then free to commit + push. `agenta-git-shell` (bash) restricts the key to `git-upload-pack` / `git-receive-pack` against the one configured path; `git-hooks/pre-receive` (wired in per-invocation via `core.hooksPath`) enforces ref-namespace + fast-forward-only on pushes. `buildSystemPrompt` reads README.md + skills/ directly from `AGENTA_REPO_PATH` on the host (no `git show` indirection). Bootstrap runs from `runTurn` right after `ensureContainer` succeeds and before `syncAttachmentsToSandbox`; failures synthesize a tool_result. `/delete` drops the authorized_keys line first, then the thread dir + sandbox — but does NOT delete `agenta/sessions/<thread_key>` on the host repo (that's the model's work product). Boot-time `reapOrphanAuthorizedKeys` is symmetric with `reapOrphanSandboxes`: drops authorized_keys lines whose thread has no live session.json git record. New TS modules: `src/git/{keys,authorized-keys,known-hosts,bootstrap}.ts`. New scripts: `bin/agenta-git-shell`, `git-hooks/pre-receive`.
23. **Fly transport for the git bootstrap (reverse SSH tunnel)** — phase 22's bootstrap reached the Mac's sshd via `host.docker.internal:22` which is a Docker-Desktop-only loopback alias; on Fly there's no equivalent route from a Firecracker VM behind 6PN. Phase 23 adds a per-sandbox **autossh reverse tunnel over Fly's WireGuard mesh**. Image: `dropbear-bin` (~200KB) listens on port 2200 inside the sandbox; entrypoint.sh generates a host key once per volume's life, pre-chowns `/root/.ssh/authorized_keys` to `sandbox:sandbox` mode 644 so the uid-1000 server can append to it (dropbear still reads it as root and does not strict-mode-check). Mac-side: one-time `bun run setup-tunnel` generates `~/.ssh/agenta_tunnel_id_ed25519` and creates a Fly WireGuard peer for the Mac (`flyctl wireguard create personal …`); the operator imports `agenta-mac.conf` into the macOS WireGuard app and activates the tunnel. The Mac now has a stable `fdaa::/16` IPv6 and can reach every Fly machine's `private_ip`. Bot-side: `src/git/tunnel.ts` exposes `ensureTunnel(threadKey, flyIp) / stopTunnel(threadKey) / stopAllTunnels()` over a module-level `Map<string, TunnelHandle>`; `ensureTunnel` is idempotent (no-op if pid matches + flyIp matches + the pid is alive) and self-healing (respawns on pid death OR flyIp drift). It blocks until the reverse-forward is reachable via `runBash` probe so the next `git clone` can't race the tunnel. autossh argv: `-M 0 -N -R 0.0.0.0:2222:localhost:22 -p 2200 -i ~/.ssh/agenta_tunnel_id_ed25519 -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 root@<fly_ip>`. Per-thread `UserKnownHostsFile=<data>/tunnel-hosts/<tk>` so a re-provisioned sandbox doesn't trip "host key changed". `bootstrap.ts` reads `AGENTA_HOST_SSH_HOSTNAME` (default `host.docker.internal`, Fly: `localhost`) and `AGENTA_HOST_SSH_PORT` (default `22`, Fly: `2222`) into the per-session `~/.ssh/config`. On Fly the bootstrap also installs the Mac tunnel pubkey into the sandbox's `/root/.ssh/authorized_keys` via `runBash` (append-if-missing) before calling `ensureTunnel`. `SandboxRecord` for fly gained an optional `private_ip` populated from `POST /v1/apps/<app>/machines`' response on every fresh-provision + reattach + verifyAlive re-hydration; the field is optional for backwards-compat. `/delete` calls `stopTunnel(threadKey)` before `removeContainer`. Process shutdown (SIGINT/SIGTERM/exit) calls `stopAllTunnels()`. autossh children are spawned `detached` + `unref`'d so they survive bot crash without orphaning a child of pid 1, BUT we still want to reap them on a clean shutdown so they don't accumulate. Docker path is untouched — defaults route to `host.docker.internal:22` directly with no tunnel. E2E: a new `describe.skipIf(!FLY_TUNNEL_ACTIVE)` block in `tests/e2e/git-botspace.test.ts` mirrors the docker push round-trip on Fly; opt-in via `AGENTA_TEST_TUNNEL_OPT_IN=1` + `SANDBOX_PROVIDER=fly` + active WireGuard (probed via `ping6 fdaa::1`). New module: `src/git/tunnel.ts`. New script: `scripts/setup-tunnel.ts`.

### Not yet implemented (deferred from spec)

- **Edits/deletes projected into model context.** Persisted in JSONL but not flattened into the messages array. Spec §11.
- **Context window trimming** (spec §11: 50% sliding window, atomic tool-block trim). We send the full history. Starts mattering once tool loops produce long histories.
- **Persisted dedupe + pending-mention queue** across restarts. In-memory only; Slack redelivery on bot restart can re-process events.

### Known issues / gotchas worth knowing about

- **Egress is allow-by-default now.** `SANDBOX_EGRESS=allow` (default) skips the iptables block entirely; set `SANDBOX_EGRESS=block` in `.env` to lock down to RFC1918 + loopback. The block has always been ineffective on Fly (Fly's overlay gateway is in 172.16/12 which the block rules allowed); the toggle just makes the intent explicit. Locally on docker the toggle does what it says.
- **Socket Mode can go silently deaf.** Observed live: TCP socket stays ESTABLISHED, `connected` event fired, `hello` received from Slack — but no subsequent events arrive at the handler. Bot looks alive while being completely blind. The `@slack/socket-mode` library handles its own reconnects but doesn't surface this state. No watchdog today; manual restart fixes it. Future fix: periodic `auth.test` heartbeat and/or "no event in N minutes → warn + force reconnect" timer.
- **Fly trial machines auto-stop at 5 min**, but per-thread volumes mean state survives ("Trial machine stopping. To run for longer than 5m0s, add a credit card." in `flyctl logs`). The next mention re-provisions a fresh machine attached to the existing volume — workspace files, caches, and the seeded botspace persist. Machine churn during a turn still briefly stalls the bot (~10–20s of `ensureContainer` while a new Firecracker VM boots and `/health` passes); long single turns that span a stop event will pause once. Adding a payment method removes the auto-stop cap entirely.
- **Fly host-side DNS hostility.** On networks that block outbound port 53 to public resolvers AND the local resolver mishandles `<app>.fly.dev` (Elad's home network does both: router returns AAAA-only, ISP blocks port 53 to 8.8.8.8/1.1.1.1), Bun's `fetch` can't resolve the Fly host. Workarounds we've used:
  - `/etc/hosts` line: `66.241.125.131 agenta-sandbox.fly.dev` (added on Elad's Mac during this session).
  - Encrypted DNS profile on macOS (cleaner; uses DoH over 443).
  - **Better long-term fix:** implement DoH-based resolution inside `flyProvider` so the bot is independent of the host's resolver. Sketch in `runBash`/`postJson`: resolve via `https://cloudflare-dns.com/dns-query`, open the TLS socket to the resolved IP with SNI = original hostname. Would need Node's `https.request` with custom `lookup` since Bun's `fetch` has no DNS hook.
- **Host port not cached on Docker.** Docker Desktop auto-restarts containers when their main process exits and reassigns the host port. `dockerProvider.getEndpoint` re-reads via `docker port` on every call (~50ms). Fly doesn't have this quirk.
- **Sandbox persistence + cross-provider switch.** Per-thread sandbox routing lives in `session.json` and is reattached on bot restart after a single liveness check (Docker: `inspect --format '{{.State.Running}}'`; Fly: `GET .../machines/<id>` + `state === 'started'`). If you flip `SANDBOX_PROVIDER` between runs, the persisted record's `provider` won't match — the bot logs a warning, clears the record, and provisions fresh. The old container/machine is left running (leaks) on the previous provider; we don't auto-migrate. Also: liveness is verified ONCE at re-hydration; afterwards the in-memory cache is trusted. If a container dies *mid-turn* the next HTTP call surfaces the error to the model — there's no magic auto-reprovision.
- **share_file files aren't reprojected to the model on later turns.** OpenAI/Anthropic compat doesn't allow image content on `assistant` role. The bytes are archived in `data/{thread_key}/attachments/` and the metadata is in the JSONL `assistant message.files` payload, but `buildMessages` doesn't emit them as multipart `user` content. If we want the model to "see" what it sent later, that's a synthetic-user-message hack. `buildMessages` also explicitly SKIPS share_file's own `assistant message` (with `files` payload) so the `[shared X]` marker text doesn't get projected back as the model's voice and trigger pattern-mimicry in future rounds.
- **`reapOrphanSandboxes` runs in the background at boot.** `src/index.ts` registers `listen()`/`listenInteractive()` BEFORE awaiting reap and recovery — both run fire-and-forget. Caught live: a Fly throttle stalled the reap's per-orphan `DELETE /machines/<id>` calls and the bot was unable to handle any incoming events for 5+ minutes because `listen()` hadn't been reached. Fixed by reordering. Recovery is similarly background.
- **Slack message_changed events for link-unfurl enrichment.** When a user posts a mention, Slack sometimes re-delivers a `message_changed` event for that same message a second later with identical `text` (it's metadata-only update). Our normalize layer drops these (`newText === prevText → return null`); without that filter the persistence e2e test flakes by recording a phantom edit.

### Session continuity checklist for a fresh Claude session

When you start a new session on this repo:

1. Read this file in full (you're doing that now).
2. Skim recent commits: `git log -25 --oneline` to see what's actually merged vs. what this doc claims.
3. Check `ps aux | grep "bun src/index"` — production agent may already be running on the user's Mac (pid varies). Don't restart unless needed; the `agent` lockfile will block a second instance with a clear error if you try.
4. Glance at "Known issues" — Socket Mode silent disconnect, Fly DNS hostility, and DoH-based DNS are the most likely things to come up.
5. If the user asks "what's next?", the open phases (priority-ordered): edits/deletes into context (smallest), context-window trimming, Socket Mode watchdog, host-side egress block on docker, persisted dedupe + queue, multi-bot deployments, cloud console.

## Repo layout

```
src/
  index.ts                 entry: env → acquire('agent') lock → connect → listen (registered FIRST) → fire-and-forget reapOrphanSandboxes + reapOrphanAuthorizedKeys + recoverInterruptedSessions
  log.ts                   tiny console logger with scope + level
  lockfile.ts              acquire(name) / release: per-bot tmpdir lockfile with O_CREAT|O_EXCL + stale-pid steal. Auto-released on exit/SIGINT/SIGTERM. Used by production (`'agent'`) and by test helpers (`'agent'`, `'tester'`).
  prompt.ts                buildSystemPrompt(botspaceDir?, envPrefix?): walks the configured host-side directory (default `AGENTA_REPO_PATH`; `BOTSPACE_DIR` override for tests) to compose [env prefix] + README.md + "Available skills" + JSON array (sorted by path). Throws when neither env is set. Pure, no Slack/sandbox deps. Skills with bad frontmatter are warn-and-skipped.
  git/
    keys.ts                generateKeypair via ssh-keygen; returns {private, public, fingerprint}.
    authorized-keys.ts     addEntry / removeEntry / listEntries / reapOrphanAuthorizedKeys against `~/.ssh/authorized_keys` (override path via `AGENTA_AUTHORIZED_KEYS_PATH` in tests). Each line tagged `agenta-<thread_key>`; non-agenta lines preserved verbatim.
    known-hosts.ts         ensureKnownHostsCache: one-shot `ssh-keyscan -t ed25519 localhost` cached under `data/host-keys/known_hosts`. Idempotent.
    bootstrap.ts           ensureRepoBootstrap(threadKey): on Fly first installs the Mac tunnel pubkey into the sandbox's `/root/.ssh/authorized_keys` + spawns `ensureTunnel`; then generates keypair if needed, writes authorized_keys, drops ssh config + private key + known_hosts into the sandbox volume (HostName/Port pulled from `AGENTA_HOST_SSH_HOSTNAME` / `AGENTA_HOST_SSH_PORT`), shallow-clones AGENTA_REPO_PATH into ~ (over `ssh://agenta-repo`), checks out `agenta/sessions/<thread_key>`. Idempotent. Called from `turn.ts` after `ensureContainer`, before `syncAttachmentsToSandbox`.
    tunnel.ts              ensureTunnel / stopTunnel / stopAllTunnels — per-sandbox autossh reverse tunnel for the Fly transport (Phase 23). Module-level `Map<threadKey, {pid, flyIp}>`. Self-healing on pid death + flyIp drift; blocks until the reverse-forward is reachable via runBash probe. `_setSpawnImpl` is a test seam. Wired into src/index.ts shutdown handlers and src/runtime/handler.ts:`/delete`.
  slack/
    connect.ts             SocketModeClient + WebClient + auth.test
    events.ts              message → IncomingEvent (message | edit | delete). Drops bot-authored edits/deletes AND no-op message_changed events (same new_text + previous_text = Slack link-unfurl metadata refresh, not a real edit).
    post.ts                postInThread, editMessage, deleteMessage, addReaction, removeReaction, postBlocksInThread, editBlocksMessage. All text passes through mdToMrkdwn at the boundary. Reaction helpers use try/catch so a stub WebClient missing `reactions` doesn't blow up.
    mrkdwn.ts              mdToMrkdwn(): standard GitHub markdown → Slack mrkdwn. Protects fenced + inline code, then links, then bold+italic in a single alternation pass, then headings → bold. Co-located mrkdwn.test.ts has the conversion regression cases.
    interactive.ts         listenInteractive — dispatches block_actions to asks registry
    ask-blocks.ts          block-kit builders for the ask_user tool (buttons/select/multi_select/text)
  runtime/
    handler.ts             dedupe → text-override resolveByThreadText → persist → backfill-if-first → command or startOrQueue
    commands.ts            parseCommand: exact "/stop" or "/delete" only
    dedupe.ts              dedupeKey + createDedupe (LRU-ish set, eventId first)
    thread.ts              threadKey + decodeThreadKey (inverse, for recovery)
    redact.ts              best-effort secret scrubber for error messages
    session.ts             per-thread state machine (idle / running / stopping); writes session.json on transitions
    session-store.ts       atomic temp+rename session.json per thread; schema {status, updated_at, system_prompt?, sandbox?, git?}; clearSession now rewrites idle (preserving system_prompt + sandbox + git), only /delete removes the file. setSandbox / setGit are the atomic helpers providers + bootstrap call.
    recovery.ts            recoverInterruptedSessions: on boot, post "agent restarted" notice + clear stale session.json
    asks.ts                pending ask_user registry; at most one per thread; resolveByThreadText for text-override
    turn.ts                runTurn: single-message-per-turn UX. Adds 🤔 reaction to the originating mention at start; lazy-creates ONE Slack message and overwrites its content as the turn progresses (provisioning status → tool labels → final reply); injectSteering at every iteration boundary appends new user messages to messages[] and 🛞-reacts on them; clears all added reactions in `finally` (success, abort, or error). Accepts an optional `onMidTurnConsume` callback that `session.ts` uses to clear the `pending` flag when steering consumes a mention (so no redundant follow-up turn fires).
  persistence/
    store.ts               data/{thread_key}/{messages.jsonl, attachments/, session.json}; AGENTA_DATA_DIR override
    events.ts              AgentaEvent union (slack × {message,edit,delete}; assistant × {message,tool_call,tool_result}) + record()
    mime.ts                detectMime(buf): file-type first, UTF-8 plaintext fallback, else octet-stream
    attachments.ts         downloadFiles via url_private_download; mime detected from bytes; deleteAttachmentsForSlackTs
    backfill.ts            on new thread + mention: conversations.replies → record each, excluding the triggering ts
  model/
    gateway.ts             createCallModel: fetch /chat/completions; Message = system | user | assistant | tool; tool_calls in response; OpenRouter-friendly headers
    context.ts             buildMessages: JSONL → OpenAI messages; reattaches tool_calls to parent assistant; emits role:tool; synthesizes orphan-tool_call stubs
    tools/
      types.ts             Tool, ToolContext (threadKey + onProgress + web/channel/threadTs), ToolProgressChunk
      helpers.ts           truncate / oneLine / strArg
      index.ts             TOOLS registry + TOOL_DEFS + invokeTool
      get-current-time.ts  trivial UTC ISO
      fetch_url.ts         host-side HTTP GET, 8 KB cap, 10s timeout
      bash.ts              wraps runBash, formatBashResult, streams onProgress chunks
      read-file.ts         offset/limit slice, 16 KB cap
      write-file.ts        64 KB cap, auto-mkdir
      edit-file.ts         unique-match string replace (Claude Code semantics)
      grep.ts              ripgrep + line numbers
      glob.ts              ripgrep --files
      list-dir.ts          structured ls
      ask-user.ts          interactive Slack ask (buttons/select/multi_select/text) — uses asks.ts registry, renders on the checklist message itself
      share-file.ts        uploads a sandbox file to the Slack thread; records assistant message event with files payload
  sandbox/
    provider.ts            SandboxProvider interface (ensure / isReady / getEndpoint / remove / killAll / listAll / destroyById) + SandboxEndpoint {baseUrl, headers}
    persistence.ts         loadSandbox / saveSandbox / clearSandbox / sweepAllSandboxes — thin wrappers over session-store's setSandbox/readSession/listSessions, shared by both providers.
    docker.ts              dockerProvider — local Docker container + per-thread named volume (`agenta-vol-<threadKey>`). ensureImage / ensureNetwork / dockerSpawn + lifecycle. ensure re-hydrates from session.json (verifyAlive via `docker inspect`) before provisioning; the dead-container + live-volume case spawns a new container attached to the existing volume; getEndpoint also lazily re-hydrates; remove tears down container then volume; killAll sweeps both kinds plus the disk-side sandbox field; listAll reports both for the orphan reap.
    fly.ts                 flyProvider — per-thread Fly machine + per-thread Fly volume via the Fly Machines REST API. fly-force-instance-id header routes requests to the specific machine over the shared <app>.fly.dev URL. Same re-hydration shape as docker.ts (verifyAlive via `GET /v1/apps/<app>/machines/<id>` and `state === 'started'`); dead machine + live volume = new machine attached to the existing volume. Volume region resolves from `FLY_REGION` env or the app's `primary_region`. 1 GB volumes.
    index.ts               provider selector (SANDBOX_PROVIDER=docker|fly), provider-agnostic HTTP client: runBash/readFile/readBinary/writeFile/editFile/grep/glob/listDir, consumeExecStream (SSE parser). Re-exports containerName / volumeName for tests. Hosts reapOrphanSandboxes() (boot-time safety net; walks both containers/machines and volumes).
bin/
  agenta-git-shell         bash. authorized_keys `command=` target. Parses --session / --repo / --allowed-ref, validates $SSH_ORIGINAL_COMMAND is `git-upload-pack '<repo>'` or `git-receive-pack '<repo>'` (and `<repo>` matches --repo), sets `core.hooksPath` to `<agenta>/git-hooks/` via per-invocation `GIT_CONFIG_*`, then exec's the git binary. Anything else exits 1.
git-hooks/
  pre-receive              bash. Reads `<old> <new> <ref>` triples from stdin, rejects unless `<ref> == $AGENTA_ALLOWED_REF`, accepts zero→sha (initial creation), otherwise requires `git merge-base --is-ancestor` (FF-only). Lives here (not in any customer-repo .git/hooks/) so the agenta policy is versioned alongside the bot.
sandbox/
  Dockerfile               multi-stage: oven/bun:1-slim builds the server binary → ubuntu:24.04 runtime + iptables/ripgrep/git/curl/jq/zip/unzip + python3/python3-pip/python3-pil/matplotlib/numpy/pandas/imagemagick, sandbox user uid 1000. No botspace bake-in — `bootstrap.ts` clones the configured host repo into `/home/sandbox` per session over SSH. `WORKDIR /home/sandbox`. Note: Ubuntu 24.04 enforces PEP 668 so `pip install` outside a venv needs `--break-system-packages`.
  entrypoint.sh            chown /home/sandbox to sandbox:sandbox (Fly mounts fresh volumes as root:root mode 0755); conditionally installs the iptables OUTPUT block ONLY when `SANDBOX_EGRESS=block` (default: allow); then `setpriv` to sandbox user with bounding/inheritable/ambient caps wiped, then exec the server. (Image-side botspace seeding is gone — clone happens on first sandbox-touching tool, host-driven.)
  fly.toml                 minimal Fly app config — `app = "agenta-sandbox"` + Dockerfile pointer. No services here; the bot creates per-thread machines on demand.
  server/
    server.ts              Bun HTTP API. Endpoints (Bearer auth except /health): /exec (SSE), /read, /read_binary, /write, /edit, /grep, /glob, /ls, /health. Spawned bash inherits cwd=/home/sandbox (the workspace = sandbox user's home = per-thread persistent volume mount). 60s default exec timeout (SANDBOX_EXEC_TIMEOUT_MS).
scripts/
  setup-slack-apps.ts      interactive creator via apps.manifest.create (needs config tokens)
  update-manifest.ts       push slack-manifests/<agent|tester>.json via apps.manifest.update (`SLACK_CONFIG_ACCESS_TOKEN=... bun scripts/update-manifest.ts <agent|tester>`). Reports `permissions_updated: true` when reinstall is needed.
  deploy-sandbox-fly.ts    one-shot Fly provisioning + image push (`bun scripts/deploy-sandbox-fly.ts`)
  manual-test-image.ts     quick uploader for the agent: posts a PNG with a mention via the tester
  run-e2e.ts               `bun run e2e` wrapper. Creates a fresh `#agenta-e2e-<stamp>` channel, invites the agent, exports TEST_CHANNEL_ID for each spawned `bun test <file>` (sequentially, one process per file), archives the channel on exit (success/failure/signal).
  canary.ts                `bun run canary` smoke test against a live production agent. Three steps: chat reply → bash + cat → /delete cleanup. Logs `[OK]`/`[FAIL]` per step + non-zero exit on red. Useful after deploys.
  setup-tunnel.ts          `bun run setup-tunnel` — one-shot Mac setup for the Fly reverse-SSH transport (Phase 23). Generates `~/.ssh/agenta_tunnel_id_ed25519`, creates a Fly WireGuard peer named `agenta-mac-$(hostname -s)`, writes `./agenta-mac.conf`. Idempotent. Prints manual import-into-WireGuard.app + activate steps at the end (the GUI step is unavoidable).
slack-manifests/
  agent.json               scopes: app_mentions:read, chat:write, channels:history, files:read, files:write, reactions:write; events: message.channels; interactivity enabled
  tester.json              scopes: app_mentions:read, chat:write, channels:history, files:write, channels:manage, channels:write.invites; events: message.channels (channels:manage + write.invites are for run-e2e's per-run channel creation)
tests/e2e/
  helpers.ts               startAgent (acquires 'agent' lock + in-process socket), startTester (acquires 'tester' lock), mention, uploadFile, waitForReply, waitFor, deleteThread, stubCalls/recordingStub, createGoldenCallModel, shutdown (disconnects + releases both locks), DOCKER_PROVIDER_ACTIVE constant (gates docker-only test files).
  fixtures.ts              inline PNG/PDF/text/binary byte fixtures
  *.test.ts                echo, commands, persistence, edits, attachments, session, tools, sandbox, sandbox-persistence, sandbox-persistence-dead, sandbox-volumes, skills, skills-golden, inbound-attachments, share-file, asks
tests/golden/
  <test-file>/<test-name>.jsonl   recorded (request, response) pairs for golden-run tests; replayed positionally
```

## Key invariants / gotchas

- **JSONL never contains base64.** `payload.files[].local_path` is the only attachment reference. Base64 is created in memory by `context.ts:fileToContentPart` per model call, by reading from disk. If you ever change this, add a regression test.
- **MIME comes from bytes, not extensions or Slack metadata.** `attachments.ts:downloadFiles` runs `detectMime(buf)` after every download and overwrites whatever Slack reported. This is a hard product requirement.
- **The tester is also a bot.** Slack events from the tester have `event.bot_id` set. Do NOT filter `if (event.bot_id) return null` — that drops the tester's mentions. Filter only `event.user === agent.botUserId`.
- **Slack file uploads come as `subtype: "file_share"`.** Our `normalize()` whitelists `undefined | file_share | thread_broadcast`; anything else (joins, leaves, pins, channel topic changes…) is dropped.
- **Backfill excludes the triggering message** by `slack_ts`. The main handler records the triggering message itself after backfill — without `excludeSlackTs`, we'd double-record.
- **`waitForReply` swallows `thread_not_found`.** Slack doesn't materialize a thread record until the parent gets its first reply. Polling before the bot has replied throws `thread_not_found`; we just keep polling.
- **Anthropic images have a minimum size** (~8×8 px). A 1×1 PNG is rejected with `Could not process image`. Use fixtures from `tests/e2e/fixtures.ts` for tests; for ad-hoc manual tests, use real images.
- **App-Level (`xapp-`) tokens** are UI-only — no Slack API can generate them. The setup script handles bot tokens via OAuth install but pauses for the user to click "Generate Token and Scopes" for the App-Level token.
- **`gh repo create agenta` already exists** on account `eladb`. The repo is private. Don't try to create it again — push to the existing remote.

### Tools layout

- **One file per tool** in `src/model/tools/<name>.ts`. Each file owns: the OpenAI tool `def`, `describe(args)` for the Slack checklist, and `invoke(args, ctx, signal)` with all arg validation + the actual implementation. Helpers shared across tools live in `helpers.ts`. Adding a new tool = create the file, export the `Tool` const, register it in `index.ts:TOOLS`.
- **Tool tests are co-located**: `<name>.test.ts` next to each tool. Registry-wide contracts (every tool has a non-throwing `describe`, names match keys, etc.) live in `_registry.test.ts`.
- **`ToolContext` is permissive on purpose** — Slack hooks (`web`, `channel`, `threadTs`) are optional so tools that don't need Slack can be unit-tested without a stub. Tools that *do* need Slack (currently only `ask_user`) throw a clear error when those fields aren't set.

### Session + recovery semantics

- **`session.json` per thread** records session state: `{status: 'idle' | 'running' | 'stopping', updated_at, system_prompt?}`. Written atomically (temp + rename) on every transition. The file lives across the thread's whole lifetime — `clearSession` rewrites it as `idle` (preserving `system_prompt`) instead of deleting; only `/delete` removes it. `signalStop` writes `stopping` **before** firing `abort.abort()` — otherwise the abort cascade lets the turn's `finally { clearSession }` race ahead and leave a stale `stopping` entry on disk.
- **Per-thread frozen prompt.** `handler.ts` composes the system prompt via `buildSystemPrompt()` on the first mention of a thread, writes it into `session.json` (status: idle), and reads it back on every subsequent turn. So README.md/skill edits don't affect already-running threads; only new threads pick up changes. `session.ts` threads the prompt through every `writeSession` call so it survives running ↔ stopping ↔ idle transitions.
- **On boot**, `recoverInterruptedSessions(web)` scans `data/*/session.json`, filters to `status === 'running' | 'stopping'`, posts an "agent restarted — previous turn was interrupted" notice per match, then clears the entry (which flips it to idle, preserving the prompt). Idle entries are skipped — we don't re-announce on every boot. Bad threadKeys and Slack errors don't abort the whole recovery; entries always clear.
- **`/delete` removes the whole thread dir** including `session.json` and the sandbox container — no special cleanup logic.

### Sandbox quirks

- **Re-read the host port every call.** Docker Desktop auto-restarts containers when the main process exits and reassigns a new random host port. `getEndpoint()` always calls `docker port`; the bot caches only the Bearer token (which survives restart in container env).
- **`--cap-drop ALL` strips `CAP_CHOWN`** even from root inside the container, so `entrypoint.sh` must NOT try to `chown` anything. The botspace seed under `/opt/botspace/` is owned by `sandbox:sandbox` at image-build time (`COPY --chown=…`); `cp -a /opt/botspace/. /home/sandbox/` preserves that ownership when seeding a fresh volume, so an explicit chown isn't needed. The home dir itself is created with the correct uid/gid by `useradd --create-home`.
- **`setpriv` needs `SETUID + SETGID + SETPCAP`** (the last is for the bounding-set wipe). All three are also added with `--cap-add` and dropped from the bounding set after the privilege drop. Net effect: server runs as uid 1000 with `CapEff = 0000000000000000`.
- **Ubuntu 24.04 base ships with a default `ubuntu` user at uid 1000.** The Dockerfile `userdel`s it first so we can claim that uid for the sandbox user.
- **In-container egress block is in-container.** A deliberately malicious shell command could `iptables -F OUTPUT` since the container retains NET_ADMIN, but with our non-root user the shell can't reach iptables (perm denied). True defense-in-depth requires host-side `DOCKER-USER` rules — deferred.
- **The sandbox image is built lazily** by `ensureImage()`. First mention pays the build cost (~minutes); subsequent runs hit the layer cache. CI / cold starts should pre-pull or pre-build.

### Interactive asks

- **At most one pending `ask_user` per thread.** `registerAsk` throws `AskInUseError` otherwise. The model issues tool calls serially so this matches reality.
- **Text reply in the same thread resolves the pending ask.** `handler.ts` checks `resolveByThreadText(tk, text)` before the normal ingestion path for non-mention text. Mention text takes the normal mention path (so the user can still ask follow-ups while declining to answer).
- **`block_actions` payloads arrive via the `interactive` Socket Mode event** (separate from `message`). `src/slack/interactive.ts` is wired in `index.ts` alongside `listen()`.
- **Multi-select accumulates picks on the in-memory ask entry** (`multiSelected: string[]`); the Submit button click resolves the ask with `JSON.stringify(multiSelected)`. Cancel button rejects with `"cancelled"`. 10-min timeout. `/stop` rejects the deferred via `abortSignal`.

## Slack apps + IDs (workspace `agentalabs` / T0B304AJPUZ)

- Agent app: **A0B2WL8UYAZ** (bot user `U0B2WQUHK6Z`, display name `agenta`)
- Tester app: **A0B33L7CVRA** (bot user used by e2e tests, `agenta-tester`)
- Test channel: `C0B307LP274`
- Both bots must be `/invite`d to the test channel

If you change scopes via `apps.manifest.update`, `permissions_updated: true` in the response means the user must reinstall the app to grant the new scope. The bot token usually stays the same across reinstalls.

## Env vars

Runtime (required for `bun start`):
- `SLACK_APP_TOKEN` (xapp-) — agent Socket Mode
- `SLACK_BOT_TOKEN` (xoxb-) — agent bot
- `MODEL_API_KEY` — the model gateway API key. Falls back to `ANTHROPIC_API_KEY` if unset. Same key works against Anthropic's OpenAI-compat endpoint, OpenRouter, or any OpenAI-compat host (set `MODEL_BASE_URL` accordingly).
- `AGENTA_REPO_PATH` — absolute path to a non-bare git working tree on the bot host. It's both the source of the prompt (README.md + skills/) AND the remote the per-session sandbox clones from + pushes back to. Required for `bun start`; only optional in tests (set `BOTSPACE_DIR` instead to point the prompt builder at a tmpdir).

E2E (required for `bun run e2e`):
- All runtime vars (the test starts the agent in-process)
- `TEST_APP_TOKEN`, `TEST_BOT_TOKEN`, `TEST_CHANNEL_ID`

Optional:
- `AGENTA_DATA_DIR` — overrides `./data` (tests use a mkdtemp dir)
- `MODEL_NAME` — defaults to `claude-sonnet-4-6`
- `MODEL_BASE_URL` — defaults to `https://api.anthropic.com/v1`. For OpenRouter set `https://openrouter.ai/api/v1` and choose a tool-supporting model (e.g. `google/gemini-2.0-flash-exp:free`). Tool calling reliability varies wildly by model — many free models don't support `tool_calls` and the agent regresses to chat-only.
- `SYSTEM_PROMPT` — **prepended** to README.md (separated by a blank line). Used to **replace** the default const prompt entirely; the switch to a per-thread frozen prompt composed from `<AGENTA_REPO_PATH>/README.md` made replace-semantics meaningless, so it's now a prefix. Leave unset to use README.md verbatim.
- `BOTSPACE_DIR` — override the directory the prompt is composed from (precedence: `BOTSPACE_DIR` > `AGENTA_REPO_PATH`). E2E + unit tests use this to point at an isolated tmpdir so they don't need a real repo on disk.
- `AGENTA_AUTHORIZED_KEYS_PATH` — override the host's `~/.ssh/authorized_keys` path. **Tests only** — they always point this at a tmpfile to keep the user's real authorized_keys untouched.
- `SANDBOX_PROVIDER` — `docker` (default) or `fly`. Picks where per-thread sandboxes live.
- `SANDBOX_EGRESS` — `allow` (default) or `block`. Controls whether the in-container iptables OUTPUT block is installed. `block` matches the old behavior (loopback + RFC1918 + link-local only).
- `AGENTA_HOST_SSH_HOSTNAME` — hostname the sandbox uses to reach the host's sshd for git. Default `host.docker.internal` (Docker Desktop loopback). Phase-23 Fly path uses `localhost` because the sandbox-side end of the reverse-tunnel terminates there.
- `AGENTA_HOST_SSH_PORT` — matching port for the above. Default `22`. Fly path uses `2222` (the reverse-forward bound by autossh).
- `FLY_APP_NAME` + `FLY_API_TOKEN` — required when `SANDBOX_PROVIDER=fly`. Provision the app once via `bun scripts/deploy-sandbox-fly.ts`, then generate a token: `flyctl tokens create deploy -a <app>`.
- `FLY_REGION` — optional override for the region per-thread Fly volumes + machines provision into. Defaults to the app's `primary_region`. Set this if you want sandboxes in a specific region regardless of where the app's primary is.
- `SANDBOX_EXEC_TIMEOUT_MS` — bash command wall-clock cap inside the sandbox. Default 60s. Tests set it lower.

For the setup script only (rotates every 12h):
- `SLACK_CONFIG_ACCESS_TOKEN`, `SLACK_CONFIG_REFRESH_TOKEN`

`.env` is gitignored. `.slack-apps.json` (app-id cache used by the setup script) is also gitignored.

## Running things

```sh
bun install
bun run test     # unit tests in src/
bun run e2e      # scripts/run-e2e.ts: creates a fresh #agenta-e2e-<stamp> channel, runs each tests/e2e/*.test.ts in its own bun process sequentially, archives on exit
bun run canary   # scripts/canary.ts: 3-step smoke test against the running production agent (chat reply → bash → /delete)
bun start        # production agent (acquires the 'agent' lockfile; second invocation errors with the running pid)
bun run lint     # biome check
bun run format   # biome format --write
bun run setup    # interactive Slack app creation (apps.manifest.create)
bun run setup-tunnel  # one-time Mac WireGuard + tunnel keypair setup for SANDBOX_PROVIDER=fly (Phase 23). Prints next steps.
# scripts/update-manifest.ts <agent|tester> — push a manifest change to Slack via apps.manifest.update (needs SLACK_CONFIG_ACCESS_TOKEN)
```

## Test design — important to understand

- **Unit tests** live next to source as `*.test.ts` under `src/`. They never touch Slack/Anthropic; `attachments.test.ts` and `gateway.test.ts` stub `globalThis.fetch`.
- **E2E tests** in `tests/e2e/` start a real agent in-process against the real Slack workspace. Each test file spins up its own agent + tester sockets in `beforeAll`. Slack mutations are cleaned up in `afterAll` (deletes the thread messages it created).
- **The model is stubbed in e2e.** `helpers.ts:stubCallModel` records every `messages` array into `stubCalls[]` and returns `stub: <last user text>` (or `(multipart)` for attachment messages). Tests assert on both the JSONL state and the recorded stub-call shape. Use `resetStubCalls()` in `beforeEach`.
- **There is no e2e test against the real model.** It would cost tokens per run and be flaky. If you ever need one, gate it behind an env flag and exclude it from the default `bun run e2e`.
- **5s default test timeout is too tight.** `package.json` sets `--timeout 30000` for e2e because the model call + backfill round-trip easily exceeds 5s.

## Git / GitHub

- Repo: `git@github.com:eladb/agenta.git` (private, on account `eladb`).
- Default branch: `main`. Commits use a `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` trailer.
- Never push without being asked.
- Never amend / force-push.

## Open questions for the next session

Prioritized roughly by impact / effort:

- **Edits/deletes into model context** — events are persisted in JSONL but `buildMessages` ignores them. Spec §11. Smallest of the remaining spec items.
- **Context-window trimming** — spec §11 sliding window with atomic tool-block trim. Will need a tokenizer. Starts mattering when tool loops produce long histories or once the user moves off free models.
- **Socket Mode liveness watchdog** — periodic `auth.test` ping or "no event in N min → warn + force reconnect". Right now silent disconnects look identical to "idle" and require manual restart. See Known Issues.
- **DoH-based DNS in `flyProvider`** — so the bot doesn't depend on the host network resolving `<app>.fly.dev` correctly. See "Known issues" above for sketch.
- **Host-side egress block (Docker case)** — when `SANDBOX_EGRESS=block` is configured we still rely on in-container iptables; a malicious privileged docker exec could undo them. Replace with `DOCKER-USER` rules tied to container IPs. Needs root on the host + per-container teardown.
- **Persisted dedupe + pending-mention queue** across restarts. In-memory only today; Slack redelivery on bot restart can re-process events.
- **Per-bot tool catalog** — each botspace declares which tools are enabled. Folds naturally into the multi-bot work below.
- **Multi-bot deployments** — `bots/<bot-name>/{README.md, skills/, Dockerfile, slack-manifest.json}` layout; one runner process handling multiple Slack apps. Foundation for the enterprise platform vision.
- **Cloud console (web UI)** — thread viewer + JSONL inspector, botspace editor with hot reload, live sandbox shell, log stream. Biggest single move toward the "platform" framing; would slice into 3-4 sub-phases.
- **Parallel e2e tests with shared sockets** — today `run-e2e.ts` runs files sequentially (per-bot lockfile prevents parallel sockets). True parallelism would need shared infra (one tester socket, per-thread callModel routing). 200-400 lines; not urgent.
