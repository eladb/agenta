import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSession, writeSession } from '../runtime/session-store';
import { _resetImageReadyCache, dockerProvider, ensureImage } from './docker';
import { _resetFlyState, flyProvider } from './fly';
import { consumeExecStream, containerName, writeBinary } from './index';

function dockerAvailable(): boolean {
  const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    stdio: 'ignore',
  });
  return r.status === 0;
}

const HAS_DOCKER = dockerAvailable();

describe('containerName', () => {
  test('prefixes threadKey with agenta-', () => {
    expect(containerName('c0b307lp274__1778528349_050239')).toBe(
      'agenta-c0b307lp274__1778528349_050239',
    );
  });

  test('different threadKeys produce different names', () => {
    expect(containerName('a')).not.toBe(containerName('b'));
  });
});

// Build a ReadableStream<Uint8Array> from a list of string chunks (each chunk
// arrives as a separate `enqueue`, so the parser is exercised at chunk
// boundaries that may split events).
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

describe('consumeExecStream', () => {
  test('parses stdout/stderr/exit events into a DockerResult', async () => {
    const r = await consumeExecStream(
      streamOf([
        'data: {"kind":"stdout","chunk":"hello "}\n\n',
        'data: {"kind":"stdout","chunk":"world"}\n\n',
        'data: {"kind":"stderr","chunk":"warn"}\n\n',
        'data: {"kind":"exit","exitCode":0}\n\n',
      ]),
    );
    expect(r).toEqual({ stdout: 'hello world', stderr: 'warn', exitCode: 0 });
  });

  test('joins frames split across chunks', async () => {
    const r = await consumeExecStream(
      streamOf([
        'data: {"kind":"stdout","chu',
        'nk":"hello"}\n',
        '\ndata: {"kind":"exit","exitCode":7}\n\n',
      ]),
    );
    expect(r).toEqual({ stdout: 'hello', stderr: '', exitCode: 7 });
  });

  test('returns exit -1 when stream ends without an exit event', async () => {
    const r = await consumeExecStream(streamOf(['data: {"kind":"stdout","chunk":"x"}\n\n']));
    expect(r.exitCode).toBe(-1);
    expect(r.stdout).toBe('x');
  });

  test('fires onChunk per stdout/stderr event', async () => {
    const seen: Array<[string, string]> = [];
    await consumeExecStream(
      streamOf([
        'data: {"kind":"stdout","chunk":"a"}\n\n',
        'data: {"kind":"stderr","chunk":"b"}\n\n',
        'data: {"kind":"stdout","chunk":"c"}\n\n',
        'data: {"kind":"exit","exitCode":0}\n\n',
      ]),
      (kind, chunk) => seen.push([kind, chunk]),
    );
    expect(seen).toEqual([
      ['stdout', 'a'],
      ['stderr', 'b'],
      ['stdout', 'c'],
    ]);
  });

  test('ignores non-data lines and malformed JSON', async () => {
    const r = await consumeExecStream(
      streamOf([
        ': comment\n\n',
        'data: not-json\n\n',
        'data: {"kind":"stdout","chunk":"ok"}\n\n',
        'data: {"kind":"exit","exitCode":0}\n\n',
      ]),
    );
    expect(r).toEqual({ stdout: 'ok', stderr: '', exitCode: 0 });
  });
});

describe('writeBinary HTTP shape', () => {
  const origFetch = globalThis.fetch;
  type GetEndpointFn = typeof dockerProvider.getEndpoint;
  const origDockerGetEndpoint: GetEndpointFn = dockerProvider.getEndpoint;
  const origFlyGetEndpoint: GetEndpointFn = flyProvider.getEndpoint;

  beforeEach(() => {
    _resetImageReadyCache();
    _resetFlyState();
    // Patch both providers so the test is provider-agnostic — whichever one
    // src/sandbox/index.ts picked up at module-load time will route here.
    const fake = async (): Promise<{ baseUrl: string; headers: Record<string, string> }> => ({
      baseUrl: 'http://127.0.0.1:1',
      headers: { Authorization: 'Bearer t' },
    });
    (dockerProvider as { getEndpoint: GetEndpointFn }).getEndpoint = fake;
    (flyProvider as { getEndpoint: GetEndpointFn }).getEndpoint = fake;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    (dockerProvider as { getEndpoint: GetEndpointFn }).getEndpoint = origDockerGetEndpoint;
    (flyProvider as { getEndpoint: GetEndpointFn }).getEndpoint = origFlyGetEndpoint;
    _resetImageReadyCache();
    _resetFlyState();
  });

  test('POSTs { path, content_b64 } to /write_binary with the auth header', async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      captured = { url: String(input), init };
      return Response.json({ exitCode: 0, stdout: '', stderr: '' });
    }) as unknown as typeof fetch;

    const res = await writeBinary('tk', 'attachments/F1-foo.bin', Buffer.from('abc'));
    expect(res.exitCode).toBe(0);
    expect(captured?.url).toBe('http://127.0.0.1:1/write_binary');
    expect(captured?.init?.method).toBe('POST');
    const headers = captured?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer t');
    const body = JSON.parse(String(captured?.init?.body)) as { path: string; content_b64: string };
    expect(body.path).toBe('attachments/F1-foo.bin');
    expect(Buffer.from(body.content_b64, 'base64').toString('utf8')).toBe('abc');
  });
});

