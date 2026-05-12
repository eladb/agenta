import { existsSync } from 'node:fs';
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '../log';
import { dataRoot, ensureThreadDir, threadDir } from '../persistence/store';

// Idle state is encoded as "no file present" — that way the runtime cache
// stays self-cleaning and a missing file is unambiguous on crash. Files only
// exist while a thread is mid-turn ('running' or 'stopping').
export type RuntimeState = {
  status: 'running' | 'stopping';
  updated_at: string;
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
    if (parsed.status !== 'running' && parsed.status !== 'stopping') return undefined;
    return parsed;
  } catch (err) {
    log.warn('runtime', `readRuntime(${threadKey}) failed: ${(err as Error).message}`);
    return undefined;
  }
}

export async function clearRuntime(threadKey: string): Promise<void> {
  await rm(runtimePath(threadKey), { force: true }).catch(() => {});
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
