// Thin wrappers around session-store for sandbox-record I/O. Both provider
// implementations need exactly these three operations against the per-thread
// session.json, so we keep them in one place rather than duplicating
// read/writeSession boilerplate in docker.ts and fly.ts.
import { log } from '../../shared/log';
import {
  listSessions,
  readSession,
  type SandboxRecord,
  setSandbox,
} from '../runtime/session-store';

export async function loadSandbox(threadKey: string): Promise<SandboxRecord | undefined> {
  const s = await readSession(threadKey);
  return s?.sandbox;
}

export async function saveSandbox(threadKey: string, record: SandboxRecord): Promise<void> {
  await setSandbox(threadKey, record);
}

export async function clearSandbox(threadKey: string): Promise<void> {
  await setSandbox(threadKey, undefined);
}

// Wipe the sandbox field from every thread's session.json. Used by the
// provider-level `killAll()` so the in-memory and on-disk views agree after
// a sweep. Errors on a single thread don't block the rest.
export async function sweepAllSandboxes(): Promise<void> {
  const all = await listSessions();
  for (const { threadKey, state } of all) {
    if (!state.sandbox) continue;
    try {
      await setSandbox(threadKey, undefined);
    } catch (err) {
      log.warn(
        'sandbox',
        `sweepAllSandboxes: clearing ${threadKey} failed: ${(err as Error).message}`,
      );
    }
  }
}
