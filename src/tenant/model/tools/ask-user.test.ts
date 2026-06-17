import { afterEach, describe, expect, test } from 'bun:test';
import { _resetAsks } from '../../runtime/asks';
import { invokeTool } from './index';

const CTX = { threadKey: 'unit-test' };

afterEach(() => {
  _resetAsks();
});

describe('ask_user', () => {
  test('error: missing question', async () => {
    const r = await invokeTool('ask_user', JSON.stringify({ kind: 'buttons' }), CTX);
    expect(r.error).toBe(true);
    expect(r.content).toMatch(/missing or invalid question/);
  });

  test('error: invalid kind', async () => {
    const r = await invokeTool(
      'ask_user',
      JSON.stringify({ question: 'q', kind: 'whatever' }),
      CTX,
    );
    expect(r.error).toBe(true);
    expect(r.content).toMatch(/kind must be/);
  });

  test('error: buttons without options', async () => {
    const r = await invokeTool('ask_user', JSON.stringify({ question: 'q', kind: 'buttons' }), CTX);
    expect(r.error).toBe(true);
    expect(r.content).toMatch(/requires a non-empty options array/);
  });

  test('error: Slack context unavailable (no web/channel/threadTs)', async () => {
    const r = await invokeTool(
      'ask_user',
      JSON.stringify({ question: 'q', kind: 'buttons', options: ['a', 'b'] }),
      CTX,
    );
    expect(r.error).toBe(true);
    expect(r.content).toMatch(/Slack context unavailable/);
  });
});
