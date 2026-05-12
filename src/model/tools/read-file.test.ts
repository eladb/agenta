import { describe, expect, test } from 'bun:test';
import { invokeTool } from './index';
import { readFileTool } from './read-file';

const CTX = { threadKey: 'unit-test' };

describe('read_file', () => {
  test('describe()', () => {
    expect(readFileTool.describe?.({ path: 'app.py' })).toBe('read app.py');
    expect(readFileTool.describe?.({ path: 'app.py', offset: 5, limit: 10 })).toBe(
      'read app.py:5-14',
    );
  });

  test('error: missing path', async () => {
    const r = await invokeTool('read_file', '{}', CTX);
    expect(r.error).toBe(true);
    expect(r.content).toMatch(/missing or invalid path/);
  });
});
