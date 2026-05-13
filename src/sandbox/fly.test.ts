import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSession, writeSession } from '../runtime/session-store';
import { _resetFlyState, flyProvider } from './fly';

const ORIG_FETCH = globalThis.fetch;

type RecordedCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
};

function withStubFetch(handler: (call: RecordedCall) => Response | Promise<Response>): {
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    const headers = init?.headers as Record<string, string> | undefined;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const call = { url, method: init?.method ?? 'GET', headers: headers ?? {}, body };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { calls };
}

let dataDir: string;

beforeEach(() => {
  process.env.FLY_API_TOKEN = 'test-token';
  process.env.FLY_APP_NAME = 'test-app';
  dataDir = mkdtempSync(join(tmpdir(), 'agenta-fly-'));
  process.env.AGENTA_DATA_DIR = dataDir;
});

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.AGENTA_DATA_DIR;
  delete process.env.FLY_API_TOKEN;
  delete process.env.FLY_APP_NAME;
  _resetFlyState();
});

describe('flyProvider', () => {
  test('ensure: creates a machine, waits for /health, caches token+id', async () => {
    const { calls } = withStubFetch((call) => {
      if (call.url.endsWith('/v1/apps/test-app/machines') && call.method === 'GET') {
        // listing for stale-machine check — empty.
        return new Response('[]', { status: 200 });
      }
      if (call.url.endsWith('/v1/apps/test-app/machines') && call.method === 'POST') {
        return new Response(JSON.stringify({ id: 'machine-xyz' }), { status: 200 });
      }
      if (call.url === 'https://test-app.fly.dev/health') {
        return new Response('ok', { status: 200 });
      }
      return new Response('unexpected', { status: 500 });
    });

    await flyProvider.ensure('thread-k');

    const create = calls.find(
      (c) => c.method === 'POST' && c.url.endsWith('/v1/apps/test-app/machines'),
    );
    if (!create) throw new Error('expected create call');
    expect(create.headers.Authorization).toBe('Bearer test-token');
    const body = create.body as {
      name: string;
      config: { image: string; env: Record<string, string> };
    };
    expect(body.name).toMatch(/^agenta-/);
    expect(body.config.image).toBe('registry.fly.io/test-app:latest');
    expect(body.config.env.SANDBOX_TOKEN.length).toBeGreaterThan(16);

    // getEndpoint returns the cached token + the fly-force-instance-id header.
    const ep = await flyProvider.getEndpoint('thread-k');
    expect(ep.baseUrl).toBe('https://test-app.fly.dev');
    expect(ep.headers.Authorization).toBe(`Bearer ${body.config.env.SANDBOX_TOKEN}`);
    expect(ep.headers['fly-force-instance-id']).toBe('machine-xyz');

    // Health was probed at least once.
    expect(calls.some((c) => c.url === 'https://test-app.fly.dev/health')).toBe(true);
  });

  test('remove: deletes the cached machine', async () => {
    let machineDestroyed = false;
    withStubFetch((call) => {
      if (call.url.endsWith('/v1/apps/test-app/machines') && call.method === 'GET') {
        return new Response('[]', { status: 200 });
      }
      if (call.url.endsWith('/v1/apps/test-app/machines') && call.method === 'POST') {
        return new Response(JSON.stringify({ id: 'machine-rm' }), { status: 200 });
      }
      if (call.url === 'https://test-app.fly.dev/health') {
        return new Response('ok', { status: 200 });
      }
      if (call.url.includes('/machines/machine-rm') && call.method === 'DELETE') {
        machineDestroyed = true;
        return new Response('{}', { status: 200 });
      }
      return new Response('unexpected', { status: 500 });
    });

    await flyProvider.ensure('rm-thread');
    await flyProvider.remove('rm-thread');
    expect(machineDestroyed).toBe(true);
    // After remove, getEndpoint throws (no cached entry).
    await expect(flyProvider.getEndpoint('rm-thread')).rejects.toThrow(/not initialized/);
  });

  test('killAll: destroys every machine whose name starts with agenta-', async () => {
    const deleted: string[] = [];
    withStubFetch((call) => {
      if (call.url.endsWith('/v1/apps/test-app/machines') && call.method === 'GET') {
        return new Response(
          JSON.stringify([
            { id: 'm1', name: 'agenta-a', state: 'started' },
            { id: 'm2', name: 'agenta-b', state: 'started' },
            { id: 'm3', name: 'something-else', state: 'started' },
          ]),
          { status: 200 },
        );
      }
      if (call.method === 'DELETE' && call.url.includes('/machines/')) {
        const id = call.url.split('/machines/')[1]?.split('?')[0];
        if (id) deleted.push(id);
        return new Response('{}', { status: 200 });
      }
      return new Response('unexpected', { status: 500 });
    });

    await flyProvider.killAll();
    expect(deleted.sort()).toEqual(['m1', 'm2']);
  });

  test('ensure throws when env vars missing', async () => {
    delete process.env.FLY_API_TOKEN;
    await expect(flyProvider.ensure('k')).rejects.toThrow(/FLY_API_TOKEN/);
  });

  test('ensure: writes session.json record with provider/machine_id/token', async () => {
    withStubFetch((call) => {
      if (call.url.endsWith('/v1/apps/test-app/machines') && call.method === 'GET') {
        return new Response('[]', { status: 200 });
      }
      if (call.url.endsWith('/v1/apps/test-app/machines') && call.method === 'POST') {
        return new Response(JSON.stringify({ id: 'machine-persisted' }), { status: 200 });
      }
      if (call.url === 'https://test-app.fly.dev/health') {
        return new Response('ok', { status: 200 });
      }
      return new Response('unexpected', { status: 500 });
    });

    const TK = 'tk-persist';
    await flyProvider.ensure(TK);
    const session = await readSession(TK);
    expect(session?.sandbox?.provider).toBe('fly');
    if (session?.sandbox?.provider !== 'fly') throw new Error('unreachable');
    expect(session.sandbox.machine_id).toBe('machine-persisted');
    expect(session.sandbox.token.length).toBeGreaterThan(16);
  });

  test('ensure: re-hydrates from disk when in-memory state is empty and the machine is alive', async () => {
    const TK = 'tk-rehydrate';
    // Pre-stage a session.json with a "live" machine record.
    await writeSession(TK, {
      status: 'idle',
      updated_at: 't',
      sandbox: { provider: 'fly', machine_id: 'pre-existing', token: 'pre-token' },
    });

    const created: string[] = [];
    withStubFetch((call) => {
      // verifyAlive: GET /apps/<app>/machines/<id>
      if (call.url.endsWith('/v1/apps/test-app/machines/pre-existing') && call.method === 'GET') {
        return new Response(JSON.stringify({ id: 'pre-existing', state: 'started' }), {
          status: 200,
        });
      }
      if (call.url.endsWith('/v1/apps/test-app/machines') && call.method === 'POST') {
        created.push(String(call.body));
        return new Response(JSON.stringify({ id: 'should-not-happen' }), { status: 200 });
      }
      return new Response('unexpected', { status: 500 });
    });

    await flyProvider.ensure(TK);
    expect(created).toHaveLength(0); // no new machine was created
    const ep = await flyProvider.getEndpoint(TK);
    expect(ep.headers['fly-force-instance-id']).toBe('pre-existing');
    expect(ep.headers.Authorization).toBe('Bearer pre-token');
  });

  test('ensure: persisted record with non-fly provider is cleared and ignored', async () => {
    const TK = 'tk-cross';
    await writeSession(TK, {
      status: 'idle',
      updated_at: 't',
      sandbox: { provider: 'docker', container_name: 'agenta-foo', token: 'd-tok' },
    });

    withStubFetch((call) => {
      if (call.url.endsWith('/v1/apps/test-app/machines') && call.method === 'GET') {
        return new Response('[]', { status: 200 });
      }
      if (call.url.endsWith('/v1/apps/test-app/machines') && call.method === 'POST') {
        return new Response(JSON.stringify({ id: 'fresh-machine' }), { status: 200 });
      }
      if (call.url === 'https://test-app.fly.dev/health') {
        return new Response('ok', { status: 200 });
      }
      return new Response('unexpected', { status: 500 });
    });

    await flyProvider.ensure(TK);
    const session = await readSession(TK);
    expect(session?.sandbox?.provider).toBe('fly');
    if (session?.sandbox?.provider !== 'fly') throw new Error('unreachable');
    expect(session.sandbox.machine_id).toBe('fresh-machine');
  });

  test('ensure: dead persisted record is cleared and a fresh machine is created', async () => {
    const TK = 'tk-dead';
    await writeSession(TK, {
      status: 'idle',
      updated_at: 't',
      system_prompt: 'preserve-me',
      sandbox: { provider: 'fly', machine_id: 'dead-machine', token: 'dead-tok' },
    });

    withStubFetch((call) => {
      if (call.url.endsWith('/v1/apps/test-app/machines/dead-machine') && call.method === 'GET') {
        // Liveness check returns stopped — treated as dead.
        return new Response(JSON.stringify({ id: 'dead-machine', state: 'stopped' }), {
          status: 200,
        });
      }
      if (call.url.endsWith('/v1/apps/test-app/machines') && call.method === 'GET') {
        return new Response('[]', { status: 200 });
      }
      if (call.url.endsWith('/v1/apps/test-app/machines') && call.method === 'POST') {
        return new Response(JSON.stringify({ id: 'new-machine' }), { status: 200 });
      }
      if (call.url === 'https://test-app.fly.dev/health') {
        return new Response('ok', { status: 200 });
      }
      return new Response('unexpected', { status: 500 });
    });

    await flyProvider.ensure(TK);
    const session = await readSession(TK);
    expect(session?.sandbox?.provider).toBe('fly');
    if (session?.sandbox?.provider !== 'fly') throw new Error('unreachable');
    expect(session.sandbox.machine_id).toBe('new-machine');
    // Regression: re-provision must preserve other session fields.
    expect(session.system_prompt).toBe('preserve-me');
  });

  test('remove: clears the sandbox field while preserving status + system_prompt', async () => {
    const TK = 'tk-remove';
    await writeSession(TK, {
      status: 'idle',
      updated_at: 't',
      system_prompt: 'keep-me',
      sandbox: { provider: 'fly', machine_id: 'm-rm', token: 't' },
    });
    // Seed in-memory state so remove() makes the DELETE call.
    withStubFetch((call) => {
      if (call.url.endsWith('/v1/apps/test-app/machines') && call.method === 'GET') {
        return new Response('[]', { status: 200 });
      }
      if (call.url.endsWith('/v1/apps/test-app/machines') && call.method === 'POST') {
        return new Response(JSON.stringify({ id: 'm-rm' }), { status: 200 });
      }
      if (call.url === 'https://test-app.fly.dev/health') {
        return new Response('ok', { status: 200 });
      }
      if (call.url.includes('/machines/m-rm') && call.method === 'DELETE') {
        return new Response('{}', { status: 200 });
      }
      return new Response('unexpected', { status: 500 });
    });
    // Pretend the bot already booted this machine — fastpath through ensure
    // by patching the alive check via a fresh ensure cycle.
    // (Simpler: call ensure once so in-memory state is set, then remove.)
    // First wipe the dead sandbox record so ensure creates a fresh one.
    const pre = (await readSession(TK)) ?? { status: 'idle' as const, updated_at: 't' };
    await writeSession(TK, { ...pre, sandbox: undefined });

    await flyProvider.ensure(TK);
    await flyProvider.remove(TK);
    const after = await readSession(TK);
    expect(after?.sandbox).toBeUndefined();
    expect(after?.status).toBe('idle');
    expect(after?.system_prompt).toBe('keep-me');
  });

  test('killAll: sweeps every session.json sandbox field across data/*', async () => {
    await writeSession('a', {
      status: 'idle',
      updated_at: 't',
      sandbox: { provider: 'fly', machine_id: 'mA', token: 't' },
    });
    await writeSession('b', {
      status: 'idle',
      updated_at: 't',
      system_prompt: 'keep',
      sandbox: { provider: 'fly', machine_id: 'mB', token: 't' },
    });

    withStubFetch((call) => {
      if (call.url.endsWith('/v1/apps/test-app/machines') && call.method === 'GET') {
        return new Response(JSON.stringify([{ id: 'mA', name: 'agenta-a', state: 'started' }]), {
          status: 200,
        });
      }
      if (call.method === 'DELETE' && call.url.includes('/machines/')) {
        return new Response('{}', { status: 200 });
      }
      return new Response('unexpected', { status: 500 });
    });

    await flyProvider.killAll();
    expect((await readSession('a'))?.sandbox).toBeUndefined();
    expect((await readSession('b'))?.sandbox).toBeUndefined();
    expect((await readSession('b'))?.system_prompt).toBe('keep');
  });

  test('listAll: returns ids of every fly machine with the agenta- prefix', async () => {
    withStubFetch(
      () =>
        new Response(
          JSON.stringify([
            { id: 'm1', name: 'agenta-a', state: 'started' },
            { id: 'm2', name: 'agenta-b', state: 'stopped' },
            { id: 'm3', name: 'something-else', state: 'started' },
          ]),
          { status: 200 },
        ),
    );
    const list = await flyProvider.listAll();
    expect(list.map((e) => e.id).sort()).toEqual(['m1', 'm2']);
  });

  test('destroyById: issues DELETE for the given machine id', async () => {
    let deleted: string | undefined;
    withStubFetch((call) => {
      if (call.method === 'DELETE' && call.url.includes('/machines/m-target')) {
        deleted = 'm-target';
        return new Response('{}', { status: 200 });
      }
      return new Response('unexpected', { status: 500 });
    });
    await flyProvider.destroyById('m-target');
    expect(deleted).toBe('m-target');
  });
});
