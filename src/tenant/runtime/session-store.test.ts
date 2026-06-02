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
  setGit,
  setHome,
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

  test('clearSession on a thread without prior state writes a bare idle record', async () => {
    await clearSession('never-existed');
    const after = await readSession('never-existed');
    expect(after?.status).toBe('idle');
  });

  test('listSessions includes idle entries (recovery filters separately)', async () => {
    await writeSession('a', { status: 'running', updated_at: 't' });
    await writeSession('b', { status: 'stopping', updated_at: 't' });
    await writeSession('c', { status: 'idle', updated_at: 't' });
    // Thread with no session.json shouldn't appear.
    writeFileSync(join(dataDir, 'd'), '');
    const out = await listSessions();
    const keys = out.map((e) => e.threadKey).sort();
    expect(keys).toEqual(['a', 'b', 'c']);
    const c = out.find((e) => e.threadKey === 'c');
    expect(c?.state.status).toBe('idle');
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
    await writeSession(tk, { status: 'idle', updated_at: 't' });
    const out = await readSession(tk);
    expect(out).toEqual({ status: 'idle', updated_at: 't' });
  });

  test('the session.json file is at the expected path', async () => {
    await writeSession('tk', { status: 'running', updated_at: 't' });
    expect(existsSync(join(dataDir, 'tk', 'session.json'))).toBe(true);
  });

  test('setSandbox preserves status on writes', async () => {
    await writeSession('tk-sb', { status: 'running', updated_at: 't0' });
    const rec: SandboxRecord = { provider: 'docker', container_name: 'agenta-tk-sb', token: 'tok' };
    await setSandbox('tk-sb', rec);
    const after = await readSession('tk-sb');
    expect(after?.status).toBe('running');
    expect(after?.sandbox).toEqual(rec);
  });

  test('setSandbox(undefined) removes the sandbox field but keeps the rest', async () => {
    const rec: SandboxRecord = { provider: 'fly', machine_id: 'm-1', token: 'tok' };
    await writeSession('tk-clear', {
      status: 'idle',
      updated_at: 't',
      sandbox: rec,
    });
    await setSandbox('tk-clear', undefined);
    const after = await readSession('tk-clear');
    expect(after?.status).toBe('idle');
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

  // Regression (#254 review #6): concurrent setters must not clobber each
  // other. Pre-fix, setSandbox and setGit each read the same prior state and
  // the last writer wins — dropping the other's field. That left threads with
  // a running sandbox task but no `sandbox` in session.json, so every later
  // turn reported "sandbox not initialized". With the per-thread lock both
  // fields must survive.
  test('concurrent setSandbox + setGit both persist (no clobber)', async () => {
    await writeSession('tk-race', { status: 'running', updated_at: 't0' });
    const sb: SandboxRecord = {
      provider: 'ecs',
      task_arn: 'arn:task/abc',
      workspace_path: '/efs/x',
      sandbox_token: 'tok',
    };
    const git = { ref: 'refs/heads/agenta/sessions/tk-race' };
    await Promise.all([setSandbox('tk-race', sb), setGit('tk-race', git)]);
    const after = await readSession('tk-race');
    expect(after?.status).toBe('running');
    expect(after?.sandbox).toEqual(sb);
    expect(after?.git).toEqual(git);
  });

  // The lock must also serialize many interleaved updates without losing any.
  test('updateSession serializes concurrent field writes', async () => {
    await writeSession('tk-many', { status: 'running', updated_at: 't0' });
    await Promise.all([
      setSandbox('tk-many', { provider: 'docker', container_name: 'c', token: 't' }),
      setGit('tk-many', { ref: 'refs/heads/x' }),
      setHome('tk-many', { remote: 'https://example.com/r.git', auth_env: 'GITHUB_TOKEN' }),
    ]);
    const after = await readSession('tk-many');
    expect(after?.sandbox).toBeDefined();
    expect(after?.git).toBeDefined();
    expect(after?.home).toBeDefined();
  });

  test('clearSession preserves the sandbox record across the running -> idle transition', async () => {
    const rec: SandboxRecord = { provider: 'docker', container_name: 'agenta-keep', token: 't' };
    await writeSession('tk-keep', {
      status: 'running',
      updated_at: 't',
      sandbox: rec,
    });
    await clearSession('tk-keep');
    const after = await readSession('tk-keep');
    expect(after?.status).toBe('idle');
    expect(after?.sandbox).toEqual(rec);
  });

  test('readSession round-trips a sandbox record on an idle state', async () => {
    const rec: SandboxRecord = { provider: 'fly', machine_id: 'm-42', token: 'tok42' };
    await writeSession('tk-rt', { status: 'idle', updated_at: 't', sandbox: rec });
    const out = await readSession('tk-rt');
    expect(out?.sandbox).toEqual(rec);
  });

  test('setHome on a thread with no session.json writes a minimal idle record', async () => {
    await setHome('tk-home-fresh', {
      remote: 'https://github.com/o/r',
      auth_env: 'GITHUB_TOKEN',
    });
    const after = await readSession('tk-home-fresh');
    expect(after?.status).toBe('idle');
    expect(after?.home).toEqual({
      remote: 'https://github.com/o/r',
      auth_env: 'GITHUB_TOKEN',
    });
  });

  test('setHome preserves other fields', async () => {
    await writeSession('tk-home-merge', {
      status: 'running',
      updated_at: 't',
    });
    await setHome('tk-home-merge', { remote: 'file:///x' });
    const after = await readSession('tk-home-merge');
    expect(after?.status).toBe('running');
    expect(after?.home).toEqual({ remote: 'file:///x' });
  });

  test('setHome(undefined) removes the home field but keeps the rest', async () => {
    await writeSession('tk-home-clear', {
      status: 'idle',
      updated_at: 't',
      home: { remote: 'file:///x' },
    });
    await setHome('tk-home-clear', undefined);
    const after = await readSession('tk-home-clear');
    expect(after?.home).toBeUndefined();
  });

  test('clearSession preserves the home record across the running -> idle transition', async () => {
    await writeSession('tk-home-keep', {
      status: 'running',
      updated_at: 't',
      home: { remote: 'file:///x' },
    });
    await clearSession('tk-home-keep');
    const after = await readSession('tk-home-keep');
    expect(after?.status).toBe('idle');
    expect(after?.home).toEqual({ remote: 'file:///x' });
  });
});
