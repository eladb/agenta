import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { _resetImageReadyCache, dockerProvider } from './docker';
import { _resetFlyState, flyProvider } from './fly';
import { consumeExecStream, containerName, writeBinary } from './index';

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
