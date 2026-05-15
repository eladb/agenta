import { existsSync } from 'node:fs';
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '../log';
import { dataRoot, ensureThreadDir, threadDir } from '../persistence/store';

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

// Per-thread git-backed-botspace routing. `ref` is the
// agenta/sessions/<thread_key> branch the pre-receive hook restricts pushes
// to. The phase-22/23 `pubkey_fp` field is tolerated on read (sessions
// written before the WS-tunnel transport landed may still carry it) but
// the bootstrap no longer writes it.
export type GitRecord = {
  ref: string;
  // Backwards-compat field. Phase 22 wrote the SHA256 fingerprint of the
  // per-session ed25519 key here; phase 24 ignores it.
  pubkey_fp?: string;
};

// Per-thread runtime state. The file now persists even when the thread is
// idle — it carries the frozen `system_prompt` across turns so each thread's
// prompt is stable for its lifetime. Recovery filters on status !== 'idle'.
export type SessionState = {
  status: 'idle' | 'running' | 'stopping';
  updated_at: string;
  system_prompt?: string;
  sandbox?: SandboxRecord;
  git?: GitRecord;
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
