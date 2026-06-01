import { describe, expect, test } from 'bun:test';
import { bash, formatBashResult } from './bash';
import { invokeTool } from './index';

const CTX = { threadKey: 'unit-test' };

describe('bash', () => {
  test('describe()', () => {
    expect(bash.describe?.({ command: 'ls -la' })).toBe('$ ls -la');
    expect(bash.describe?.({})).toBe('$ (missing command)');
  });

  test('error: missing command', async () => {
    const r = await invokeTool('bash', '{}', CTX);
    expect(r.error).toBe(true);
    expect(r.content).toMatch(/missing or invalid command/);
  });

  test('error: invalid JSON args', async () => {
    const r = await invokeTool('bash', '{not json', CTX);
    expect(r.error).toBe(true);
    expect(r.content).toMatch(/invalid JSON/);
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
