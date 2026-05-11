import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createCallModel } from './gateway';

const ORIG_FETCH = globalThis.fetch;

let lastCall: { url: string; init: RequestInit } | undefined;

function stubFetch(response: { status: number; body: unknown | string }) {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    lastCall = { url, init };
    const body = typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
    return new Response(body, { status: response.status });
  }) as typeof fetch;
}

beforeEach(() => {
  lastCall = undefined;
});

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
});

describe('createCallModel', () => {
  it('POSTs to baseUrl + /chat/completions with Bearer auth and returns the content', async () => {
    stubFetch({
      status: 200,
      body: { choices: [{ message: { content: 'hello back' } }] },
    });
    const call = createCallModel({
      apiKey: 'k123',
      baseUrl: 'https://example.test/v1',
      model: 'm',
    });
    const out = await call([{ role: 'user', content: 'hi' }]);
    expect(out).toBe('hello back');
    expect(lastCall?.url).toBe('https://example.test/v1/chat/completions');
    const headers = lastCall?.init?.headers as Record<string, string>;
    expect(headers?.Authorization).toBe('Bearer k123');
    expect(headers?.['Content-Type']).toBe('application/json');
    const body = JSON.parse(lastCall?.init?.body as string);
    expect(body.model).toBe('m');
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  it('throws on non-2xx with HTTP status and body in message', async () => {
    stubFetch({ status: 401, body: 'unauthorized' });
    const call = createCallModel({ apiKey: 'k', baseUrl: 'https://x.test/v1', model: 'm' });
    await expect(call([])).rejects.toThrow(/model HTTP 401/);
  });

  it('throws if the response has no content', async () => {
    stubFetch({ status: 200, body: { choices: [] } });
    const call = createCallModel({ apiKey: 'k', baseUrl: 'https://x.test/v1', model: 'm' });
    await expect(call([])).rejects.toThrow(/empty content/);
  });
});
