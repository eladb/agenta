import { describe, expect, test } from 'bun:test';
import { invokeTool, TOOL_DEFS, TOOLS } from './index';

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
      'grep',
      'glob',
      'list_dir',
      'ask_user',
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
