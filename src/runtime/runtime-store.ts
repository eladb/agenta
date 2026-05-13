import { existsSync } from 'node:fs';
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '../log';
import { dataRoot, ensureThreadDir, threadDir } from '../persistence/store';

// Per-thread runtime state. The file now persists even when the thread is
// idle — it carries the frozen `system_prompt` across turns so each thread's
// prompt is stable for its lifetime. Recovery filters on status !== 'idle'.
export type RuntimeState = {
  status: 'idle' | 'running' | 'stopping';
  updated_at: string;
  system_prompt?: string;
};

const RUNTIME_FILENAME = 'runtime.json';

function runtimePath(threadKey: string): string {
  return join(threadDir(threadKey), RUNTIME_FILENAME);
}

export async function writeRuntime(threadKey: string, state: RuntimeState): Promise<void> {
  ensureThreadDir(threadKey);
  const final = runtimePath(threadKey);
  const tmp = `${final}.tmp.${process.pid}.${Date.now()}`;
  try {
    await writeFile(tmp, JSON.stringify(state), 'utf8');
    await rename(tmp, final);
  } catch (err) {
    // Best-effort: never block the turn on persistence. Worst case is the
    // restart-recovery announcement doesn't fire for this thread.
    log.warn('runtime', `writeRuntime(${threadKey}) failed: ${(err as Error).message}`);
    await rm(tmp, { force: true }).catch(() => {});
  }
}

export async function readRuntime(threadKey: string): Promise<RuntimeState | undefined> {
  const path = runtimePath(threadKey);
  if (!existsSync(path)) return undefined;
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as RuntimeState;
    if (parsed.status !== 'idle' && parsed.status !== 'running' && parsed.status !== 'stopping') {
      return undefined;
    }
    return parsed;
  } catch (err) {
    log.warn('runtime', `readRuntime(${threadKey}) failed: ${(err as Error).message}`);
    return undefined;
  }
}

// "Clear" no longer means delete — going idle leaves the file in place with
// status: 'idle' so the frozen system_prompt survives across turns. Read
// existing state first so we preserve system_prompt when transitioning.
// `/delete` removes the entire thread dir, which takes runtime.json with it.
export async function clearRuntime(threadKey: string): Promise<void> {
  const existing = await readRuntime(threadKey);
  await writeRuntime(threadKey, {
    status: 'idle',
    updated_at: new Date().toISOString(),
    ...(existing?.system_prompt !== undefined ? { system_prompt: existing.system_prompt } : {}),
  });
}

export async function listRuntimes(): Promise<Array<{ threadKey: string; state: RuntimeState }>> {
  const root = dataRoot();
  if (!existsSync(root)) return [];
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (err) {
    log.warn('runtime', `listRuntimes scan failed: ${(err as Error).message}`);
    return [];
  }
  const out: Array<{ threadKey: string; state: RuntimeState }> = [];
  for (const name of entries) {
    const state = await readRuntime(name);
    if (state) out.push({ threadKey: name, state });
  }
  return out;
}
