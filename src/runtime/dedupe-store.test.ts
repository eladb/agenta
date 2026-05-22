import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetDedupeForTests, isDuplicate } from './dedupe-store';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'agenta-dedupe-'));
  process.env.AGENTA_DATA_DIR = dataDir;
  _resetDedupeForTests();
});

afterEach(() => {
  _resetDedupeForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.AGENTA_DATA_DIR;
});

describe('dedupe-store', () => {
  test('same key returns false then true', async () => {
    expect(await isDuplicate('id:Ev1')).toBe(false);
    expect(await isDuplicate('id:Ev1')).toBe(true);
  });

  test('different keys do not collide', async () => {
    expect(await isDuplicate('id:A')).toBe(false);
    expect(await isDuplicate('id:B')).toBe(false);
    expect(await isDuplicate('id:A')).toBe(true);
    expect(await isDuplicate('id:B')).toBe(true);
  });

  test('writes the persisted file with expected schema', async () => {
    await isDuplicate('id:X');
    const path = join(dataDir, 'dedupe.json');
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    expect(parsed.entries).toBeDefined();
    expect(typeof parsed.entries['id:X']).toBe('number');
  });

  test('persists across module-cache reset (simulates restart)', async () => {
    expect(await isDuplicate('id:Restart')).toBe(false);
    // Simulate a process restart by dropping the in-memory cache. The
    // file on disk is the source of truth.
    _resetDedupeForTests();
    expect(await isDuplicate('id:Restart')).toBe(true);
  });

  test('TTL pruning drops entries past the 30 min window', async () => {
    // Pre-seed the on-disk file with an entry timestamped 31 min ago.
    const path = join(dataDir, 'dedupe.json');
    const oldTs = Date.now() - 31 * 60 * 1000;
    await writeFile(path, JSON.stringify({ entries: { 'id:Old': oldTs, 'id:Fresh': Date.now() } }));
    _resetDedupeForTests();
    // Old entry is pruned → first call returns false (not a duplicate).
    expect(await isDuplicate('id:Old')).toBe(false);
    // Fresh entry is preserved → duplicate.
    expect(await isDuplicate('id:Fresh')).toBe(true);
  });

  test('different AGENTA_DATA_DIR cycles get isolated state', async () => {
    expect(await isDuplicate('id:Shared')).toBe(false);

    // Rotate to a new data dir (simulates a totally separate bot deployment).
    const dir2 = mkdtempSync(join(tmpdir(), 'agenta-dedupe-2-'));
    process.env.AGENTA_DATA_DIR = dir2;
    _resetDedupeForTests();
    try {
      expect(await isDuplicate('id:Shared')).toBe(false);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  test('tolerates corrupt dedupe.json', async () => {
    const path = join(dataDir, 'dedupe.json');
    await writeFile(path, '{not valid json');
    _resetDedupeForTests();
    expect(await isDuplicate('id:After')).toBe(false);
    expect(await isDuplicate('id:After')).toBe(true);
  });

  test('supports the id:<eventId> key shape used by edits/deletes', async () => {
    expect(await isDuplicate('id:EvEdit')).toBe(false);
    expect(await isDuplicate('id:EvEdit')).toBe(true);
  });
});
