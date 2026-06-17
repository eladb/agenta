import { describe, expect, test } from 'bun:test';
import { invokeTool } from './index';

const CTX = { threadKey: 'unit-test' };

describe('read_file', () => {
  test('error: missing path', async () => {
    const r = await invokeTool('read_file', '{}', CTX);
    expect(r.error).toBe(true);
    expect(r.content).toMatch(/missing or invalid path/);
  });
});
