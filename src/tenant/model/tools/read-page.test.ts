import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { invokeTool } from './index';

const ORIG_FETCH = globalThis.fetch;
const ORIG_KEY = process.env.TAVILY_API_KEY;
const CTX = { threadKey: 'unit-test' };

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
  if (ORIG_KEY === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = ORIG_KEY;
});

describe('read_page', () => {
  beforeEach(() => {
    process.env.TAVILY_API_KEY = 'test-key';
  });

  test('POSTs to Tavily with correct body shape and parses response', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(
        JSON.stringify({
          results: [{ url: 'https://example.com/article', raw_content: 'The full article body.' }],
          failed_results: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const r = await invokeTool(
      'read_page',
      JSON.stringify({ url: 'https://example.com/article' }),
      CTX,
    );
    expect(r.error).toBe(false);
    expect(capturedUrl).toBe('https://api.tavily.com/extract');
    expect(capturedInit?.method).toBe('POST');
    const body = JSON.parse(capturedInit?.body as string);
    expect(body.api_key).toBe('test-key');
    expect(body.urls).toEqual(['https://example.com/article']);
    expect(body.extract_depth).toBe('basic');
    expect(body.include_images).toBe(false);

    const parsed = JSON.parse(r.content) as { url: string; content: string };
    expect(parsed.url).toBe('https://example.com/article');
    expect(parsed.content).toBe('The full article body.');
  });

  test('truncates content to ~16 KB', async () => {
    const big = 'a'.repeat(20 * 1024);
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          results: [{ url: 'https://x', raw_content: big }],
          failed_results: [],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const r = await invokeTool('read_page', JSON.stringify({ url: 'https://x' }), CTX);
    expect(r.error).toBe(false);
    const parsed = JSON.parse(r.content) as { content: string };
    expect(parsed.content).toContain('[page truncated');
    expect(parsed.content.length).toBeLessThan(big.length);
  });

  test('url in failed_results returns clean error string', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          results: [],
          failed_results: [{ url: 'https://nope', error: 'paywall' }],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const r = await invokeTool('read_page', JSON.stringify({ url: 'https://nope' }), CTX);
    expect(r.error).toBe(false);
    expect(r.content).toBe('read_page failed: paywall');
  });

  test('missing TAVILY_API_KEY returns clean error string', async () => {
    delete process.env.TAVILY_API_KEY;
    const r = await invokeTool('read_page', JSON.stringify({ url: 'https://x' }), CTX);
    expect(r.error).toBe(false);
    expect(r.content).toBe('tavily error: TAVILY_API_KEY not set');
  });

  test('non-2xx response returns clean error string', async () => {
    globalThis.fetch = (async () =>
      new Response('rate limited', { status: 429 })) as unknown as typeof fetch;
    const r = await invokeTool('read_page', JSON.stringify({ url: 'https://x' }), CTX);
    expect(r.error).toBe(false);
    expect(r.content).toBe('tavily error: 429');
  });

  test('error: missing url', async () => {
    const r = await invokeTool('read_page', '{}', CTX);
    expect(r.error).toBe(true);
    expect(r.content).toMatch(/missing or invalid url/);
  });
});
