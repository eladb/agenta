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
  // Pin a region so we don't have to stub GET /apps/<app> in every test.
  // Real config can still rely on the app's primary_region; the tests just
  // bypass that lookup for simplicity.
  process.env.FLY_REGION = 'iad';
  dataDir = mkdtempSync(join(tmpdir(), 'agenta-fly-'));
  process.env.AGENTA_DATA_DIR = dataDir;
});

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.AGENTA_DATA_DIR;
  delete process.env.FLY_API_TOKEN;
  delete process.env.FLY_APP_NAME;
  delete process.env.FLY_REGION;
  _resetFlyState();
});

describe('flyProvider', () => {
  test('ensure: creates a volume + machine, waits for /health, caches token+id', async () => {
    const { calls } = withStubFetch((call) => {
      if (call.url.endsWith('/v1/apps/test-app/machines') && call.method === 'GET') {
        // listing for stale-machine check — empty.
        return new Response('[]', { status: 200 });
      }
      if (call.url.endsWith('/v1/apps/test-app/volumes') && call.method === 'POST') {
        return new Response(
          JSON.stringify({ id: 'vol_xyz', name: 'agenta_vol_thread_k', region: 'iad' }),
          { status: 200 },
        );
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

    // Volume create happens BEFORE machine create — the machine config
    // references the volume id in its mounts.
    const volumeIdx = calls.findIndex(
      (c) => c.method === 'POST' && c.url.endsWith('/v1/apps/test-app/volumes'),
    );
    const machineIdx = calls.findIndex(
      (c) => c.method === 'POST' && c.url.endsWith('/v1/apps/test-app/machines'),
    );
    expect(volumeIdx).toBeGreaterThanOrEqual(0);
    expect(machineIdx).toBeGreaterThan(volumeIdx);

    const volumeCreate = calls[volumeIdx];
    if (!volumeCreate) throw new Error('expected volume create call');
    const volBody = volumeCreate.body as { name: string; region: string; size_gb: number };
    expect(volBody.name).toMatch(/^agenta_vol_/);
    expect(volBody.region).toBe('iad');
    expect(volBody.size_gb).toBe(1);

    const create = calls[machineIdx];
    if (!create) throw new Error('expected create call');
    expect(create.headers.Authorization).toBe('Bearer test-token');
    const body = create.body as {
      name: string;
      config: {
        image: string;
        env: Record<string, string>;
        mounts?: Array<{ volume: string; path: string }>;
        region?: string;
      };
    };
    expect(body.name).toMatch(/^agenta-/);
    expect(body.config.image).toBe('registry.fly.io/test-app:latest');
    expect(body.config.env.SANDBOX_TOKEN.length).toBeGreaterThan(16);
    expect(body.config.region).toBe('iad');
    expect(body.config.mounts).toEqual([{ volume: 'vol_xyz', path: '/home/sandbox' }]);

    // getEndpoint returns the cached token + the fly-force-instance-id header.
    const ep = await flyProvider.getEndpoint('thread-k');
    expect(ep.baseUrl).toBe('https://test-app.fly.dev');
    expect(ep.headers.Authorization).toBe(`Bearer ${body.config.env.SANDBOX_TOKEN}`);
    expect(ep.headers['fly-force-instance-id']).toBe('machine-xyz');

    // Health was probed at least once.
    expect(calls.some((c) => c.url === 'https://test-app.fly.dev/health')).toBe(true);
  });

  test('remove: deletes the machine AND its volume (machine first, then volume)', async () => {
    const order: string[] = [];
    withStubFetch((call) => {
      if (call.url.endsWith('/v1/apps/test-app/machines') && call.method === 'GET') {
        return new Response('[]', { status: 200 });
      }
      if (call.url.endsWith('/v1/apps/test-app/volumes') && call.method === 'POST') {
        return new Response(JSON.stringify({ id: 'vol_rm', name: 'v', region: 'iad' }), {
          status: 200,
        });
      }
      if (call.url.endsWith('/v1/apps/test-app/machines') && call.method === 'POST') {
        return new Response(JSON.stringify({ id: 'machine-rm' }), { status: 200 });
      }
      if (call.url === 'https://test-app.fly.dev/health') {
        return new Response('ok', { status: 200 });
      }
      if (call.url.includes('/machines/machine-rm') && call.method === 'DELETE') {
        order.push('machine');
        return new Response('{}', { status: 200 });
      }
      if (call.url.includes('/volumes/vol_rm') && call.method === 'DELETE') {
        order.push('volume');
        return new Response('{}', { status: 200 });
      }
      return new Response('unexpected', { status: 500 });
    });

    await flyProvider.ensure('rm-thread');
    await flyProvider.remove('rm-thread');
    // Machine destroyed before volume (volume rm refuses while still
    // mounted by a live machine — same shape on docker and fly).
    expect(order).toEqual(['machine', 'volume']);
    // After remove, getEndpoint throws (no cached entry).
    await expect(flyProvider.getEndpoint('rm-thread')).rejects.toThrow(/not initialized/);
  });

  test('killAll: destroys every agenta- machine AND every agenta_vol_ volume', async () => {
    const deletedMachines: string[] = [];
    const deletedVolumes: string[] = [];
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
      if (call.url.endsWith('/v1/apps/test-app/volumes') && call.method === 'GET') {
        return new Response(
          JSON.stringify([
            { id: 'vol_1', name: 'agenta_vol_a', region: 'iad' },
            { id: 'vol_2', name: 'agenta_vol_b', region: 'iad' },
            { id: 'vol_3', name: 'unrelated', region: 'iad' },
          ]),
          { status: 200 },
        );
      }
      if (call.method === 'DELETE' && call.url.includes('/machines/')) {
        const id = call.url.split('/machines/')[1]?.split('?')[0];
        if (id) deletedMachines.push(id);
        return new Response('{}', { status: 200 });
      }
      if (call.method === 'DELETE' && call.url.includes('/volumes/')) {
        const id = call.url.split('/volumes/')[1]?.split('?')[0];
        if (id) deletedVolumes.push(id);
        return new Response('{}', { status: 200 });
      }
      return new Response('unexpected', { status: 500 });
    });

    await flyProvider.killAll();
    expect(deletedMachines.sort()).toEqual(['m1', 'm2']);
    expect(deletedVolumes.sort()).toEqual(['vol_1', 'vol_2']);
  });

  test('ensure throws when env vars missing', async () => {
    delete process.env.FLY_API_TOKEN;
    await expect(flyProvider.ensure('k')).rejects.toThrow(/FLY_API_TOKEN/);
  });

  test('ensure: writes session.json record with provider/machine_id/token/volume_id', async () => {
    withStubFetch((call) => {
      if (call.url.endsWith('/v1/apps/test-app/machines') && call.method === 'GET') {
        return new Response('[]', { status: 200 });
      }
      if (call.url.endsWith('/v1/apps/test-app/volumes') && call.method === 'POST') {
        return new Response(JSON.stringify({ id: 'vol_persisted', name: 'v', region: 'iad' }), {
          status: 200,
        });
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
    expect(session.sandbox.volume_id).toBe('vol_persisted');
  });

  test('ensure: re-hydrates from disk when in-memory state is empty and the machine is alive', async () => {
    const TK = 'tk-rehydrate';
    // Pre-stage a session.json with a "live" machine record.
    await writeSession(TK, {
      status: 'idle',
      updated_at: 't',
      sandbox: {
        provider: 'fly',
        machine_id: 'pre-existing',
        token: 'pre-token',
        volume_id: 'vol_pre',
      },
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

  test('ensure: dead machine + live volume reattaches a new machine to the same volume', async () => {
    const TK = 'tk-revive';
    await writeSession(TK, {
      status: 'idle',
      updated_at: 't',
      system_prompt: 'preserve',
      sandbox: {
        provider: 'fly',
        machine_id: 'old-dead-machine',
        token: 'preserved-token',
        volume_id: 'vol_live',
      },
    });

    const createCalls: Array<Record<string, unknown>> = [];
    withStubFetch((call) => {
      // Liveness: dead.
      if (
        call.url.endsWith('/v1/apps/test-app/machines/old-dead-machine') &&
        call.method === 'GET'
      ) {
        return new Response(JSON.stringify({ id: 'old-dead-machine', state: 'stopped' }), {
          status: 200,
        });
      }
      // Volume lookup: alive.
      if (call.url.endsWith('/v1/apps/test-app/volumes/vol_live') && call.method === 'GET') {
        return new Response(
          JSON.stringify({ id: 'vol_live', name: 'agenta_vol_revive', region: 'iad' }),
          { status: 200 },
        );
      }
      // Stale machine cleanup (best-effort) — accept any DELETE.
      if (call.method === 'DELETE' && call.url.includes('/machines/')) {
        return new Response('{}', { status: 200 });
      }
      if (call.url.endsWith('/v1/apps/test-app/machines') && call.method === 'GET') {
        return new Response('[]', { status: 200 });
      }
      if (call.url.endsWith('/v1/apps/test-app/machines') && call.method === 'POST') {
        createCalls.push(call.body as Record<string, unknown>);
        return new Response(JSON.stringify({ id: 'new-machine' }), { status: 200 });
      }
      if (call.url === 'https://test-app.fly.dev/health') {
        return new Response('ok', { status: 200 });
      }
      // Volume create should NOT be called on the reattach path.
      if (call.url.endsWith('/v1/apps/test-app/volumes') && call.method === 'POST') {
        throw new Error('reattach should not create a new volume');
      }
      return new Response('unexpected', { status: 500 });
    });

    await flyProvider.ensure(TK);

    // Exactly one machine create, attached to the existing volume id.
    expect(createCalls).toHaveLength(1);
    const created = createCalls[0] as {
      name: string;
      config: { mounts?: Array<{ volume: string; path: string }>; region?: string };
    };
    expect(created.config.mounts?.[0]?.volume).toBe('vol_live');
    expect(created.config.mounts?.[0]?.path).toBe('/home/sandbox');
    expect(created.config.region).toBe('iad');

    const session = await readSession(TK);
    if (session?.sandbox?.provider !== 'fly') throw new Error('unreachable');
    expect(session.sandbox.machine_id).toBe('new-machine');
    expect(session.sandbox.volume_id).toBe('vol_live');
    // Token preserved so anyone holding the bearer header keeps working.
    expect(session.sandbox.token).toBe('preserved-token');
    // System prompt + other fields untouched.
    expect(session.system_prompt).toBe('preserve');
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
      if (call.url.endsWith('/v1/apps/test-app/volumes') && call.method === 'POST') {
        return new Response(JSON.stringify({ id: 'vol_fresh', name: 'v', region: 'iad' }), {
          status: 200,
        });
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
      if (call.url.endsWith('/v1/apps/test-app/volumes') && call.method === 'POST') {
        return new Response(JSON.stringify({ id: 'vol_new', name: 'v', region: 'iad' }), {
          status: 200,
        });
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
      if (call.url.endsWith('/v1/apps/test-app/volumes') && call.method === 'POST') {
        return new Response(JSON.stringify({ id: 'vol_rm2', name: 'v', region: 'iad' }), {
          status: 200,
        });
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
      if (call.url.includes('/volumes/vol_rm2') && call.method === 'DELETE') {
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
