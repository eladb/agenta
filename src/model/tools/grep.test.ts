import { describe, expect, test } from 'bun:test';
import { grep } from './grep';
import { invokeTool } from './index';

const CTX = { threadKey: 'unit-test' };

describe('grep', () => {
  test('describe()', () => {
    expect(grep.describe?.({ pattern: 'TODO', glob: '*.py' })).toBe('grep "TODO" in *.py');
    expect(grep.describe?.({ pattern: 'TODO', path: 'src' })).toBe('grep "TODO" in src');
    expect(grep.describe?.({ pattern: 'TODO' })).toBe('grep "TODO"');
  });

  test('error: missing pattern', async () => {
    const r = await invokeTool('grep', '{}', CTX);
    expect(r.error).toBe(true);
    expect(r.content).toMatch(/missing or invalid pattern/);
  });
});
