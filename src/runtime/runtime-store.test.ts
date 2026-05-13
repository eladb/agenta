import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearRuntime,
  listRuntimes,
  type RuntimeState,
  readRuntime,
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

  test('clearRuntime rewrites state as idle (no longer deletes the file)', async () => {
    await writeRuntime('tk2', { status: 'running', updated_at: 't' });
    await clearRuntime('tk2');
    const after = await readRuntime('tk2');
    expect(after?.status).toBe('idle');
  });

  test('clearRuntime preserves system_prompt across the running -> idle transition', async () => {
    const prompt = 'frozen system prompt for this thread';
    await writeRuntime('tk-prompt', {
      status: 'running',
      updated_at: 't',
      system_prompt: prompt,
    });
    await clearRuntime('tk-prompt');
    const after = await readRuntime('tk-prompt');
    expect(after?.status).toBe('idle');
    expect(after?.system_prompt).toBe(prompt);
  });

  test('clearRuntime on a thread without prior state writes idle with no system_prompt', async () => {
    await clearRuntime('never-existed');
    const after = await readRuntime('never-existed');
    expect(after?.status).toBe('idle');
    expect(after?.system_prompt).toBeUndefined();
  });

  test('listRuntimes includes idle entries (recovery filters separately)', async () => {
    await writeRuntime('a', { status: 'running', updated_at: 't' });
    await writeRuntime('b', { status: 'stopping', updated_at: 't' });
    await writeRuntime('c', { status: 'idle', updated_at: 't', system_prompt: 'p' });
    // Thread with no runtime.json shouldn't appear.
    writeFileSync(join(dataDir, 'd'), '');
    const out = await listRuntimes();
    const keys = out.map((e) => e.threadKey).sort();
    expect(keys).toEqual(['a', 'b', 'c']);
    const c = out.find((e) => e.threadKey === 'c');
    expect(c?.state.status).toBe('idle');
    expect(c?.state.system_prompt).toBe('p');
  });

  test('listRuntimes returns [] when data dir is missing', async () => {
    rmSync(dataDir, { recursive: true, force: true });
    expect(await listRuntimes()).toEqual([]);
  });

  test('readRuntime returns undefined for corrupted JSON', async () => {
    const tk = 'corrupt';
    await writeRuntime(tk, { status: 'running', updated_at: 't' });
    writeFileSync(join(dataDir, tk, 'runtime.json'), 'not json at all');
    expect(await readRuntime(tk)).toBeUndefined();
  });

  test('readRuntime returns undefined for unknown status values', async () => {
    const tk = 'bad-status';
    await writeRuntime(tk, { status: 'running', updated_at: 't' });
    writeFileSync(
      join(dataDir, tk, 'runtime.json'),
      JSON.stringify({ status: 'banana', updated_at: 't' }),
    );
    expect(await readRuntime(tk)).toBeUndefined();
  });

  test('readRuntime returns the idle state correctly', async () => {
    const tk = 'idle-thread';
    await writeRuntime(tk, { status: 'idle', updated_at: 't', system_prompt: 'sp' });
    const out = await readRuntime(tk);
    expect(out).toEqual({ status: 'idle', updated_at: 't', system_prompt: 'sp' });
  });

  test('the runtime.json file is at the expected path', async () => {
    await writeRuntime('tk', { status: 'running', updated_at: 't' });
    expect(existsSync(join(dataDir, 'tk', 'runtime.json'))).toBe(true);
  });
});
