import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { invokeTool } from './index';

const ORIG_FETCH = globalThis.fetch;
const CTX = { threadKey: 'unit-test' };

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
});

describe('fetch_url', () => {
  beforeEach(() => {
    globalThis.fetch = (async () =>
      new Response('hello world', { status: 200 })) as unknown as typeof fetch;
  });

  test('GETs the URL and returns body with status', async () => {
    const r = await invokeTool('fetch_url', JSON.stringify({ url: 'https://x.test/page' }), CTX);
    expect(r.error).toBe(false);
    expect(r.content).toBe('HTTP 200\n\nhello world');
  });

  test('truncates large bodies', async () => {
    const big = 'a'.repeat(9 * 1024);
    globalThis.fetch = (async () => new Response(big, { status: 200 })) as unknown as typeof fetch;
    const r = await invokeTool('fetch_url', JSON.stringify({ url: 'https://x.test' }), CTX);
    expect(r.content).toContain('[truncated');
    expect(r.content.length).toBeLessThan(big.length);
  });

  test('error: missing url', async () => {
    const r = await invokeTool('fetch_url', '{}', CTX);
    expect(r.error).toBe(true);
    expect(r.content).toMatch(/missing or invalid url/);
  });

  test('error: invalid JSON args', async () => {
    const r = await invokeTool('fetch_url', 'not-json', CTX);
    expect(r.error).toBe(true);
    expect(r.content).toMatch(/invalid JSON/);
  });

  test('error: fetch throws', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const r = await invokeTool('fetch_url', JSON.stringify({ url: 'https://x.test' }), CTX);
    expect(r.error).toBe(true);
    expect(r.content).toMatch(/network down/);
  });
});
