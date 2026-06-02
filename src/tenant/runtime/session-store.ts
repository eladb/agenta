import { existsSync } from 'node:fs';
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '../../shared/log';
import { dataRoot, ensureThreadDir, threadDir } from '../persistence/store';
import type { DisplayConfig, HomeConfig, ModelTriplet } from './home-config';

// Provider-tagged routing info for a thread's sandbox. Persisted into
// session.json so per-thread sandboxes survive a bot restart: on the next
// mention the provider re-hydrates from this record (verifying liveness)
// instead of provisioning a fresh container/machine. Token is the per-
// sandbox SANDBOX_TOKEN bearer; it also lives in the container's env so it
// survives container restart. Docker doesn't persist the host port because
// Docker Desktop reassigns it on container restart — `docker port` is read
// fresh on every getEndpoint call.
//
// The `volume_name` / `volume_id` field is the per-thread persistent volume
// mounted at /home/sandbox. Optional for backwards-compat with already-
// running sandboxes whose records were written before the volumes work
// landed; those threads just won't have a volume to clean up. Fresh
// provisions always populate it.
export type SandboxRecord =
  | {
      provider: 'docker';
      container_name: string;
      token: string;
      volume_name?: string;
    }
  | {
      provider: 'fly';
      machine_id: string;
      token: string;
      volume_id?: string;
      // The Fly Machines `private_ip` field — a fdaa::/16 IPv6 address
      // reachable over the user's WireGuard mesh. Used by the per-thread
      // reverse-SSH tunnel (Phase 23). Optional for backwards compat with
      // records written before this landed (consistent with how
      // volume_id was rolled out in phase 16).
      private_ip?: string;
    }
  | {
      // ECS Fargate sandbox (#213, refactored #218). Per-thread
      // `ecs run-task` against a sandbox cluster + per-thread subdirectory
      // on a shared EFS filesystem mounted at /efs in the sandbox
      // container. Per-thread isolation is the directory path —
      // SANDBOX_WORKSPACE_DIR=/efs/<thread-slug> is injected via
      // run-task container overrides so the same task definition can
      // serve every thread without registering a new revision. The bot
      // dials the task's private IP on port 9000 (in-VPC routing only —
      // no ALB, no public surface). `task_arn` survives across bot
      // restarts; the task itself stays running but task ENIs get a
      // fresh `private_ip` on each RunTask, so we re-resolve via
      // DescribeTasks before every getEndpoint call when the in-memory
      // cache is empty. `workspace_path` is durable metadata — the
      // directory on EFS survives across task restarts so a new task
      // with the same path picks up the previous turn's files.
      provider: 'ecs';
      task_arn: string;
      workspace_path: string;
      sandbox_token: string;
      // Cached private IP from the most recent DescribeTasks. Optional
      // because (a) the field can be missing immediately after RunTask
      // before the ENI attaches, (b) we re-resolve on demand if absent.
      private_ip?: string;
    };

// Per-thread git-backed agent home routing. `ref` is the
// agenta/sessions/<thread_key> branch the pre-receive hook restricts pushes
// to. The phase-22/23 `pubkey_fp` field is tolerated on read (sessions
// written before the WS-tunnel transport landed may still carry it) but
// the bootstrap no longer writes it.
export type GitRecord = {
  ref: string;
  // Backwards-compat field. Phase 22 wrote the SHA256 fingerprint of the
  // per-session ed25519 key here; phase 24 ignores it.
  pubkey_fp?: string;
  // Slack user who originated this thread (first mentioner). Resolved
  // once on first mention via users.info and cached so we don't re-query
  // on every bootstrap. Used to configure git user.email + user.name
  // inside the sandbox so commits land under the human's identity.
  // Optional — may be absent on threads created before phase 25, or when
  // the lookup failed (denied scopes, deleted account, etc.).
  creator?: { email: string; name: string };
};

// Per-thread runtime state. The file persists even when the thread is idle
// so per-thread routing (sandbox / git / home / model / display) survives
// across turns. Recovery filters on status !== 'idle'.
//
// `home` is a snapshot of the envelope's home spec (#253) frozen on first
// mention. Stored as the raw HomeConfig (remote + auth_env); slug, transport,
// and paths derive on read via `resolveTransport` so future bot config edits
// only affect new threads.
//
// The system prompt is intentionally NOT persisted here — it's rebuilt
// from disk on every mention via `buildSystemPrompt()` so edits to the
// universal suffix (prompt.ts) and the home repo's README.md / skills/
// propagate to existing threads on the next mention.
export type SessionState = {
  status: 'idle' | 'running' | 'stopping';
  updated_at: string;
  sandbox?: SandboxRecord;
  git?: GitRecord;
  home?: HomeConfig;
  // Frozen per-thread model triplet (#128). Snapshotted on first mention
  // from the tenant's env-derived fallback so README/skills edits and
  // bot-side tenants.json mid-thread swaps don't change the active model
  // mid-conversation. Only the env-var NAME is stored; the secret value is
  // read at every call via `process.env[api_key_env]`.
  model?: ModelTriplet;
  // Frozen per-thread display style (#141). Snapshotted on first mention
  // so mid-thread config swaps don't change the UX mid-conversation.
  // Missing = `verbose` (default).
  display?: DisplayConfig;
};

