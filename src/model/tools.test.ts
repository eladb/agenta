import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { formatBashResult, invokeTool, TOOL_DEFS, TOOLS } from './tools';

const ORIG_FETCH = globalThis.fetch;
const CTX = { threadKey: 'unit-test' };

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
});

describe('TOOL_DEFS', () => {
  test('exposes the full coding-agent tool set', () => {
    const names = TOOL_DEFS.map((t) => t.function.name);
    for (const expected of [
      'get_current_time',
      'fetch_url',
      'bash',
      'read_file',
      'write_file',
      'edit_file',
      'grep',
      'glob',
      'list_dir',
    ]) {
      expect(names).toContain(expected);
    }
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

  test('every tool has a describe()', () => {
    for (const [name, tool] of Object.entries(TOOLS)) {
      expect(typeof tool.describe).toBe('function');
      // Must be safe on malformed input (model might emit bad JSON).
      expect(() => tool.describe?.(null)).not.toThrow();
      expect(() => tool.describe?.({})).not.toThrow();
      const out = tool.describe?.({});
      expect(typeof out).toBe('string');
      expect((out ?? '').length).toBeGreaterThan(0);
      // Should not span multiple lines.
      expect((out ?? '').includes('\n')).toBe(false);
      void name;
    }
  });

  test('describers render meaningful lines for known arg shapes', () => {
    expect(TOOLS.get_current_time?.describe?.({})).toBe('get current time');
    expect(TOOLS.fetch_url?.describe?.({ url: 'https://example.com' })).toBe(
      'fetch https://example.com',
    );
    expect(TOOLS.bash?.describe?.({ command: 'ls -la' })).toBe('$ ls -la');
    expect(TOOLS.read_file?.describe?.({ path: 'app.py' })).toBe('read app.py');
    expect(TOOLS.read_file?.describe?.({ path: 'app.py', offset: 5, limit: 10 })).toBe(
      'read app.py:5-14',
    );
    expect(TOOLS.write_file?.describe?.({ path: 'app.py', content: 'hello' })).toBe(
      'write app.py (5 chars)',
    );
    expect(TOOLS.edit_file?.describe?.({ path: 'app.py' })).toBe('edit app.py');
    expect(TOOLS.grep?.describe?.({ pattern: 'TODO', glob: '*.py' })).toBe(
      'grep "TODO" in *.py',
    );
    expect(TOOLS.glob?.describe?.({ pattern: '**/*.ts' })).toBe('glob **/*.ts');
    expect(TOOLS.list_dir?.describe?.({ path: 'src' })).toBe('list src');
    expect(TOOLS.list_dir?.describe?.({})).toBe('list /workspace');
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

describe('invokeTool: read_file / write_file (arg validation)', () => {
  test('read_file with missing path returns an error', async () => {
    const r = await invokeTool('read_file', '{}', CTX);
    expect(r.error).toBe(true);
    expect(r.content).toMatch(/missing or invalid path/);
  });

  test('write_file with missing path returns an error', async () => {
    const r = await invokeTool('write_file', JSON.stringify({ content: 'x' }), CTX);
    expect(r.error).toBe(true);
    expect(r.content).toMatch(/missing or invalid path/);
  });

  test('write_file with missing content returns an error', async () => {
    const r = await invokeTool('write_file', JSON.stringify({ path: '/tmp/a' }), CTX);
    expect(r.error).toBe(true);
    expect(r.content).toMatch(/missing or invalid content/);
  });

  test('write_file rejects content over the size cap', async () => {
    const huge = 'x'.repeat(64 * 1024 + 1);
    const r = await invokeTool(
      'write_file',
      JSON.stringify({ path: '/tmp/a', content: huge }),
      CTX,
    );
    expect(r.error).toBe(true);
    expect(r.content).toMatch(/exceeds .* limit/);
  });
});

describe('invokeTool: edit_file / grep / glob (arg validation)', () => {
  test('edit_file with missing path returns an error', async () => {
    const r = await invokeTool(
      'edit_file',
      JSON.stringify({ old_string: 'a', new_string: 'b' }),
      CTX,
    );
    expect(r.error).toBe(true);
    expect(r.content).toMatch(/missing or invalid path/);
  });

  test('edit_file with missing old_string returns an error', async () => {
    const r = await invokeTool(
      'edit_file',
      JSON.stringify({ path: '/tmp/x', new_string: 'b' }),
      CTX,
    );
    expect(r.error).toBe(true);
    expect(r.content).toMatch(/missing or invalid old_string/);
  });

  test('edit_file with missing new_string returns an error', async () => {
    const r = await invokeTool(
      'edit_file',
      JSON.stringify({ path: '/tmp/x', old_string: 'a' }),
      CTX,
    );
    expect(r.error).toBe(true);
    expect(r.content).toMatch(/missing or invalid new_string/);
  });

  test('grep with missing pattern returns an error', async () => {
    const r = await invokeTool('grep', '{}', CTX);
    expect(r.error).toBe(true);
    expect(r.content).toMatch(/missing or invalid pattern/);
  });

  test('glob with missing pattern returns an error', async () => {
    const r = await invokeTool('glob', '{}', CTX);
    expect(r.error).toBe(true);
    expect(r.content).toMatch(/missing or invalid pattern/);
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
