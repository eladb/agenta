import { describe, expect, test } from 'bun:test';
import { invokeTool } from './index';

const CTX = { threadKey: 'unit-test' };

describe('write_file', () => {
  test('error: missing path', async () => {
    const r = await invokeTool('write_file', JSON.stringify({ content: 'x' }), CTX);
    expect(r.error).toBe(true);
    expect(r.content).toMatch(/missing or invalid path/);
  });

  test('error: missing content', async () => {
    const r = await invokeTool('write_file', JSON.stringify({ path: '/tmp/a' }), CTX);
    expect(r.error).toBe(true);
    expect(r.content).toMatch(/missing or invalid content/);
  });

  test('error: content over the size cap', async () => {
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
