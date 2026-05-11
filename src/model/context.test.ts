import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent } from '../persistence/store';
import { buildMessages } from './context';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agenta-ctx-'));
  process.env.AGENTA_DATA_DIR = dir;
});

afterEach(() => {
  delete process.env.AGENTA_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('buildMessages', () => {
  it('returns just the system prompt for an empty thread', async () => {
    const m = await buildMessages('empty', 'you are a bot');
    expect(m).toEqual([{ role: 'system', content: 'you are a bot' }]);
  });

  it('projects slack/message events as user and assistant/message as assistant, in order', async () => {
    await appendEvent('t', {
      source: 'slack',
      type: 'message',
      payload: { slack_ts: '1', text: 'hello' },
    });
    await appendEvent('t', {
      source: 'assistant',
      type: 'message',
      payload: { slack_ts: '2', text: 'hi there' },
    });
    await appendEvent('t', {
      source: 'slack',
      type: 'message',
      payload: { slack_ts: '3', text: 'who are you' },
    });
    const m = await buildMessages('t', 'sys');
    expect(m).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
      { role: 'user', content: 'who are you' },
    ]);
  });

  it('skips edit and delete events', async () => {
    await appendEvent('t', {
      source: 'slack',
      type: 'message',
      payload: { slack_ts: '1', text: 'hello' },
    });
    await appendEvent('t', {
      source: 'slack',
      type: 'edit',
      payload: { slack_ts: '1', new_text: 'hi' },
    });
    await appendEvent('t', {
      source: 'slack',
      type: 'delete',
      payload: { slack_ts: '1' },
    });
    const m = await buildMessages('t', 'sys');
    expect(m).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
    ]);
  });
});
