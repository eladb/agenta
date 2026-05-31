import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createCallModel, translateFromBedrock, translateToBedrock } from './gateway';

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
  it('POSTs to baseUrl + /chat/completions with Bearer auth and returns the assistant message', async () => {
    stubFetch({
      status: 200,
      body: { choices: [{ message: { role: 'assistant', content: 'hello back' } }] },
    });
    const call = createCallModel({
      apiKey: 'k123',
      baseUrl: 'https://example.test/v1',
      model: 'm',
    });
    const out = await call([{ role: 'user', content: 'hi' }]);
    expect(out).toEqual({ role: 'assistant', content: 'hello back' });
    expect(lastCall?.url).toBe('https://example.test/v1/chat/completions');
    const headers = lastCall?.init?.headers as Record<string, string>;
    expect(headers?.Authorization).toBe('Bearer k123');
    expect(headers?.['Content-Type']).toBe('application/json');
    expect(headers?.['HTTP-Referer']).toBeDefined();
    expect(headers?.['X-Title']).toBe('agenta');
    const body = JSON.parse(lastCall?.init?.body as string);
    expect(body.model).toBe('m');
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.tools).toBeUndefined();
  });

  it('forwards the tools option into the request body', async () => {
    stubFetch({
      status: 200,
      body: {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'get_current_time', arguments: '{}' },
                },
              ],
            },
          },
        ],
      },
    });
    const call = createCallModel({ apiKey: 'k', baseUrl: 'https://x.test/v1', model: 'm' });
    const tools = [
      {
        type: 'function' as const,
        function: { name: 'get_current_time', description: 'd', parameters: {} },
      },
    ];
    const out = await call([{ role: 'user', content: 'now?' }], { tools });
    expect(out.tool_calls?.[0]?.function.name).toBe('get_current_time');
    const body = JSON.parse(lastCall?.init?.body as string);
    expect(body.tools).toEqual(tools);
  });

  it('throws on non-2xx with HTTP status and body in message', async () => {
    stubFetch({ status: 401, body: 'unauthorized' });
    const call = createCallModel({ apiKey: 'k', baseUrl: 'https://x.test/v1', model: 'm' });
    await expect(call([])).rejects.toThrow(/model HTTP 401/);
  });

  it('reads apiKeyEnv at call time (#128 per-thread triplet path)', async () => {
    process.env.GATEWAY_TEST_KEY = 'env-key-v1';
    stubFetch({
      status: 200,
      body: { choices: [{ message: { role: 'assistant', content: 'ok' } }] },
    });
    const call = createCallModel({
      apiKeyEnv: 'GATEWAY_TEST_KEY',
      baseUrl: 'https://x.test/v1',
      model: 'm',
    });
    // First call uses the initial env value.
    await call([{ role: 'user', content: 'hi' }]);
    expect((lastCall?.init?.headers as Record<string, string>).Authorization).toBe(
      'Bearer env-key-v1',
    );
    // Rotate the env and re-call — the gateway must pick up the new value
    // (mirrors how `home.auth_env` lazy-reads PATs/PEMs at use time).
    process.env.GATEWAY_TEST_KEY = 'env-key-v2';
    await call([{ role: 'user', content: 'again' }]);
    expect((lastCall?.init?.headers as Record<string, string>).Authorization).toBe(
      'Bearer env-key-v2',
    );
    delete process.env.GATEWAY_TEST_KEY;
  });

  it('throws when apiKeyEnv references an unset env var at call time', async () => {
    delete process.env.GATEWAY_TEST_KEY_MISSING;
    const call = createCallModel({
      apiKeyEnv: 'GATEWAY_TEST_KEY_MISSING',
      baseUrl: 'https://x.test/v1',
      model: 'm',
    });
    await expect(call([])).rejects.toThrow(/GATEWAY_TEST_KEY_MISSING is unset/);
  });

  it('throws if the response has no content and no tool_calls', async () => {
    stubFetch({
      status: 200,
      body: { choices: [{ message: { role: 'assistant', content: null } }] },
    });
    const call = createCallModel({ apiKey: 'k', baseUrl: 'https://x.test/v1', model: 'm' });
    await expect(call([])).rejects.toThrow(/empty content/);
  });
});