// Docker-gated: exercises ensure/getEndpoint/remove/killAll/listAll against
// a real Docker daemon. Each test is fully self-contained and cleans up its
// container in `afterEach`. Skipped on hosts without Docker.
describe('dockerProvider persistence (live Docker)', () => {
  let dataDir: string;
  const created: string[] = [];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'agenta-docker-persist-'));
    process.env.AGENTA_DATA_DIR = dataDir;
    process.env.SANDBOX_EXEC_TIMEOUT_MS ??= '8000';
    _resetImageReadyCache();
  });

  afterEach(async () => {
    // Best-effort: remove any containers we spawned.
    for (const id of created) {
      spawnSync('docker', ['rm', '-fv', id], { stdio: 'ignore' });
    }
    created.length = 0;
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.AGENTA_DATA_DIR;
    _resetImageReadyCache();
  });

  test.if(HAS_DOCKER)(
    'ensure writes a docker session record after readiness',
    async () => {
      await ensureImage();
      const TK = `unit-persist-${Date.now()}`;
      created.push(containerName(TK));

      await dockerProvider.ensure(TK);
      const session = await readSession(TK);
      expect(session?.sandbox?.provider).toBe('docker');
      if (session?.sandbox?.provider !== 'docker') throw new Error('unreachable');
      expect(session.sandbox.container_name).toBe(containerName(TK));
      expect(session.sandbox.token.length).toBeGreaterThan(16);
    },
    180_000,
  );

  test.if(HAS_DOCKER)(
    'ensure re-hydrates an existing live container (second ensure does not recreate it)',
    async () => {
      await ensureImage();
      const TK = `unit-rehydrate-${Date.now()}`;
      created.push(containerName(TK));

      await dockerProvider.ensure(TK);
      const first = await readSession(TK);
      const tokenA = first?.sandbox?.provider === 'docker' ? first.sandbox.token : undefined;

      // Capture the docker container ID so we can verify it's the same one.
      const inspectA = spawnSync('docker', ['inspect', '-f', '{{.Id}}', containerName(TK)]);
      const idA = inspectA.stdout.toString().trim();

      // Simulate a bot restart: wipe in-memory state. Disk still has the
      // record. The container is still running.
      _resetImageReadyCache();

      // Second ensure should adopt the existing container — no new container.
      await dockerProvider.ensure(TK);
      const after = await readSession(TK);
      const tokenB = after?.sandbox?.provider === 'docker' ? after.sandbox.token : undefined;
      expect(tokenB).toBe(tokenA);

      const inspectB = spawnSync('docker', ['inspect', '-f', '{{.Id}}', containerName(TK)]);
      expect(inspectB.stdout.toString().trim()).toBe(idA);
    },
    180_000,
  );

  test.if(HAS_DOCKER)(
    'remove clears the disk record while preserving status + system_prompt',
    async () => {
      await ensureImage();
      const TK = `unit-remove-${Date.now()}`;
      created.push(containerName(TK));

      // Pre-write a status + system_prompt so we can verify they survive.
      await writeSession(TK, {
        status: 'idle',
        updated_at: 't',
        system_prompt: 'keep-me',
      });

      await dockerProvider.ensure(TK);
      // Sanity: sandbox was added to the existing session record.
      expect((await readSession(TK))?.system_prompt).toBe('keep-me');

      await dockerProvider.remove(TK);
      const after = await readSession(TK);
      expect(after?.sandbox).toBeUndefined();
      expect(after?.status).toBe('idle');
      expect(after?.system_prompt).toBe('keep-me');
    },
    180_000,
  );

  test.if(HAS_DOCKER)(
    'listAll returns the container name of an ensured sandbox',
    async () => {
      await ensureImage();
      const TK = `unit-listall-${Date.now()}`;
      created.push(containerName(TK));

      await dockerProvider.ensure(TK);
      const list = await dockerProvider.listAll();
      expect(list.map((e) => e.id)).toContain(containerName(TK));

      await dockerProvider.remove(TK);
      const listAfter = await dockerProvider.listAll();
      expect(listAfter.map((e) => e.id)).not.toContain(containerName(TK));
    },
    180_000,
  );

  test.if(HAS_DOCKER)(
    'killAll sweeps the sandbox field across every session.json',
    async () => {
      await ensureImage();
      const TK1 = `unit-killall-a-${Date.now()}`;
      const TK2 = `unit-killall-b-${Date.now()}`;
      created.push(containerName(TK1), containerName(TK2));

      // Pre-write a system_prompt on TK2 so we can verify killAll only
      // clears the sandbox field, not the rest.
      await writeSession(TK2, {
        status: 'idle',
        updated_at: 't',
        system_prompt: 'preserve-me',
      });

      await dockerProvider.ensure(TK1);
      await dockerProvider.ensure(TK2);

      // Image cache will be touched between ensures; that's fine.
      await dockerProvider.killAll();

      const a = await readSession(TK1);
      const b = await readSession(TK2);
      expect(a?.sandbox).toBeUndefined();
      expect(b?.sandbox).toBeUndefined();
      expect(b?.system_prompt).toBe('preserve-me');
    },
    240_000,
  );
});
