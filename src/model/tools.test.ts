import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { formatBashResult, invokeTool, TOOL_DEFS, TOOLS } from './tools';

const ORIG_FETCH = globalThis.fetch;
const CTX = { threadKey: 'unit-test' };

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
});

describe('TOOL_DEFS', () => {
  test('exposes get_current_time, fetch_url, bash', () => {
    const names = TOOL_DEFS.map((t) => t.function.name);
    expect(names).toContain('get_current_time');
    expect(names).toContain('fetch_url');
    expect(names).toContain('bash');
  });
});

describe('invokeTool: get_current_time', () => {
  test('returns an ISO timestamp', async () => {
    const r = await invokeTool('get_current_time', '{}', CTX);
    expect(r.error).toBe(false);
    expect(r.content).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test('accepts empty args string', async () => {
    const r = await invokeTool('get_current_time', '', CTX);
    expect(r.error).toBe(false);
  });
});

describe('invokeTool: fetch_url', () => {
  beforeEach(() => {
    globalThis.fetch = (async (_url: string, _init?: RequestInit) => {
      return new Response('hello world', { status: 200 });
    }) as unknown as typeof fetch;
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

  test('returns an error result on missing url', async () => {
    const r = await invokeTool('fetch_url', '{}', CTX);
    expect(r.error).toBe(true);
    expect(r.content).toMatch(/missing or invalid url/);
  });

  test('returns an error result on invalid JSON args', async () => {
    const r = await invokeTool('fetch_url', 'not-json', CTX);
    expect(r.error).toBe(true);
    expect(r.content).toMatch(/invalid JSON/);
  });

  test('returns an error result if fetch throws', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const r = await invokeTool('fetch_url', JSON.stringify({ url: 'https://x.test' }), CTX);
    expect(r.error).toBe(true);
    expect(r.content).toMatch(/network down/);
  });
});

describe('invokeTool: unknown', () => {
  test('returns error for unknown tool', async () => {
    const r = await invokeTool('does_not_exist', '{}', CTX);
    expect(r.error).toBe(true);
    expect(r.content).toMatch(/unknown tool/);
  });
});

describe('TOOLS registry', () => {
  test('each tool def name matches its key', () => {
    for (const [key, tool] of Object.entries(TOOLS)) {
      expect(tool.def.function.name).toBe(key);
    }
  });
});

describe('formatBashResult', () => {
  test('renders exit, stdout, stderr', () => {
    const out = formatBashResult({ stdout: 'hi\n', stderr: 'warn\n', exitCode: 0 });
    expect(out).toContain('exit: 0');
    expect(out).toContain('--- stdout ---');
    expect(out).toContain('hi');
    expect(out).toContain('--- stderr ---');
    expect(out).toContain('warn');
  });

  test('omits stdout/stderr sections when empty', () => {
    const out = formatBashResult({ stdout: '', stderr: '', exitCode: 1 });
    expect(out).toBe('exit: 1');
  });

  test('truncates oversize streams', () => {
    const big = 'x'.repeat(20 * 1024);
    const out = formatBashResult({ stdout: big, stderr: '', exitCode: 0 });
    expect(out).toContain('[stdout truncated');
    expect(out.length).toBeLessThan(big.length);
  });
});

describe('invokeTool: bash (arg validation)', () => {
  // These tests trigger before any docker call would happen — the missing /
  // invalid argument path returns early. We don't exercise the docker
  // codepath here; that's covered by tests/e2e/sandbox.test.ts.
  test('missing command returns an error result', async () => {
    const r = await invokeTool('bash', '{}', CTX);
    expect(r.error).toBe(true);
    expect(r.content).toMatch(/missing or invalid command/);
  });

  test('invalid JSON args returns an error result', async () => {
    const r = await invokeTool('bash', '{not json', CTX);
    expect(r.error).toBe(true);
    expect(r.content).toMatch(/invalid JSON/);
  });
});