const RUNTIME_FILENAME = 'session.json';

function runtimePath(threadKey: string): string {
  return join(threadDir(threadKey), RUNTIME_FILENAME);
}

export async function writeSession(threadKey: string, state: SessionState): Promise<void> {
  ensureThreadDir(threadKey);
  const final = runtimePath(threadKey);
  const tmp = `${final}.tmp.${process.pid}.${Date.now()}`;
  try {
    await writeFile(tmp, JSON.stringify(state), 'utf8');
    await rename(tmp, final);
  } catch (err) {
    // Best-effort: never block the turn on persistence. Worst case is the
    // restart-recovery announcement doesn't fire for this thread.
    log.warn('runtime', `writeSession(${threadKey}) failed: ${(err as Error).message}`);
    await rm(tmp, { force: true }).catch(() => {});
  }
}

export async function readSession(threadKey: string): Promise<SessionState | undefined> {
  const path = runtimePath(threadKey);
  if (!existsSync(path)) return undefined;
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as SessionState;
    if (parsed.status !== 'idle' && parsed.status !== 'running' && parsed.status !== 'stopping') {
      return undefined;
    }
    return parsed;
  } catch (err) {
    log.warn('runtime', `readSession(${threadKey}) failed: ${(err as Error).message}`);
    return undefined;
  }
}

// Per-threadKey serialization for read-modify-write of session.json (#254
// review #6). Each setter below (and the status flips in session.ts) reads
// the current record, mutates one field, and writes the whole thing back.
// With the bot↔tenant split, `/events` is concurrent, so two of these can
// interleave — e.g. `setGit` reads before `setSandbox` writes, then `setGit`
// writes back its stale view and DROPS the sandbox handle. The result is a
// thread whose sandbox task is running but whose session.json has no
// `sandbox` field, so every later turn reports "sandbox not initialized".
// Chaining all mutations for a given threadKey through one promise tail makes
// each read-modify-write atomic w.r.t. the others (single-process tenant).
const sessionLocks = new Map<string, Promise<unknown>>();

function withSessionLock<T>(threadKey: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionLocks.get(threadKey) ?? Promise.resolve();
  // Run fn after prev settles (success OR failure) so one bad write can't
  // wedge the chain. `run` carries fn's real result to the caller.
  const run = prev.then(fn, fn);
  // Store a rejection-swallowed tail so the next waiter never sees fn's error.
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  sessionLocks.set(threadKey, tail);
  // Drop the map entry once we're the last in line (bounds the map by the
  // number of threads with in-flight writes, not all threads ever seen).
  void tail.then(() => {
    if (sessionLocks.get(threadKey) === tail) sessionLocks.delete(threadKey);
  });
  return run;
}

// The single read-modify-write primitive. `mutate` receives the current
// on-disk state (or undefined) and returns the next full state, or undefined
// to skip the write. Runs under the per-threadKey lock so concurrent callers
// serialize instead of clobbering each other. `updated_at` is stamped here so
// callers never have to.
export async function updateSession(
  threadKey: string,
  mutate: (prev: SessionState | undefined) => SessionState | undefined,
): Promise<void> {
  await withSessionLock(threadKey, async () => {
    const prev = await readSession(threadKey);
    const next = mutate(prev);
    if (next === undefined) return;
    next.updated_at = new Date().toISOString();
    await writeSession(threadKey, next);
  });
}

// Spread only the routing fields that survive a status transition / clear.
// Centralizes the "preserve sandbox/git/home/model/display" list so the
// status flips in session.ts and clearSession stay in sync.
export function preservedFields(prev: SessionState | undefined): Partial<SessionState> {
  if (!prev) return {};
  return {
    ...(prev.sandbox !== undefined ? { sandbox: prev.sandbox } : {}),
    ...(prev.git !== undefined ? { git: prev.git } : {}),
    ...(prev.home !== undefined ? { home: prev.home } : {}),
    ...(prev.model !== undefined ? { model: prev.model } : {}),
    ...(prev.display !== undefined ? { display: prev.display } : {}),
  };
}

