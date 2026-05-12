import { describe, expect, test } from 'bun:test';
import { glob } from './glob';
import { invokeTool } from './index';

const CTX = { threadKey: 'unit-test' };

describe('glob', () => {
  test('describe()', () => {
    expect(glob.describe?.({ pattern: '**/*.ts' })).toBe('glob **/*.ts');
    expect(glob.describe?.({ pattern: '*.py', path: 'src' })).toBe('glob *.py in src');
  });

  test('error: missing pattern', async () => {
    const r = await invokeTool('glob', '{}', CTX);
    expect(r.error).toBe(true);
    expect(r.content).toMatch(/missing or invalid pattern/);
  });
});
