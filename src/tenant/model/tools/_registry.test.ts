import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invokeTool, registerExtraTools, TOOL_DEFS, TOOLS } from './index';

const CTX = { threadKey: 'unit-test' };

describe('TOOL_DEFS', () => {
  test('exposes every tool registered in TOOLS', () => {
    const names = TOOL_DEFS.map((t) => t.function.name).sort();
    const keys = Object.keys(TOOLS).sort();
    expect(names).toEqual(keys);
  });

  test('expected set of tools is present', () => {
    const names = new Set(TOOL_DEFS.map((t) => t.function.name));
    for (const expected of [
      'get_current_time',
      'fetch_url',
      'bash',
      'read_file',
      'write_file',
      'edit_file',
      'ask_user',
      'github_create_pr',
      'github_update_pr',
      'github_pr_comment',
    ]) {
      expect(names.has(expected)).toBe(true);
    }
  });
});

describe('Tool contract', () => {
  test('every tool def name matches its TOOLS key', () => {
    for (const [key, tool] of Object.entries(TOOLS)) {
      expect(tool.def.function.name).toBe(key);
    }
  });

  test('every tool has a describe() and it is safe on malformed input', () => {
    for (const [, tool] of Object.entries(TOOLS)) {
      expect(typeof tool.describe).toBe('function');
      expect(() => tool.describe?.(null)).not.toThrow();
      expect(() => tool.describe?.({})).not.toThrow();
      const out = tool.describe?.({});
      expect(typeof out).toBe('string');
      expect((out ?? '').length).toBeGreaterThan(0);
      // Must stay single-line for the Slack checklist.
      expect((out ?? '').includes('\n')).toBe(false);
    }
  });
});

describe('invokeTool', () => {
  test('unknown tool returns error result', async () => {
    const r = await invokeTool('does_not_exist', '{}', CTX);
    expect(r.error).toBe(true);
    expect(r.content).toMatch(/unknown tool/);
  });
});

describe('registerExtraTools', () => {
  // registerExtraTools mutates the shared TOOLS / TOOL_DEFS module state.
  // Track names we register so each test can roll the registry back, keeping
  // the built-in invariants above intact regardless of test order.
  const added: string[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    for (const name of added.splice(0)) delete TOOLS[name];
    // Recompute the live binding off the now-pruned registry.
    await registerExtraTools({});
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const mkDir = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'agenta-extra-tools-'));
    dirs.push(dir);
    return dir;
  };

  const goodTool = (name: string): string => `
export default {
  def: { type: 'function', function: { name: '${name}', description: 'x', parameters: { type: 'object', properties: {} } } },
  describe: () => '${name} run',
  invoke: async () => 'ok from ${name}',
};
`;

  test('no-op when AGENTA_EXTRA_TOOLS is unset', async () => {
    const before = TOOL_DEFS.length;
    await registerExtraTools({});
    expect(TOOL_DEFS.length).toBe(before);
  });

  test('registers a fixture tool and exposes it in TOOL_DEFS', async () => {
    const dir = await mkDir();
    await writeFile(join(dir, 'extra.ts'), goodTool('extra_demo'));
    added.push('extra_demo');

    await registerExtraTools({ AGENTA_EXTRA_TOOLS: dir });

    expect(TOOLS.extra_demo).toBeDefined();
    expect(TOOL_DEFS.map((t) => t.function.name)).toContain('extra_demo');
    const r = await invokeTool('extra_demo', '{}', CTX);
    expect(r.error).toBe(false);
    expect(r.content).toBe('ok from extra_demo');
  });

  test('throws on a name collision with a built-in', async () => {
    const dir = await mkDir();
    await writeFile(join(dir, 'dupe.ts'), goodTool('bash'));
    await expect(registerExtraTools({ AGENTA_EXTRA_TOOLS: dir })).rejects.toThrow(/collides/);
  });

  test('throws on a malformed module (missing describe)', async () => {
    const dir = await mkDir();
    await writeFile(
      join(dir, 'bad.ts'),
      `export default { def: { type: 'function', function: { name: 'broken_tool' } }, invoke: async () => 'x' };`,
    );
    await expect(registerExtraTools({ AGENTA_EXTRA_TOOLS: dir })).rejects.toThrow(/describe/);
    // Failed registration must not leak a partial entry.
    expect(TOOLS.broken_tool).toBeUndefined();
  });

  test('throws on a bad def (missing function.name)', async () => {
    const dir = await mkDir();
    await writeFile(
      join(dir, 'noname.ts'),
      `export default { def: { type: 'function', function: {} }, describe: () => 'x', invoke: async () => 'x' };`,
    );
    await expect(registerExtraTools({ AGENTA_EXTRA_TOOLS: dir })).rejects.toThrow(
      /def\.function\.name/,
    );
  });
});
