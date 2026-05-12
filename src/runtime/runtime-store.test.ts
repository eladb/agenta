import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearRuntime,
  listRuntimes,
  readRuntime,
  type RuntimeState,
  writeRuntime,
} from './runtime-store';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'agenta-runtime-'));
  process.env.AGENTA_DATA_DIR = dataDir;
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.AGENTA_DATA_DIR;
});

describe('runtime-store', () => {
  test('write then read roundtrips a state', async () => {
    const state: RuntimeState = { status: 'running', updated_at: '2026-05-12T10:00:00Z' };
    await writeRuntime('tk1', state);
    expect(await readRuntime('tk1')).toEqual(state);
  });

  test('read returns undefined when no file', async () => {
    expect(await readRuntime('missing')).toBeUndefined();
  });

  test('clearRuntime removes the file', async () => {
    await writeRuntime('tk2', { status: 'running', updated_at: 't' });
    await clearRuntime('tk2');
    expect(await readRuntime('tk2')).toBeUndefined();
  });

  test('clearRuntime on a missing file is a no-op', async () => {
    await clearRuntime('never-existed');
    expect(await readRuntime('never-existed')).toBeUndefined();
  });

  test('listRuntimes returns every thread that has a runtime.json', async () => {
    await writeRuntime('a', { status: 'running', updated_at: 't' });
    await writeRuntime('b', { status: 'stopping', updated_at: 't' });
    // Thread with no runtime.json shouldn't appear.
    writeFileSync(join(dataDir, 'c'), '');
    const out = await listRuntimes();
    const keys = out.map((e) => e.threadKey).sort();
    expect(keys).toEqual(['a', 'b']);
    const a = out.find((e) => e.threadKey === 'a');
    expect(a?.state.status).toBe('running');
  });

  test('listRuntimes returns [] when data dir is missing', async () => {
    rmSync(dataDir, { recursive: true, force: true });
    expect(await listRuntimes()).toEqual([]);
  });

  test('readRuntime returns undefined for corrupted JSON', async () => {
    // Manually write garbage to the runtime path.
    const tk = 'corrupt';
    await writeRuntime(tk, { status: 'running', updated_at: 't' });
    writeFileSync(join(dataDir, tk, 'runtime.json'), 'not json at all');
    expect(await readRuntime(tk)).toBeUndefined();
  });

  test('readRuntime returns undefined for invalid status values', async () => {
    const tk = 'bad-status';
    await writeRuntime(tk, { status: 'running', updated_at: 't' });
    writeFileSync(
      join(dataDir, tk, 'runtime.json'),
      JSON.stringify({ status: 'idle', updated_at: 't' }),
    );
    expect(await readRuntime(tk)).toBeUndefined();
  });

  test('the runtime.json file is at the expected path', async () => {
    await writeRuntime('tk', { status: 'running', updated_at: 't' });
    expect(existsSync(join(dataDir, 'tk', 'runtime.json'))).toBe(true);
  });
});
