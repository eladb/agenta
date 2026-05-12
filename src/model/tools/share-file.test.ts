import { describe, expect, test } from 'bun:test';
import { invokeTool } from './index';
import { shareFile } from './share-file';

const CTX = { threadKey: 'unit-test' };

describe('share_file', () => {
  test('describe()', () => {
    expect(shareFile.describe?.({ path: 'chart.png' })).toBe('share chart.png');
    expect(shareFile.describe?.({})).toBe('share ?');
  });

  test('error: missing path', async () => {
    const r = await invokeTool('share_file', '{}', CTX);
    expect(r.error).toBe(true);
    expect(r.content).toMatch(/missing or invalid path/);
  });

  test('error: Slack context unavailable', async () => {
    const r = await invokeTool('share_file', JSON.stringify({ path: 'x.png' }), CTX);
    expect(r.error).toBe(true);
    expect(r.content).toMatch(/Slack context unavailable/);
  });
});
