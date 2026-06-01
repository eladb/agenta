import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '../../shared/log';
import { dataRoot } from '../persistence/store';

// Persisted dedupe store (#44). In-memory createDedupe lost its state on
// every restart, so Slack-redelivered events (after ack timeout / socket
// reconnect) re-fired turns and re-appended to JSONL. This module persists
// the seen-key set to <AGENTA_DATA_DIR>/dedupe.json with atomic temp+rename
// writes, the same pattern as session-store.ts. TTL prunes old entries on
// every check so the file stays bounded (Slack redelivers within ~10 min;
// we keep 30 min of headroom).
//
// Single-bot-process invariant: only one agent runs per data dir (the
// 'agent' lockfile in src/lockfile.ts enforces it), so no locking needed —
// reads and writes happen in-process and the on-disk file is the
// authoritative mirror of the in-memory cache.

const TTL_MS = 30 * 60 * 1000; // 30 minutes
const FILENAME = 'dedupe.json';

type DedupeFile = {
  entries: Record<string, number>; // key -> unix ms
};

// Cache keyed by data dir path so each AGENTA_DATA_DIR cycle (tests use
// mkdtemp + reset env between runs) starts with a fresh in-memory mirror.
// `_loaded` guards the lazy first-read.
const caches = new Map<string, { entries: Map<string, number>; loaded: boolean }>();

function filePath(): string {
  return join(dataRoot(), FILENAME);
}

function getCache(): { entries: Map<string, number>; loaded: boolean } {
  const path = filePath();
  let c = caches.get(path);
  if (!c) {
    c = { entries: new Map(), loaded: false };
    caches.set(path, c);
  }
  return c;
}

async function loadIfNeeded(cache: {
  entries: Map<string, number>;
  loaded: boolean;
}): Promise<void> {
  if (cache.loaded) return;
  cache.loaded = true;
  const path = filePath();
  if (!existsSync(path)) return;
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as DedupeFile;
    if (parsed?.entries && typeof parsed.entries === 'object') {
      for (const [k, v] of Object.entries(parsed.entries)) {
        if (typeof v === 'number') cache.entries.set(k, v);
      }
    }
  } catch (err) {
    // Treat any read/parse error as "no prior state". Worst case is a
    // narrow window of duplicate processing after a restart with corrupt
    // file — far less bad than refusing to boot.
    log.warn('dedupe', `failed to load ${path}: ${(err as Error).message}`);
  }
}

function prune(cache: { entries: Map<string, number> }): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [k, ts] of cache.entries) {
    if (ts < cutoff) cache.entries.delete(k);
  }
}

async function save(cache: { entries: Map<string, number> }): Promise<void> {
  const root = dataRoot();
  if (!existsSync(root)) {
    try {
      await mkdir(root, { recursive: true });
    } catch {
      // tolerated; writeFile will surface a useful error if it really fails
    }
  }
  const final = filePath();
  const tmp = `${final}.tmp.${process.pid}.${Date.now()}`;
  const obj: DedupeFile = { entries: Object.fromEntries(cache.entries) };
  try {
    await writeFile(tmp, JSON.stringify(obj), 'utf8');
    await rename(tmp, final);
  } catch (err) {
    log.warn('dedupe', `save failed: ${(err as Error).message}`);
    await rm(tmp, { force: true }).catch(() => {});
  }
}

// Returns true if `key` has already been seen within the TTL window;
// otherwise records it (with current ts), persists, and returns false.
export async function isDuplicate(key: string): Promise<boolean> {
  const cache = getCache();
  await loadIfNeeded(cache);
  prune(cache);
  if (cache.entries.has(key)) return true;
  cache.entries.set(key, Date.now());
  await save(cache);
  return false;
}

// Test seam: drops the in-memory cache for the current data dir. Tests
// rotate AGENTA_DATA_DIR in beforeEach which already creates a fresh
// cache slot, but call this from afterEach for belt-and-suspenders.
export function _resetDedupeForTests(): void {
  caches.clear();
}
