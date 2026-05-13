# Per-thread persistent sandbox volumes

Status: ready for subagent
Owner: parent session (Claude)
Branch: dispatched in worktree

## Goal

Make sandbox state survive machine replacement, not just bot restart. Today's
`sandbox-persistence` work reattaches to the *same* container/machine on bot
restart — but the underlying machine is still ephemeral. Fly trial machines
auto-stop after 5 minutes, machines die on image upgrades, OOM kills happen.
All of that wipes the workspace.

With per-thread persistent volumes, the user's home dir (= workspace) lives
on a volume that survives the machine. We can replace the machine freely and
reattach the same volume. State, caches, user-installed tools, the botspace
— all persist.

Net effect for the user: long-running threads that survive everything except
explicit `/delete`. Fly's 5-min trial cap becomes a non-issue.

## Locked design

### Mount point: home dir = workspace

The volume mounts at `/home/sandbox`. The sandbox HTTP server runs with
`cwd=/home/sandbox`. `/workspace` is **dropped entirely** — all code, system
prompt hints, attached-suffix strings, system prompts, etc. that reference
`/workspace` get updated to reference `/home/sandbox` (or no path, relying
on cwd).

Concrete renames:
- `sandbox/server/server.ts`: `const WORKSPACE = '/workspace'` →
  `'/home/sandbox'`. `cwd: WORKSPACE` stays correct.
- `sandbox/Dockerfile`: drop the `mkdir /workspace`. The home dir is
  created by `useradd --create-home`. The botspace image-time COPY now
  targets `/opt/botspace/` (seed source), not `/home/sandbox/`.
- `src/model/context.ts:buildAttachedSuffix` — `[attached: attachments/<id>-<name>]`
  is relative, no change. Verify nothing hard-codes `/workspace`.
- `src/sandbox/index.ts:syncAttachmentsToSandbox` — `attachments/<basename>`
  path is relative, no change. Verify.
- System prompt in CLAUDE.md / spec docs / sandbox/botspace/README.md —
  search for `/workspace` and update.

### Lifecycle: trust /delete

One volume per thread. `/delete` (which already exists) calls
`provider.remove(threadKey)` — now extended to destroy the volume in
addition to the machine. No background sweep, no auto-reap of idle
volumes. Document the cost model in CLAUDE.md: ~$0.15/mo per 1 GB Fly
volume × number of active threads.

Defensive helper for orphan audit: `bun run list-orphan-volumes` script
that lists volumes-without-sessions for manual cleanup. Optional;
skip if it bloats the diff.

### Docker symmetry: named volumes per thread

Local Docker provider also gains named volumes (`agenta-vol-<threadKey>`).
`ensure` creates the volume + mounts it at `/home/sandbox`. `remove`
runs `docker volume rm`. Same lifecycle as Fly. Dev experience matches
prod.

The existing anonymous-volume code path goes away. Migration: any existing
threads with anonymous volumes get fresh named volumes on next provision
(their data is lost, but this is dev state, no real migration needed).

### Seeding: entrypoint copy-if-missing

Image build:
- `COPY --chown=sandbox:sandbox botspace /opt/botspace/` (instead of
  /workspace/). The seed lives at `/opt/botspace/` in the image.

Entrypoint script:
- Before `setpriv`-ing down + execing the server, check if
  `/home/sandbox/README.md` exists.
- If missing → `cp -r /opt/botspace/. /home/sandbox/`. Ownership stays
  uid 1000 (the COPY did the right thing; cp -p preserves).
- If present → no-op (volume already seeded).
- Idempotent. Restart-safe.

This runs after the iptables setup but before the privilege drop, so
root can still write to the volume mount (sandbox user owns it, so
either root or sandbox can write — root is fine).

Snapshot-based pre-warm and pools are explicitly OUT of scope; entrypoint
copy is the simplest workable path. Backlog item if first-mention latency
becomes an issue.

### Update policy: never update existing volumes

Once a thread's volume is seeded, that's it. Botspace edits + image
redeploys don't propagate to existing volumes — same semantics as the
frozen per-thread system prompt. User can `/delete` to force a fresh seed.

This means: no migration logic, no merge logic, no "is this file newer in
the seed than the volume" check. Volumes are write-once-by-seed,
then-owned-by-the-thread.

### Session.json schema extension

`SandboxRecord` gains a volume field (provider-specific, optional for
backwards-compat with already-running sandboxes):

```ts
type SandboxRecord =
  | { provider: 'docker'; container_name: string; token: string; volume_name?: string }
  | { provider: 'fly'; machine_id: string; token: string; volume_id?: string };
```

