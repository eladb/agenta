# agenta

A Slack-native agentic bot. Mention it in a thread and it spins up an isolated, persistent
agent session with real shell + filesystem tools running in a per-thread sandbox. Each thread
is its own long-running agent; the conversation is stored as an append-only event log and the
agent resumes where it left off across turns.

Built on the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript).

---

## How it works

- **Mention → session.** Mentioning the bot (`@agenta …`) in a channel opens — or continues —
  a thread-scoped agent session.
- **Real tools in a sandbox.** The agent runs `bash`, reads/writes/edits files, fetches URLs,
  searches the web, and opens GitHub PRs — all inside a **per-thread sandbox container** with a
  persistent volume. Nothing touches the host.
- **Git-backed "home".** Each channel is bound to a *home* git repo that supplies the bot's
  system prompt + skills. The agent can read, edit, commit, and push that home from inside its
  sandbox, so the bot can evolve its own instructions.
- **Streaming UX.** Progress renders as a live Slack timeline (tool cards moving
  `in_progress → done`), with the final answer streamed as markdown.
- **In-thread controls.** `/stop` cancels the running turn; `/delete` wipes the thread's data
  + sandbox.

## Architecture

Two roles, one image:

- **bot** (`bun run start:bot`) — Slack ingress. Opens Socket Mode, dedupes/acks events,
  resolves `(workspace, channel)` against `config/tenants.json`, and forwards each event to the
  right tenant over `POST /events`. Stateless: no disk writes, no model calls, no secrets beyond
  a per-tenant bearer.
- **tenant** (`bun run start:tenant`) — the agent harness. Owns the data volume, sessions,
  sandboxes, git transport, and the model turn. It drives the **Claude Agent SDK** `query()`,
  exposing agenta's tool registry as an in-process MCP server, persisting each thread's events to
  JSONL, and resuming the SDK session across turns.

```
Slack ──Socket Mode──▶  bot  ──POST /events──▶  tenant  ──▶  Claude Agent SDK (subprocess)
                                                  │                 │
                                                  │                 ▼  (MCP tools)
                                                  └─────────▶  per-thread sandbox (bash / fs / git)
```

- **Model:** Claude-only — Amazon **Bedrock** or the **Anthropic API**.
- **Sandboxes:** **Docker** (default), **Fly Machines**, or **ECS Fargate** — selected by
  `SANDBOX_PROVIDER`.

## Quick start

Prerequisites: [Bun](https://bun.sh) 1.3+, Docker (for the default sandbox provider), a Slack app
(Socket Mode + bot token), and Bedrock **or** Anthropic credentials.

```sh
bun install
cp .env.example .env     # fill in Slack tokens + a model backend (see below)
```

Configure routing in `config/tenants.json` (see `config/tenants.example.json`): it maps each
Slack workspace/channel to a tenant URL + a *home* repo. Then run the two roles — locally they sit
on loopback:

```sh
bun run start:tenant     # agent harness on :8081 — needs TENANT_SECRET + a model backend
bun run start:bot        # Slack ingress on :8080 — needs the Slack tokens + tenants.json
```

Mention `@<your-bot>` in a channel it's a member of and it'll run a turn.

> For day-to-day local iteration against a dedicated dev Slack app, see the `dev-bot-up`
> workflow; `CLAUDE.md` has the full operational playbook.

### Model backend

The SDK reads its backend from the environment — pick one:

```sh
# Amazon Bedrock
CLAUDE_CODE_USE_BEDROCK=1
AWS_BEARER_TOKEN_BEDROCK=…
AWS_REGION=us-east-1
MODEL_NAME=us.anthropic.claude-sonnet-4-6   # or bedrock://…

# …or the Anthropic API
ANTHROPIC_API_KEY=sk-ant-…
MODEL_NAME=claude-sonnet-4-6
```

## Tools

Each tool is one file under `src/tenant/model/tools/` (schema + `describe` + `invoke`); the SDK
calls them as MCP tools. Built-ins:

`bash` · `read_file` · `write_file` · `edit_file` · `fetch_url` · `web_search` · `read_page` ·
`get_current_time` · `ask_user` · `share_file` · `github_create_pr` · `github_update_pr` ·
`github_pr_comment`.

Overlay images add their own tools without forking core by pointing `AGENTA_EXTRA_TOOLS` at one
or more directories of tool modules.

## Testing

```sh
bun run test     # unit tests, co-located in src/ — never hit Slack or a real model
bun run e2e      # end-to-end against real Slack; the model is a mock SSE server, not a real one
bun run lint     # biome
```

End-to-end tests boot the bot + tenant in-process against a real Slack workspace, but point the
SDK subprocess at a local **mock-model** server (`tests/e2e/mock-model.ts`) via
`ANTHROPIC_BASE_URL` — so turns are deterministic and cost nothing.

## Repo layout

```
src/
  bot/         Slack ingress: Socket Mode, routing, forward to tenant
  tenant/      agent harness:
    runtime/   handler, session state machine, the SDK turn (sdk-turn/sdk-stream/sdk-attachments)
    model/     sdk/ (MCP bridge) + tools/ (the tool registry)
    sandbox/   docker | fly | ecs providers + HTTP client
    persistence/  append-only JSONL event store + attachments
    git/       per-session git transport (tunnel or direct)
    slack/     post/edit/react + markdown→mrkdwn
  shared/      bot↔tenant wire types, route resolver, lockfile, logger
config/        tenants.json (routing + per-channel home)
sandbox/       sandbox container image + in-container HTTP server
tests/e2e/     end-to-end suite + mock-model server
```

## Tech stack

Bun · TypeScript (functional, no classes) · `@slack/socket-mode` + `@slack/web-api` ·
`@anthropic-ai/claude-agent-sdk` · `biome` · Docker / Fly / ECS sandboxes.

---

`CLAUDE.md` is the deep operational reference (deployment, env vars, gotchas, session semantics).
The original design lives in `SPEC.md` and the GitHub issue history.
