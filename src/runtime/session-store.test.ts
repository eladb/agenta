import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearSession,
  listSessions,
  readSession,
  type SandboxRecord,
  type SessionState,
  setSandbox,
  writeSession,
} from './session-store';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'agenta-runtime-'));
  process.env.AGENTA_DATA_DIR = dataDir;
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.AGENTA_DATA_DIR;
});

describe('session-store', () => {
  test('write then read roundtrips a state', async () => {
    const state: SessionState = { status: 'running', updated_at: '2026-05-12T10:00:00Z' };
    await writeSession('tk1', state);
    expect(await readSession('tk1')).toEqual(state);
  });

  test('read returns undefined when no file', async () => {
    expect(await readSession('missing')).toBeUndefined();
  });

  test('clearSession rewrites state as idle (no longer deletes the file)', async () => {
    await writeSession('tk2', { status: 'running', updated_at: 't' });
    await clearSession('tk2');
    const after = await readSession('tk2');
    expect(after?.status).toBe('idle');
  });

  test('clearSession preserves system_prompt across the running -> idle transition', async () => {
    const prompt = 'frozen system prompt for this thread';
    await writeSession('tk-prompt', {
      status: 'running',
      updated_at: 't',
      system_prompt: prompt,
    });
    await clearSession('tk-prompt');
    const after = await readSession('tk-prompt');
    expect(after?.status).toBe('idle');
    expect(after?.system_prompt).toBe(prompt);
  });

  test('clearSession on a thread without prior state writes idle with no system_prompt', async () => {
    await clearSession('never-existed');
    const after = await readSession('never-existed');
    expect(after?.status).toBe('idle');
    expect(after?.system_prompt).toBeUndefined();
  });

  test('listSessions includes idle entries (recovery filters separately)', async () => {
    await writeSession('a', { status: 'running', updated_at: 't' });
    await writeSession('b', { status: 'stopping', updated_at: 't' });
    await writeSession('c', { status: 'idle', updated_at: 't', system_prompt: 'p' });
    // Thread with no session.json shouldn't appear.
    writeFileSync(join(dataDir, 'd'), '');
    const out = await listSessions();
    const keys = out.map((e) => e.threadKey).sort();
    expect(keys).toEqual(['a', 'b', 'c']);
    const c = out.find((e) => e.threadKey === 'c');
    expect(c?.state.status).toBe('idle');
    expect(c?.state.system_prompt).toBe('p');
  });

  test('listSessions returns [] when data dir is missing', async () => {
    rmSync(dataDir, { recursive: true, force: true });
    expect(await listSessions()).toEqual([]);
  });

  test('readSession returns undefined for corrupted JSON', async () => {
    const tk = 'corrupt';
    await writeSession(tk, { status: 'running', updated_at: 't' });
    writeFileSync(join(dataDir, tk, 'session.json'), 'not json at all');
    expect(await readSession(tk)).toBeUndefined();
  });

  test('readSession returns undefined for unknown status values', async () => {
    const tk = 'bad-status';
    await writeSession(tk, { status: 'running', updated_at: 't' });
    writeFileSync(
      join(dataDir, tk, 'session.json'),
      JSON.stringify({ status: 'banana', updated_at: 't' }),
    );
    expect(await readSession(tk)).toBeUndefined();
  });

  test('readSession returns the idle state correctly', async () => {
    const tk = 'idle-thread';
    await writeSession(tk, { status: 'idle', updated_at: 't', system_prompt: 'sp' });
    const out = await readSession(tk);
    expect(out).toEqual({ status: 'idle', updated_at: 't', system_prompt: 'sp' });
  });

  test('the session.json file is at the expected path', async () => {
    await writeSession('tk', { status: 'running', updated_at: 't' });
    expect(existsSync(join(dataDir, 'tk', 'session.json'))).toBe(true);
  });

  test('setSandbox preserves status and system_prompt on writes', async () => {
    await writeSession('tk-sb', {
      status: 'running',
      updated_at: 't0',
      system_prompt: 'hello prompt',
    });
    const rec: SandboxRecord = { provider: 'docker', container_name: 'agenta-tk-sb', token: 'tok' };
    await setSandbox('tk-sb', rec);
    const after = await readSession('tk-sb');
    expect(after?.status).toBe('running');
    expect(after?.system_prompt).toBe('hello prompt');
    expect(after?.sandbox).toEqual(rec);
  });

  test('setSandbox(undefined) removes the sandbox field but keeps the rest', async () => {
    const rec: SandboxRecord = { provider: 'fly', machine_id: 'm-1', token: 'tok' };
    await writeSession('tk-clear', {
      status: 'idle',
      updated_at: 't',
      system_prompt: 'p',
      sandbox: rec,
    });
    await setSandbox('tk-clear', undefined);
    const after = await readSession('tk-clear');
    expect(after?.status).toBe('idle');
    expect(after?.system_prompt).toBe('p');
    expect(after?.sandbox).toBeUndefined();
  });

  test('setSandbox on a thread with no session.json writes a minimal idle record', async () => {
    const rec: SandboxRecord = { provider: 'docker', container_name: 'agenta-x', token: 't' };
    await setSandbox('tk-fresh', rec);
    const after = await readSession('tk-fresh');
    expect(after?.status).toBe('idle');
    expect(after?.sandbox).toEqual(rec);
  });

  test('setSandbox(undefined) on a thread with no session.json is a no-op', async () => {
    await setSandbox('never-existed-2', undefined);
    expect(await readSession('never-existed-2')).toBeUndefined();
  });

  test('clearSession preserves the sandbox record across the running -> idle transition', async () => {
    const rec: SandboxRecord = { provider: 'docker', container_name: 'agenta-keep', token: 't' };
    await writeSession('tk-keep', {
      status: 'running',
      updated_at: 't',
      system_prompt: 'p',
      sandbox: rec,
    });
    await clearSession('tk-keep');
    const after = await readSession('tk-keep');
    expect(after?.status).toBe('idle');
    expect(after?.system_prompt).toBe('p');
    expect(after?.sandbox).toEqual(rec);
  });

  test('readSession round-trips a sandbox record on an idle state', async () => {
    const rec: SandboxRecord = { provider: 'fly', machine_id: 'm-42', token: 'tok42' };
    await writeSession('tk-rt', { status: 'idle', updated_at: 't', sandbox: rec });
    const out = await readSession('tk-rt');
    expect(out?.sandbox).toEqual(rec);
  });
});
