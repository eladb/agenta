import { existsSync } from 'node:fs';
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '../log';
import { dataRoot, ensureThreadDir, threadDir } from '../persistence/store';
import type { HomeConfig, ModelTriplet } from './home-config';

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

// Per-thread runtime state. The file now persists even when the thread is
// idle — it carries the frozen `system_prompt` across turns so each thread's
// prompt is stable for its lifetime. Recovery filters on status !== 'idle'.
//
// `home` is a snapshot of the per-channel home config (#87) frozen on first
// mention. Stored as the raw HomeConfig (remote + auth_env); slug, transport,
// and paths derive on read via `resolveTransport` so future config edits
// only affect new threads.
export type SessionState = {
  status: 'idle' | 'running' | 'stopping';
  updated_at: string;
  system_prompt?: string;
  sandbox?: SandboxRecord;
  git?: GitRecord;
  home?: HomeConfig;
  // Frozen per-thread model triplet (#128). Snapshotted from
  // `resolveModel(channelId, envFallback)` on first mention so README/skills
  // edits and homes.json mid-thread swaps don't change the active model
  // mid-conversation. Only the env-var NAME is stored; the secret value is
  // read at every call via `process.env[api_key_env]`.
  model?: ModelTriplet;
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

// "Clear" no longer means delete — going idle leaves the file in place with
// status: 'idle' so the frozen system_prompt + sandbox record survive across
// turns. Read existing state first so we preserve those fields when
// transitioning. `/delete` removes the entire thread dir, which takes
// session.json with it.
export async function clearSession(threadKey: string): Promise<void> {
  const existing = await readSession(threadKey);
  await writeSession(threadKey, {
    status: 'idle',
    updated_at: new Date().toISOString(),
    ...(existing?.system_prompt !== undefined ? { system_prompt: existing.system_prompt } : {}),
    ...(existing?.sandbox !== undefined ? { sandbox: existing.sandbox } : {}),
    ...(existing?.git !== undefined ? { git: existing.git } : {}),
    ...(existing?.home !== undefined ? { home: existing.home } : {}),
    ...(existing?.model !== undefined ? { model: existing.model } : {}),
  });
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
  const existing = await readSession(threadKey);
  if (!existing) {
    if (sandbox === undefined) return;
    // No prior state: write a minimal idle record carrying just the sandbox.
    // This branch shouldn't be exercised in practice (handler always writes a
    // 'running' record before any tool — and therefore any sandbox — runs),
    // but it keeps the API total.
    await writeSession(threadKey, {
      status: 'idle',
      updated_at: new Date().toISOString(),
      sandbox,
    });
    return;
  }
  const next: SessionState = {
    ...existing,
    updated_at: new Date().toISOString(),
    ...(sandbox !== undefined ? { sandbox } : {}),
  };
  if (sandbox === undefined) delete next.sandbox;
  await writeSession(threadKey, next);
}

// Atomic read-modify-write of the `git` record (symmetric with setSandbox).
// Called by `ensureRepoBootstrap` once it's generated a keypair + added it
// to authorized_keys. `undefined` clears the record (used for cleanup).
export async function setGit(threadKey: string, git: GitRecord | undefined): Promise<void> {
  const existing = await readSession(threadKey);
  if (!existing) {
    if (git === undefined) return;
    await writeSession(threadKey, {
      status: 'idle',
      updated_at: new Date().toISOString(),
      git,
    });
    return;
  }
  const next: SessionState = {
    ...existing,
    updated_at: new Date().toISOString(),
    ...(git !== undefined ? { git } : {}),
  };
  if (git === undefined) delete next.git;
  await writeSession(threadKey, next);
}

// Atomic read-modify-write of the `home` record (#87). Called once on
// first mention by `handler.ts`. The frozen snapshot is the HomeConfig
// only (remote + auth_env) — slug, transport, and paths recompute on
// read via `resolveTransport`. `undefined` clears the field.
export async function setHome(threadKey: string, home: HomeConfig | undefined): Promise<void> {
  const existing = await readSession(threadKey);
  if (!existing) {
    if (home === undefined) return;
    await writeSession(threadKey, {
      status: 'idle',
      updated_at: new Date().toISOString(),
      home,
    });
    return;
  }
  const next: SessionState = {
    ...existing,
    updated_at: new Date().toISOString(),
    ...(home !== undefined ? { home } : {}),
  };
  if (home === undefined) delete next.home;
  await writeSession(threadKey, next);
}

// Atomic read-modify-write of the `model` triplet (#128). Symmetric with
// setHome — called once on first mention from `handler.ts`. The frozen
// snapshot is just the triplet (name + base_url + api_key_env); the API key
// value is read at use time, never persisted here.
export async function setModel(
  threadKey: string,
  model: ModelTriplet | undefined,
): Promise<void> {
  const existing = await readSession(threadKey);
  if (!existing) {
    if (model === undefined) return;
    await writeSession(threadKey, {
      status: 'idle',
      updated_at: new Date().toISOString(),
      model,
    });
    return;
  }
  const next: SessionState = {
    ...existing,
    updated_at: new Date().toISOString(),
    ...(model !== undefined ? { model } : {}),
  };
  if (model === undefined) delete next.model;
  await writeSession(threadKey, next);
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