// "Clear" no longer means delete — going idle leaves the file in place with
// status: 'idle' so the sandbox / git / home / model / display records
// survive across turns. `/delete` removes the entire thread dir, which takes
// session.json with it.
export async function clearSession(threadKey: string): Promise<void> {
  await updateSession(threadKey, (existing) => ({
    status: 'idle',
    updated_at: '',
    ...preservedFields(existing),
  }));
}

// Atomic read-modify-write that sets (or clears, when undefined) the
// sandbox routing record on a thread's session.json, preserving every other
// field. Called by provider implementations after they provision, reattach,
// or destroy a sandbox. No-op on the disk side when there's no session.json
// yet — that means the thread has never been mentioned, which shouldn't
// happen via the normal flow but we tolerate it.
export async function setSandbox(
  threadKey: string,
  sandbox: SandboxRecord | undefined,
): Promise<void> {
  await updateSession(threadKey, (existing) => {
    if (!existing) {
      if (sandbox === undefined) return undefined;
      // No prior state: write a minimal idle record carrying just the sandbox.
      // This branch shouldn't be exercised in practice (handler always writes a
      // 'running' record before any tool — and therefore any sandbox — runs),
      // but it keeps the API total.
      return { status: 'idle', updated_at: '', sandbox };
    }
    const next: SessionState = { ...existing };
    if (sandbox !== undefined) next.sandbox = sandbox;
    else delete next.sandbox;
    return next;
  });
}

// Atomic read-modify-write of the `git` record (symmetric with setSandbox).
// Called by `ensureRepoBootstrap` once it's generated a keypair + added it
// to authorized_keys. `undefined` clears the record (used for cleanup).
export async function setGit(threadKey: string, git: GitRecord | undefined): Promise<void> {
  await updateSession(threadKey, (existing) => {
    if (!existing) {
      if (git === undefined) return undefined;
      return { status: 'idle', updated_at: '', git };
    }
    const next: SessionState = { ...existing };
    if (git !== undefined) next.git = git;
    else delete next.git;
    return next;
  });
}

// Atomic read-modify-write of the `home` record (#87). Called once on
// first mention by `handler.ts`. The frozen snapshot is the HomeConfig
// only (remote + auth_env) — slug, transport, and paths recompute on
// read via `resolveTransport`. `undefined` clears the field.
export async function setHome(threadKey: string, home: HomeConfig | undefined): Promise<void> {
  await updateSession(threadKey, (existing) => {
    if (!existing) {
      if (home === undefined) return undefined;
      return { status: 'idle', updated_at: '', home };
    }
    const next: SessionState = { ...existing };
    if (home !== undefined) next.home = home;
    else delete next.home;
    return next;
  });
}

// Atomic read-modify-write of the `model` triplet (#128). Symmetric with
// setHome — called once on first mention from `handler.ts`. The frozen
// snapshot is just the triplet (name + base_url + api_key_env); the API key
// value is read at use time, never persisted here.
export async function setModel(threadKey: string, model: ModelTriplet | undefined): Promise<void> {
  await updateSession(threadKey, (existing) => {
    if (!existing) {
      if (model === undefined) return undefined;
      return { status: 'idle', updated_at: '', model };
    }
    const next: SessionState = { ...existing };
    if (model !== undefined) next.model = model;
    else delete next.model;
    return next;
  });
}

// Atomic read-modify-write of the `display` config (#141). Symmetric with
// setModel. Called once on first mention from `handler.ts`. `undefined`
// clears the field (the thread reverts to verbose default on read).
export async function setDisplay(
  threadKey: string,
  display: DisplayConfig | undefined,
): Promise<void> {
  await updateSession(threadKey, (existing) => {
    if (!existing) {
      if (display === undefined) return undefined;
      return { status: 'idle', updated_at: '', display };
    }
    const next: SessionState = { ...existing };
    if (display !== undefined) next.display = display;
    else delete next.display;
    return next;
  });
}

export async function listSessions(): Promise<Array<{ threadKey: string; state: SessionState }>> {
  const root = dataRoot();
  if (!existsSync(root)) return [];
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (err) {
    log.warn('runtime', `listSessions scan failed: ${(err as Error).message}`);
    return [];
  }
  const out: Array<{ threadKey: string; state: SessionState }> = [];
  for (const name of entries) {
    const state = await readSession(name);
    if (state) out.push({ threadKey: name, state });
  }
  return out;
}
