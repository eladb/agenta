import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetImageReadyCache, dockerProvider } from './docker';
import { _resetFlyState, flyProvider } from './fly';
import { _resetSyncedAttachments, syncAttachmentsToSandbox, writeBinary } from './index';

// We stub fetch globally and replace BOTH provider getEndpoint
// implementations with a fixed endpoint so postJson can dispatch to a
// stubbed fetch without ever shelling out to `docker` or hitting Fly.
// Either provider may be active depending on SANDBOX_PROVIDER at module
// load — patching both makes the test provider-agnostic. The test
// asserts on the HTTP traffic — which path got POSTed, with what base64
// body, and whether re-runs are no-ops.

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
    const headers = (init?.headers as Record<string, string> | undefined) ?? {};
    let body: unknown;
    if (init?.body !== undefined && init.body !== null) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = String(init.body);
      }
    }
    const call: RecordedCall = { url, method: init?.method ?? 'GET', headers, body };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { calls };
}

let dataDir: string;
const THREAD = 'tk-sync-test';
const FAKE_BASE_URL = 'http://127.0.0.1:55555';
const FAKE_TOKEN = 'fake-bearer-token';

// Replace each provider's getEndpoint with a fixed endpoint so we can hit
// a stubbed fetch instead of `docker port` + a real container or a Fly
// machine. Restored in afterEach.
type GetEndpointFn = typeof dockerProvider.getEndpoint;
const originalDockerGetEndpoint: GetEndpointFn = dockerProvider.getEndpoint;
const originalFlyGetEndpoint: GetEndpointFn = flyProvider.getEndpoint;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'agenta-sync-'));
  process.env.AGENTA_DATA_DIR = dataDir;
  _resetSyncedAttachments();
  _resetImageReadyCache();
  _resetFlyState();
  const fakeEndpoint = async (): Promise<{ baseUrl: string; headers: Record<string, string> }> => ({
    baseUrl: FAKE_BASE_URL,
    headers: { Authorization: `Bearer ${FAKE_TOKEN}` },
  });
  (dockerProvider as { getEndpoint: GetEndpointFn }).getEndpoint = fakeEndpoint;
  (flyProvider as { getEndpoint: GetEndpointFn }).getEndpoint = fakeEndpoint;
});

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
  rmSync(dataDir, { recursive: true, force: true });
  _resetSyncedAttachments();
  _resetImageReadyCache();
  _resetFlyState();
  (dockerProvider as { getEndpoint: GetEndpointFn }).getEndpoint = originalDockerGetEndpoint;
  (flyProvider as { getEndpoint: GetEndpointFn }).getEndpoint = originalFlyGetEndpoint;
  delete process.env.AGENTA_DATA_DIR;
});

function writeLocalAttachment(name: string, bytes: Uint8Array | string): void {
  const dir = join(dataDir, THREAD, 'attachments');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), bytes);
}

describe('writeBinary', () => {
  test('POSTs base64 to /write_binary on the sandbox endpoint', async () => {
    const { calls } = withStubFetch((call) => {
      if (call.url === `${FAKE_BASE_URL}/write_binary`) {
        return Response.json({ exitCode: 0, stdout: '', stderr: '' });
      }
      return new Response('unexpected', { status: 500 });
    });

    const data = Buffer.from('hello binary world');
    const res = await writeBinary(THREAD, 'attachments/F1-foo.bin', data);
    expect(res.exitCode).toBe(0);

    const writeCall = calls.find((c) => c.url.endsWith('/write_binary'));
    if (!writeCall) throw new Error('expected /write_binary call');
    expect(writeCall.method).toBe('POST');
    expect(writeCall.headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    const body = writeCall.body as { path: string; content_b64: string };
    expect(body.path).toBe('attachments/F1-foo.bin');
    expect(Buffer.from(body.content_b64, 'base64').equals(data)).toBe(true);
  });
});

describe('syncAttachmentsToSandbox', () => {
  test('writes each pre-staged attachment once, then is a no-op', async () => {
    writeLocalAttachment('F1-foo.txt', 'hello there');

    const { calls } = withStubFetch((call) => {
      if (call.url.endsWith('/write_binary')) {
        return Response.json({ exitCode: 0, stdout: '', stderr: '' });
      }
      return new Response('unexpected', { status: 500 });
    });

    const first = await syncAttachmentsToSandbox(THREAD);
    expect(first.synced).toBe(1);

    const writes = calls.filter((c) => c.url.endsWith('/write_binary'));
    expect(writes).toHaveLength(1);
    const body = writes[0]?.body as { path: string; content_b64: string };
    expect(body.path).toBe('attachments/F1-foo.txt');
    expect(Buffer.from(body.content_b64, 'base64').toString('utf8')).toBe('hello there');

    // Second call should not re-issue the write — the per-thread set tracks
    // already-synced basenames.
    const second = await syncAttachmentsToSandbox(THREAD);
    expect(second.synced).toBe(0);
    const writesAfter = calls.filter((c) => c.url.endsWith('/write_binary'));
    expect(writesAfter).toHaveLength(1);
  });

  test('returns synced: 0 when no attachments dir exists', async () => {
    const { calls } = withStubFetch(() => Response.json({ exitCode: 0, stdout: '', stderr: '' }));
    const res = await syncAttachmentsToSandbox(THREAD);
    expect(res.synced).toBe(0);
    expect(calls.filter((c) => c.url.endsWith('/write_binary'))).toHaveLength(0);
  });

  test('a new file dropped between syncs is picked up on the next call', async () => {
    writeLocalAttachment('F1-a.txt', 'first');

    withStubFetch((call) => {
      if (call.url.endsWith('/write_binary')) {
        return Response.json({ exitCode: 0, stdout: '', stderr: '' });
      }
      return new Response('unexpected', { status: 500 });
    });

    expect((await syncAttachmentsToSandbox(THREAD)).synced).toBe(1);
    writeLocalAttachment('F2-b.bin', new Uint8Array([1, 2, 3, 4]));
    expect((await syncAttachmentsToSandbox(THREAD)).synced).toBe(1);
    // F1 stays cached so a third call is a no-op.
    expect((await syncAttachmentsToSandbox(THREAD)).synced).toBe(0);
  });
});
