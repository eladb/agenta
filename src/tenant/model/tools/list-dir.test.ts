import { describe, expect, test } from 'bun:test';
import { listDirTool } from './list-dir';

describe('list_dir', () => {
  test('describe()', () => {
    expect(listDirTool.describe?.({ path: 'src' })).toBe('list src');
    expect(listDirTool.describe?.({})).toBe('list ~');
  });
});
