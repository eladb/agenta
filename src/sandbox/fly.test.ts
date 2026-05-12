import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { _resetFlyState, flyProvider } from './fly';

const ORIG_FETCH = globalThis.fetch;

type RecordedCall = { url: string; method: string; headers: Record<string, string>; body?: unknown };

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

beforeEach(() => {
  process.env.FLY_API_TOKEN = 'test-token';
  process.env.FLY_APP_NAME = 'test-app';
});

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
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
    const body = create.body as { name: string; config: { image: string; env: Record<string, string> } };
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
});
