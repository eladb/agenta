# Persist sandbox endpoint in session.json

Status: ready for subagent
Owner: parent session (Claude)
Branch: dispatched in worktree

## Goal

Make per-thread sandboxes survive bot restarts. Today every `bun start` boots
with `killAllSandboxContainers()`, wiping every container/machine because the
provider's in-memory `{threadKey → endpoint}` cache is gone and orphans are
unreachable. With this change we persist the routing info (provider name +
provider-specific identity + token) into `session.json`, drop the boot-time
wipe, and reattach to live sandboxes on demand.

Net effect: a user can mention the bot, the bot provisions a sandbox, work
gets done, the bot restarts, the user mentions again — the same sandbox is
reused. `/delete` is still the only way to nuke a sandbox.

## Locked design

### Session.json schema extension

`SessionState` gains an optional `sandbox` field. Persisted only by the
provider layer (callers don't construct it).

```ts
export type SessionState = {
  status: 'idle' | 'running' | 'stopping';
  updated_at: string;
  system_prompt?: string;
  sandbox?: SandboxRecord;  // provider-tagged routing info
};

export type SandboxRecord =
  | { provider: 'docker'; container_name: string; token: string }
  | { provider: 'fly'; machine_id: string; token: string };
```

Notes:
- `token` is the per-sandbox `SANDBOX_TOKEN` bearer. Survives container
  restart because it's also in the container's env.
- Docker does NOT persist the host port — `getEndpoint` re-reads via
  `docker port` on every call (matches today's behavior, handles Docker
  Desktop's port reassignment).
- Fly persists the machine ID; baseUrl is derived from
  `https://{FLY_APP_NAME}.fly.dev` + `fly-force-instance-id: {machine_id}`
  header, same as today.
- Cross-provider switch (user flips `SANDBOX_PROVIDER`): if the persisted
  `sandbox.provider` doesn't match the configured provider, treat it as no
  sandbox (and log a warning). Don't try to migrate.

### Provider API changes

The `SandboxProvider` interface stays as-is. The semantics of three methods
change:

- `ensure(threadKey)` — now also writes `SandboxRecord` to session.json
  after the underlying container/machine becomes reachable. Idempotent: if
  in-memory state is already populated, no disk write. If in-memory state is
  empty BUT disk has a record, treat that as "already provisioned for this
  thread" — verify liveness, re-hydrate in-memory cache, and skip creating
  a new one. Only create new if both layers are empty (or disk record is
  dead).
- `getEndpoint(threadKey)` — if in-memory cache has the entry, return it
  (current behavior). If not, read from session.json; if found, verify
  liveness (cheap call: `docker inspect` / `machines GET`); if alive,
  populate in-memory cache and return. If not found or dead, throw a
  "sandbox not provisioned" error so the caller knows to `ensure` first.
- `remove(threadKey)` — clears the in-memory entry AND clears the `sandbox`
  field from session.json (preserving the rest of the file). If the thread
  has no session.json, no-op on the disk side.
- `killAll()` — provider-internal sweep (existing behavior). Also walks
  every session.json under `data/*/` and clears their `sandbox` fields.
  No longer called on boot. Still useful for tests; not part of the runtime
  hot path.
- `listAll()` — new method on the provider interface. Returns the IDs of
  every sandbox this provider currently owns. Used by the orphan reap.
  Docker: `docker ps --filter name=agenta- --format '{{.Names}}'`. Fly:
  `GET /v1/apps/{app}/machines`.
- `isReady(threadKey)` — stays sync, in-memory check, current semantics.
  Drives the "provisioning workspace…" UI which should still appear after a
  bot restart for the first sandbox-touching tool call (the re-hydration
  step has a non-trivial latency).

### Boot-time wipe → orphan reap

`src/index.ts` drops the `killAllSandboxContainers()` call. Sandboxes now
survive bot restarts; routine cleanup happens via `/delete`, which already
removes the thread dir + the sandbox.

In its place, a new boot-time **orphan reap**: scan provider-owned
containers/machines (those matching the `agenta-*` prefix on Docker, or all
machines in the configured Fly app), cross-reference against existing
session.json sandbox records, and destroy any with no matching session.
With persistent sessions this rarely fires — its purpose is to clean up
after edge cases like `rm -rf data/` without `/delete`. Errors during reap
are logged but don't block boot.

Implementation hint: add `reapOrphanSandboxes()` exported from
`src/sandbox/index.ts` that delegates to a new provider method
`listAll(): Promise<Array<{id: string}>>` (or extend an existing one).
Cross-reference against `listSessions()` from session-store. Run it once
in `src/index.ts` after `connect()` but before `recoverInterruptedSessions`.

`recoverInterruptedSessions(web)` is unchanged.

### Liveness verification

- **Docker**: `docker inspect --format '{{.State.Running}}' {container_name}`
  returns `true` for live, errors or returns `false` otherwise. Wrap with a
  ~3s timeout via AbortSignal so a hung Docker daemon doesn't block a turn.
- **Fly**: `GET /v1/apps/{app}/machines/{machine_id}`, check
  `state === 'started'`. Same timeout.

A dead record gets removed from session.json so the next `ensure` provisions
fresh without an extra round-trip.

### Edge cases

- **Concurrent mentions during re-hydration**: the session.ts state machine
  already serializes turns per thread; only one turn re-hydrates at a time.
- **Container died mid-turn after re-hydration**: the underlying HTTP call
  to `/exec` fails, the tool returns an error tool_result, the model sees it
  and can decide to retry. We don't add a magic auto-reprovision-on-failure
  path — that's a separate decision.
- **Stale Fly machine that auto-stopped (trial cap)**: liveness check
  returns `state !== 'started'`; treated as dead; re-provisioned. The token
  is also persisted in the new machine's env, so a fresh machine gets a
  fresh token — the disk record is fully rewritten.
- **Race with /delete**: `/delete` rms the whole thread dir, which removes
  session.json. The provider's `remove(threadKey)` is best-effort.

### What's NOT in scope

- DoH-based DNS resolution on Fly (separate known issue).
- Fly egress block fix (separate known issue).
- Host-side Docker egress block.
- Persisted dedupe + pending-mention queue across restarts.

## File-by-file change plan

### Modified

- `src/runtime/session-store.ts` — extend `SessionState` to include
  `sandbox?: SandboxRecord`. `SandboxRecord` itself lives here (it's
  routing metadata, not state machine concern). `clearSession` /
  `writeSession` already pass arbitrary state through; should need no
  change beyond type. Add a focused helper:
  `setSandbox(threadKey, sandbox | undefined)` — atomic read-modify-write
  that preserves all other fields. Providers call this.
- `src/sandbox/provider.ts` — re-export `SandboxRecord` for provider impls
  if convenient, or providers import directly from session-store. No new
  methods on the interface.
- `src/sandbox/docker.ts` — `ensure` writes the record after readiness;
  `ensure` first attempts re-hydration from disk; `getEndpoint` falls back
  to disk re-hydration when in-memory is empty; `remove` clears disk record;
  `killAll` sweeps every session.json's sandbox field. Add a `verifyAlive`
  internal helper and the `listAll` method.
- `src/sandbox/fly.ts` — same change shape as docker.ts.
- `src/sandbox/index.ts` — add `reapOrphanSandboxes()` that calls the
  provider's `listAll()`, cross-references with `listSessions()`, and
  destroys any provider-owned sandboxes with no matching session record.
  Errors logged, not thrown.
- `src/index.ts` — drop the `killAllSandboxContainers()` call. Add a call
  to the new `reapOrphanSandboxes()` after `connect()`. Update the comment
  to explain: sandboxes persist; orphan reap is the safety net.
- `CLAUDE.md` — add a Phase 14 note, update Phase 11 to remove the "boot
  wipe" detail, update "Known issues / gotchas" to mention sandbox
  persistence behavior.

### New

- No new files unless the subagent finds a natural place for shared
  re-hydration logic between docker and fly. If they look identical
  enough, a `src/sandbox/persistence.ts` with `loadSandbox(threadKey)`,
  `saveSandbox(threadKey, rec)`, `clearSandbox(threadKey)`, and
  `sweepAllSandboxes()` is fine and keeps each provider focused on its
  native lifecycle. Use judgment.

## Tests

### Unit

- `src/sandbox/docker.test.ts` (extend):
  - `ensure` writes session.json record after readiness; second
    `ensure` reads it back without spawning a new container; record
    contains correct `container_name` + `token` + `provider: 'docker'`.
  - `remove` clears the disk record while preserving `system_prompt` and
    `status` in session.json (regression test for the schema merge).
  - `killAll` sweeps every session.json sandbox field across `data/*/`.
- `src/sandbox/fly.test.ts` (extend, fetch-stubbed): analogous.
- `src/runtime/session-store.test.ts` (extend): `setSandbox` atomic
  read-modify-write preserves `system_prompt` and `status`.

Also: provider-level `listAll()` returns provisioned sandboxes only; unit-test
docker.ts with a stub or live (Docker-gated) that creates one container,
asserts it shows up in listAll, removes it, asserts it doesn't.

`reapOrphanSandboxes` unit test (`src/sandbox/index.test.ts` if missing,
else extend): stub the provider's `listAll` to return three IDs; stub
`listSessions` to claim two of them have matching sandbox records; assert
the third gets destroyed via the provider's `remove`-equivalent.

### E2E

- `tests/e2e/sandbox-persistence.test.ts` (new, Docker-gated):
  1. Start agent A (in-process), mention with a bash tool to provision a
     sandbox + write a file `/workspace/marker`.
  2. Capture the container_name from `data/{tk}/session.json`.
  3. Stop agent A. Confirm container is still running via
     `docker inspect`.
  4. Start agent B (in-process). Mention with a bash tool that reads
     `/workspace/marker`. Assert the read succeeds (proving same
     sandbox, not a fresh one).
  5. Cleanup with `removeContainer` (or `/delete` mention).

  Skip on machines without Docker (`HAS_DOCKER` env flag, same pattern as
  existing Docker-gated tests).

- `tests/e2e/sandbox-persistence-dead.test.ts` (new, Docker-gated):
  Same setup as above, but before agent B starts, `docker rm -f` the
  container. Agent B's mention should re-provision (new container_name in
  session.json) without erroring out the turn. The marker file should NOT
  be there in the new sandbox.

### Manual verification before declaring done

1. `bun run test` — all green.
2. `bun run lint` — clean for files you author/edit (don't fix pre-existing
   baseline noise).
3. `tsc --noEmit` — clean.
4. `bun run e2e` — all green (skip-counts unchanged or smaller).
5. Manual: with `SANDBOX_PROVIDER=docker`, mention bot → run a bash tool →
   restart bot → mention again → tool result should reference the same
   container (e.g. a file written before survives).

## Open questions to NOT decide silently

Stop and report if any of these come up:

- Should `verifyAlive` happen on `getEndpoint` (lazy, per-request) or just
  once during `ensure`'s re-hydration path? The spec assumes the latter
  (verify once at re-hydration; trust thereafter). If you find a case where
  the in-memory cache survives but the container died (Docker Desktop
  restart, etc.), revisit.
- Should `setSandbox` live in session-store.ts (current spec) or be a
  method on the provider? Current spec says session-store, because it's
  the file that owns the schema. If providers end up needing more than
  setSandbox, consider hoisting into a helper.

## Self-check before reporting done

- [ ] All tests pass (`bun run test`, `bun run e2e`).
- [ ] `bun run lint` clean for files I touched.
- [ ] Typecheck clean.
- [ ] Bot restart + mention reuses existing Docker container (manual or
  e2e).
- [ ] Bot restart + mention re-provisions when the container is dead.
- [ ] session.json after `remove` preserves `system_prompt` and `status`.
- [ ] No reference to `killAllSandboxContainers` in `src/index.ts`.
- [ ] Boot calls `reapOrphanSandboxes()`; orphans created by hand
  (`docker run` outside the bot, then bot starts) get cleaned.
- [ ] CLAUDE.md updated.

## Worktree setup hint

1. Read CLAUDE.md and this spec end-to-end.
2. Skim the files listed in "Modified" before changing anything.
3. The skills feature landed in commit `9668580` and renames landed in
   `dc7391c` on main — your worktree should be at or after that.
4. Run unit + lint + typecheck before running e2e. E2E is environmentally
   flaky right now (Slack token sharing with the production agent) — if you
   see flaky test failures that aren't this feature, mention them but
   don't try to fix.
