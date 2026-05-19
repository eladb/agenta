import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { invokeTool } from './index';
import { webSearch } from './web-search';

const ORIG_FETCH = globalThis.fetch;
const ORIG_KEY = process.env.TAVILY_API_KEY;
const CTX = { threadKey: 'unit-test' };

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
  if (ORIG_KEY === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = ORIG_KEY;
});

describe('web_search', () => {
  test('describe()', () => {
    expect(webSearch.describe?.({ query: 'who is ada lovelace' })).toBe(
      'web_search: who is ada lovelace',
    );
    expect(webSearch.describe?.({})).toBe('web_search (no query)');
  });

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
          results: [
            { title: 'Ada Lovelace', url: 'https://en.wikipedia.org/wiki/Ada_Lovelace', content: 'English mathematician.' },
            { title: 'Bio', url: 'https://example.com/ada', content: 'More details.' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const r = await invokeTool(
      'web_search',
      JSON.stringify({ query: 'ada lovelace' }),
      CTX,
    );
    expect(r.error).toBe(false);
    expect(capturedUrl).toBe('https://api.tavily.com/search');
    expect(capturedInit?.method).toBe('POST');
    const body = JSON.parse(capturedInit?.body as string);
    expect(body.api_key).toBe('test-key');
    expect(body.query).toBe('ada lovelace');
    expect(body.max_results).toBe(5);
    expect(body.search_depth).toBe('basic');
    expect(body.include_answer).toBe(false);
    expect(body.include_raw_content).toBe(false);

    const parsed = JSON.parse(r.content) as {
      results: Array<{ title: string; url: string; snippet: string }>;
    };
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results[0]).toEqual({
      title: 'Ada Lovelace',
      url: 'https://en.wikipedia.org/wiki/Ada_Lovelace',
      snippet: 'English mathematician.',
    });
  });

  test('caps max_results at 10', async () => {
    let capturedBody: { max_results?: number } = {};
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await invokeTool('web_search', JSON.stringify({ query: 'q', max_results: 99 }), CTX);
    expect(capturedBody.max_results).toBe(10);
  });

  test('truncates long snippets to ~280 chars', async () => {
    const big = 'a'.repeat(500);
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ results: [{ title: 't', url: 'https://x', content: big }] }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const r = await invokeTool('web_search', JSON.stringify({ query: 'q' }), CTX);
    const parsed = JSON.parse(r.content) as {
      results: Array<{ snippet: string }>;
    };
    expect(parsed.results[0].snippet).toContain('[snippet truncated');
    expect(parsed.results[0].snippet.length).toBeLessThan(big.length);
  });

  test('missing TAVILY_API_KEY returns clean error string', async () => {
    delete process.env.TAVILY_API_KEY;
    const r = await invokeTool('web_search', JSON.stringify({ query: 'q' }), CTX);
    expect(r.error).toBe(false);
    expect(r.content).toBe('tavily error: TAVILY_API_KEY not set');
  });

  test('non-2xx response returns clean error string', async () => {
    globalThis.fetch = (async () =>
      new Response('rate limited', { status: 429 })) as unknown as typeof fetch;
    const r = await invokeTool('web_search', JSON.stringify({ query: 'q' }), CTX);
    expect(r.error).toBe(false);
    expect(r.content).toBe('tavily error: 429');
  });

  test('error: missing query', async () => {
    const r = await invokeTool('web_search', '{}', CTX);
    expect(r.error).toBe(true);
    expect(r.content).toMatch(/missing or invalid query/);
  });
});
