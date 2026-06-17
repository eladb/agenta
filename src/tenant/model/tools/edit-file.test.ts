import { describe, expect, test } from 'bun:test';
import { invokeTool } from './index';

const CTX = { threadKey: 'unit-test' };

describe('edit_file', () => {
  test('error: missing path', async () => {
    const r = await invokeTool(
      'edit_file',
      JSON.stringify({ old_string: 'a', new_string: 'b' }),
      CTX,
    );
    expect(r.error).toBe(true);
    expect(r.content).toMatch(/missing or invalid path/);
  });

  test('error: missing old_string', async () => {
    const r = await invokeTool(
      'edit_file',
      JSON.stringify({ path: '/tmp/x', new_string: 'b' }),
      CTX,
    );
    expect(r.error).toBe(true);
    expect(r.content).toMatch(/missing or invalid old_string/);
  });

  test('error: missing new_string', async () => {
    const r = await invokeTool(
      'edit_file',
      JSON.stringify({ path: '/tmp/x', old_string: 'a' }),
      CTX,
    );
    expect(r.error).toBe(true);
    expect(r.content).toMatch(/missing or invalid new_string/);
  });
});
