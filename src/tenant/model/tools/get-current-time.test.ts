import { describe, expect, test } from 'bun:test';
import { invokeTool } from './index';

const CTX = { threadKey: 'unit-test' };

describe('get_current_time', () => {
  test('returns an ISO timestamp', async () => {
    const r = await invokeTool('get_current_time', '{}', CTX);
    expect(r.error).toBe(false);
    expect(r.content).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test('accepts empty args string', async () => {
    const r = await invokeTool('get_current_time', '', CTX);
    expect(r.error).toBe(false);
  });
});