describe('createCallModel — bedrock branch', () => {
  it('POSTs to bedrock-runtime/<region>/model/<id>/invoke with Bearer auth + Anthropic body', async () => {
    stubFetch({
      status: 200,
      body: { content: [{ type: 'text', text: 'hi back' }], stop_reason: 'end_turn' },
    });
    const call = createCallModel({
      apiKey: 'aws-bearer',
      baseUrl: 'bedrock://us-east-1',
      model: 'us.anthropic.claude-opus-4-7',
    });
    const out = await call([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ]);
    expect(out).toEqual({ role: 'assistant', content: 'hi back' });
    expect(lastCall?.url).toBe(
      'https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-opus-4-7/invoke',
    );
    const headers = lastCall?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer aws-bearer');
    // No OpenRouter ranking headers — those are noise on Bedrock.
    expect(headers['HTTP-Referer']).toBeUndefined();
    const body = JSON.parse(lastCall?.init?.body as string);
    expect(body.anthropic_version).toBe('bedrock-2023-05-31');
    expect(body.system).toBe('be terse');
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
    expect(body.model).toBeUndefined(); // model is in the URL path, not the body
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  it('translates tools schema OpenAI → Anthropic and forwards them', async () => {
    stubFetch({
      status: 200,
      body: {
        content: [{ type: 'tool_use', id: 'tu_1', name: 'get_current_time', input: {} }],
        stop_reason: 'tool_use',
      },
    });
    const call = createCallModel({
      apiKey: 'k',
      baseUrl: 'bedrock://us-east-1',
      model: 'us.anthropic.claude-opus-4-7',
    });
    const out = await call([{ role: 'user', content: 'now?' }], {
      tools: [
        {
          type: 'function',
          function: { name: 'get_current_time', description: 'd', parameters: { type: 'object' } },
        },
      ],
    });
    expect(out.tool_calls).toEqual([
      { id: 'tu_1', type: 'function', function: { name: 'get_current_time', arguments: '{}' } },
    ]);
    const body = JSON.parse(lastCall?.init?.body as string);
    expect(body.tools).toEqual([
      { name: 'get_current_time', description: 'd', input_schema: { type: 'object' } },
    ]);
  });

  it('throws on non-2xx and reads apiKeyEnv at call time', async () => {
    stubFetch({ status: 400, body: 'on-demand throughput not supported' });
    const call = createCallModel({
      apiKey: 'k',
      baseUrl: 'bedrock://us-east-1',
      model: 'anthropic.claude-opus-4-7',
    });
    await expect(call([{ role: 'user', content: 'hi' }])).rejects.toThrow(/model HTTP 400/);

    process.env.BEDROCK_TEST_KEY = 'env-v1';
    stubFetch({
      status: 200,
      body: { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' },
    });
    const call2 = createCallModel({
      apiKeyEnv: 'BEDROCK_TEST_KEY',
      baseUrl: 'bedrock://us-west-2',
      model: 'us.anthropic.claude-sonnet-4-6',
    });
    await call2([{ role: 'user', content: 'hi' }]);
    expect((lastCall?.init?.headers as Record<string, string>).Authorization).toBe('Bearer env-v1');
    delete process.env.BEDROCK_TEST_KEY;
  });

  it('rejects bedrock:// with no region', () => {
    expect(() =>
      createCallModel({
        apiKey: 'k',
        baseUrl: 'bedrock://',
        model: 'us.anthropic.claude-opus-4-7',
      }),
    ).toThrow(/bedrock base_url must be bedrock:/);
  });
});

describe('translateToBedrock', () => {
  it('lifts system messages out of messages[] and joins consecutive ones', () => {
    const { system, messages } = translateToBedrock([
      { role: 'system', content: 'first' },
      { role: 'system', content: 'second' },
      { role: 'user', content: 'hi' },
    ]);
    expect(system).toBe('first\n\nsecond');
    expect(messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  });

  it('converts image_url data URLs into image blocks; PDFs into document blocks', () => {
    const { messages } = translateToBedrock([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,iVBOR' },
          },
          {
            type: 'image_url',
            image_url: { url: 'data:application/pdf;base64,JVBE' },
          },
        ],
      },
    ]);
    expect(messages[0]?.content).toEqual([
      { type: 'text', text: 'see' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } },
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: 'JVBE' },
      },
    ]);
  });

  it('encodes assistant tool_calls as tool_use blocks; consecutive tool messages group into one user turn', () => {
    const { messages } = translateToBedrock([
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: 'sure',
        tool_calls: [
          { id: 't1', type: 'function', function: { name: 'f1', arguments: '{"x":1}' } },
          { id: 't2', type: 'function', function: { name: 'f2', arguments: '' } },
        ],
      },
      { role: 'tool', tool_call_id: 't1', content: 'r1' },
      { role: 'tool', tool_call_id: 't2', content: 'r2' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'and now?' },
    ]);
    expect(messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'do it' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'sure' },
          { type: 'tool_use', id: 't1', name: 'f1', input: { x: 1 } },
          { type: 'tool_use', id: 't2', name: 'f2', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'r1' },
          { type: 'tool_result', tool_use_id: 't2', content: 'r2' },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      { role: 'user', content: [{ type: 'text', text: 'and now?' }] },
    ]);
  });

  it('strips trailing assistant message (no prefill support)', () => {
    const { messages } = translateToBedrock([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'partial response' },
    ]);
    expect(messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]);
  });

  it('handles user text interleaved between assistant tool_calls and tool results (mid-turn steering)', () => {
    // OpenAI format allows: assistant(tool_calls) → user(text) → tool(result)
    // Anthropic requires tool_results immediately after tool_use in the same
    // user turn. The translator must reorder so tool_results come before text.
    const { messages } = translateToBedrock([
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 't1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } },
        ],
      },
      { role: 'user', content: 'also do X' },
      { role: 'tool', tool_call_id: 't1', content: 'file1\nfile2' },
    ]);
    expect(messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'do it' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'bash', input: { command: 'ls' } }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'file1\nfile2' },
          { type: 'text', text: 'also do X' },
        ],
      },
    ]);
  });

  it('drops a user message with empty string content — no empty text block (#223)', () => {
    const { messages } = translateToBedrock([
      { role: 'system', content: 'sys' },
      { role: 'user', content: '' },
    ]);
    // The only user content was empty, so no user turn at all (and crucially
    // no { type:'text', text:'' } block that Bedrock would 400 on).
    expect(messages).toEqual([]);
  });

  it('drops only the empty text part from a mixed user content array (#223)', () => {
    const { messages } = translateToBedrock([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'keep me' },
          { type: 'text', text: '' },
        ],
      },
    ]);
    expect(messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'keep me' }] }]);
  });

  it('does not merge an empty user message into a prior user turn (#223)', () => {
    const { messages } = translateToBedrock([
      { role: 'user', content: 'first' },
      { role: 'user', content: '' },
    ]);
    // The empty second user message is skipped, not merged as an empty block.
    expect(messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'first' }] }]);
  });

  it('does not emit an empty text block for an assistant with empty-string content and no tool_calls (#223)', () => {
    const { messages } = translateToBedrock([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'still here?' },
    ]);
    // The empty assistant turn is skipped entirely — never rendered as
    // { type:'text', text:'' } (which Bedrock rejects). With the assistant
    // gone the two user turns become consecutive and merge into one (existing
    // alternating-turns behavior). No empty text block anywhere.
    expect(messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'text', text: 'still here?' },
        ],
      },
    ]);
  });

  it('does not emit an empty text block for a content:null assistant with no tool_calls (#223)', () => {
    const { messages } = translateToBedrock([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null },
      { role: 'user', content: 'continue' },
    ]);
    expect(messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'text', text: 'continue' },
        ],
      },
    ]);
  });

  it('handles multiple tool results after interleaved user text', () => {
    const { messages } = translateToBedrock([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'a', type: 'function', function: { name: 'f1', arguments: '' } },
          { id: 'b', type: 'function', function: { name: 'f2', arguments: '' } },
        ],
      },
      { role: 'user', content: 'steering msg' },
      { role: 'tool', tool_call_id: 'a', content: 'ra' },
      { role: 'tool', tool_call_id: 'b', content: 'rb' },
    ]);
    // tool_results cluster at front, steering text after
    expect(messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: 'ra' },
        { type: 'tool_result', tool_use_id: 'b', content: 'rb' },
        { type: 'text', text: 'steering msg' },
      ],
    });
  });
});

describe('translateFromBedrock', () => {
  it('extracts text + tool_use blocks into OpenAI assistant shape', () => {
    const out = translateFromBedrock({
      content: [
        { type: 'text', text: 'thinking… ' },
        { type: 'tool_use', id: 'tu_1', name: 'f', input: { a: 1 } },
        { type: 'text', text: 'done' },
      ],
    });
    expect(out).toEqual({
      role: 'assistant',
      content: 'thinking… done',
      tool_calls: [{ id: 'tu_1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }],
    });
  });

  it('returns content-only assistant when no tool_use blocks present', () => {
    const out = translateFromBedrock({ content: [{ type: 'text', text: 'hello' }] });
    expect(out).toEqual({ role: 'assistant', content: 'hello' });
  });

  it('throws when both text and tool_use are empty', () => {
    expect(() => translateFromBedrock({ content: [] })).toThrow(/empty content/);
  });
});