`remove()` now also destroys the volume after the machine/container. The
liveness check stays at the machine/container level (volume liveness is
implicit — if the machine is alive and the volume mounted, it's reachable).

## Provider implementation hints

### Docker

- New: `docker volume create agenta-vol-<threadKey>` in `ensure`.
- `docker run` adds `-v agenta-vol-<threadKey>:/home/sandbox`.
- `remove`: `docker rm -f` the container, then `docker volume rm` the
  volume (best-effort, error if container holds reference still).
- `killAll`: in addition to today's container sweep, sweep all volumes
  with the `agenta-vol-` prefix.
- `listAll`: includes both containers AND orphan volumes (a volume with
  no matching container is also an orphan from the bot's POV; report it
  so `reapOrphanSandboxes` can clean it up).
- Persist `volume_name` in the SandboxRecord.

### Fly

- `POST /v1/apps/{app}/volumes` to create the volume (size_gb: 1 to start).
  Region: same as the machine will run in (`source` region).
- Machine create: include the volume mount config so the machine starts
  with the volume attached at `/home/sandbox`.
- `remove`: destroy the machine first (`DELETE
  /v1/apps/{app}/machines/{id}?force=true`), then destroy the volume
  (`DELETE /v1/apps/{app}/volumes/{id}`).
- Persist `volume_id` in the SandboxRecord.
- `listAll` and `killAll`: same pattern as docker — sweep volumes in
  addition to machines. Volumes without a session.json record are
  orphans.

### Re-hydration

When a process restart brings the bot back up and the thread is
mentioned again:
- session.json has `volume_id` + (potentially stale) `machine_id`.
- Liveness-check the machine. If dead, **create a new machine** with the
  existing volume mounted. The botspace seeding step is a no-op (entrypoint
  sees ~/README.md already exists). Persist the new `machine_id` to
  session.json. Volume_id is unchanged.
- This is the new value-add: previously a dead machine = thread state lost;
  now it's = new machine, same volume, same state.

## File-by-file change plan

### Modified

- `sandbox/Dockerfile`:
  - Remove `mkdir /workspace; chown sandbox:sandbox /workspace`.
  - Change `COPY botspace /workspace/` → `COPY --chown=sandbox:sandbox
    botspace /opt/botspace/`.
  - `WORKDIR /home/sandbox` (was /workspace).
- `sandbox/entrypoint.sh`:
  - After iptables setup, before `setpriv` to sandbox user: check `[ -e
    /home/sandbox/README.md ]`; if missing, `cp -r /opt/botspace/.
    /home/sandbox/` and chown to sandbox:sandbox.
- `sandbox/server/server.ts`:
  - `const WORKSPACE = '/home/sandbox'` (was `/workspace`).
- `src/sandbox/provider.ts`:
  - Extend `SandboxRecord` union with `volume_name?` (docker) /
    `volume_id?` (fly).
- `src/sandbox/docker.ts`:
  - `ensure`: create named volume; pass `-v vol:/home/sandbox` to docker run.
  - `remove`: rm container then rm volume.
  - `listAll`: report both containers and orphan volumes.
  - `killAll`: sweep both.
  - Persist `volume_name` in the record.
- `src/sandbox/fly.ts`:
  - `ensure`: POST /volumes; include mount config in machine create.
  - Re-hydration path: if machine dead but volume alive, create new
    machine attached to existing volume.
  - `remove`: machine then volume.
  - `listAll`, `killAll`: same.
  - Persist `volume_id` in the record.
- `src/sandbox/index.ts`:
  - `reapOrphanSandboxes`: walk both containers/machines AND volumes;
    cross-reference both against session.json.
- `src/runtime/session-store.ts`:
  - Update the `SandboxRecord` type with the new optional volume fields.
  - Update tests.
- `src/model/context.ts`, `src/sandbox/index.ts:syncAttachmentsToSandbox`:
  - Verify no hard-coded `/workspace` paths. The path strings in
    `[attached: attachments/...]` and the sandbox write path
    `attachments/<basename>` are already relative — no change expected,
    just confirm.
- `CLAUDE.md`:
  - Phase 16 note: persistent volumes per thread, semantics, cost model.
  - Update Phase 6 (sandbox hardening) line that mentions
    `/workspace` to `/home/sandbox`.
  - Update Phase 12 (inbound attachments) reference to `/workspace/attachments`
    → `/home/sandbox/attachments` (or `attachments` relative).
  - Update "Known issues" — Fly 5-min trial cap is no longer fatal (state
    survives machine replacement); note that machine churn during turns
    may briefly stall the bot.
- `sandbox/botspace/README.md`:
  - Update any path references from `/workspace` to `~/` or remove
    explicit paths (use relative).
- `sandbox/botspace/skills/python-charts/SKILL.md`:
  - Same pass.
- `src/index.ts`:
  - System prompt header — if it mentions /workspace, update. (It mostly
    doesn't; the path-aware bits live in `sandbox/botspace/README.md`.)

### New

- `scripts/list-orphan-volumes.ts` (optional; skip if it adds >100 lines
  or feels off-spec). Lists provider volumes without matching session.json
  records. Useful one-off audit tool. Read-only.

## Tests

### Unit (extend existing)

- `src/sandbox/docker.test.ts`:
  - `ensure` creates a named volume; subsequent `ensure` reuses it.
  - `remove` deletes both container and volume.
  - `listAll` reports orphan volumes alongside containers.
  - Re-hydration with stale machine + live volume = new container,
    same volume.
- `src/sandbox/fly.test.ts` (fetch-stubbed):
  - Volume create call is made before machine create.
  - Machine create body includes volume mount config.
  - Re-hydration: machine dead + volume alive → POST /machines with the
    existing volume_id.
  - Remove: machine delete then volume delete.
- `src/sandbox/index.test.ts`:
  - `reapOrphanSandboxes` cleans up orphan volumes whose owning thread
    no longer has a session.

### E2E (Docker-gated)

- `tests/e2e/sandbox-volumes.test.ts`:
  - Mention bot → tool writes a file under `~/marker`.
  - Docker stop + rm the container (simulate machine death; volume
    survives).
  - Mention again → new container, same volume → assert the marker file
    is still there.
  - `/delete` → assert both container and volume gone.
- Update existing `tests/e2e/sandbox-persistence.test.ts` if any assertions
  reference `/workspace` paths.

### Manual verification

1. `bun run test` — all green.
2. `bun run lint` — clean for files you touched.
3. `tsc --noEmit` — clean.
4. `bun run e2e` — all green except documented Slack flakes.
5. Manual: `SANDBOX_PROVIDER=docker bun start`, mention bot, run a bash
   tool that writes `~/test`. Kill the bot. Run `docker stop` + `docker rm`
   on the container (volume stays). Restart bot, mention again. Assert
   that `~/test` is still there.

## Out of scope

- Snapshot-based volume pre-warming and pools (deferred; entrypoint copy
  is the chosen seed mechanism for now).
- Automatic reap of idle volumes (background sweep).
- Per-thread volume size config (1 GB fixed for now; revisit if any user
  hits the limit).
- Pre-installed dependencies in the seed (e.g. pip install common
  packages at image build time) — would shorten model time on second
  mention but is a separate optimization pass.
- Multi-region volume handling. Single region for now (whatever the Fly
  app's primary region is).

## Open questions to NOT decide silently

Stop and report if any of these come up:

- The `cp -r` in entrypoint.sh runs as root before privilege drop. If you
  find a cleaner way (e.g. `chown -R sandbox:sandbox` after, or use
  `runuser`), pick it. But don't add a new external binary just for this.
- Fly volume size — spec says 1 GB. If you discover Fly's actual minimum
  is higher (or there's a sensible default for code workloads), use that
  + note it.
- Migration of existing thread data: if any tests carry hard-coded
  `data/{tk}/...` fixtures expecting `/workspace` paths, they're allowed
  to be updated. Don't preserve back-compat with `/workspace` — clean
  break.

## Self-check before reporting done

- [ ] All tests pass (`bun run test`, `bun run e2e`).
- [ ] `bun run lint` clean for files I touched.
- [ ] Typecheck clean.
- [ ] Docker manual test: file in ~ survives `docker rm`.
- [ ] No remaining `/workspace` references in src/, sandbox/, tests/,
  CLAUDE.md, or specs/ (except this spec describing the rename).
- [ ] CLAUDE.md updated (Phase 16 note + path renames in earlier phases).
- [ ] session.json schema migration: existing sessions with the old
  SandboxRecord shape (no volume_*) still load (volume_* are optional).

## Worktree setup hint

1. Read CLAUDE.md and this spec end-to-end.
2. Skim sandbox/Dockerfile, sandbox/entrypoint.sh, src/sandbox/docker.ts,
   src/sandbox/fly.ts before changing anything.
3. The most recent main commit you should be at-or-after is `ec9d104`
   (golden-run tests).
4. Multi-bot+tool-catalog work is running in parallel on a separate
   worktree. They will touch `src/index.ts`, `src/runtime/handler.ts`,
   and `sandbox/botspace/` differently than you. **Do NOT preemptively
   change anything multi-bot-shaped** — if you see an ambiguous file
   that "looks like it would be cleaner with a per-bot layout," leave
   it alone; the multi-bot subagent owns that surface. Parent session
   merges both, resolves conflicts.

5. Production agent is running on pid 74401. E2E will be flaky from
   Slack token sharing — note flakes, don't fix Slack.
