import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { appendFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newEventId, nowIso } from '../persistence/events';
import { ensureThreadDir, messagesPath } from '../persistence/store';
import { _resetCacheForTests } from './home-config';
import { recoverInterruptedSessions } from './recovery';
import { readSession, writeSession } from './session-store';
import { threadKey } from './thread';

let dataDir: string;
let homeDir: string;
let homesConfigPath: string;

const BOT_USER = 'U0BOT';

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'agenta-recovery-'));
  homeDir = mkdtempSync(join(tmpdir(), 'agenta-recovery-home-'));
  writeFileSync(join(homeDir, 'README.md'), '# test home');
  homesConfigPath = join(homeDir, 'homes.json');
  writeFileSync(
    homesConfigPath,
    JSON.stringify({ default: { remote: `file://${homeDir}` }, channels: {} }),
  );
  process.env.AGENTA_DATA_DIR = dataDir;
  process.env.AGENT_HOMES_CONFIG = homesConfigPath;
  process.env.AGENT_HOME_DIR = homeDir;
  _resetCacheForTests();
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
  delete process.env.AGENTA_DATA_DIR;
  delete process.env.AGENT_HOMES_CONFIG;
  delete process.env.AGENT_HOME_DIR;
  _resetCacheForTests();
});

function makeWebStub(): {
  // biome-ignore lint/suspicious/noExplicitAny: stub mimics WebClient surface used by recovery
  web: any;
  posts: Array<{ channel: string; thread_ts?: string; text: string }>;
} {
  const posts: Array<{ channel: string; thread_ts?: string; text: string }> = [];
  const web = {
    chat: {
      postMessage: mock(async (args: { channel: string; thread_ts?: string; text: string }) => {
        posts.push(args);
        return { ok: true, ts: `t${posts.length}` };
      }),
      update: mock(async () => ({ ok: true })),
      delete: mock(async () => ({ ok: true })),
    },
    users: {
      info: mock(async () => ({
        ok: true,
        user: { real_name: 'Test', profile: { email: 'test@example.com' } },
      })),
    },
    reactions: {
      add: mock(async () => ({ ok: true })),
      remove: mock(async () => ({ ok: true })),
    },
  };
  return { web, posts };
}

// biome-ignore lint/suspicious/noExplicitAny: test event shape
async function appendEv(tk: string, ev: any): Promise<void> {
  ensureThreadDir(tk);
  await appendFile(messagesPath(tk), `${JSON.stringify(ev)}\n`);
}

function slackMsg(tk: string, user: string, text: string) {
  return {
    event_id: newEventId(),
    thread_key: tk,
    source: 'slack' as const,
    type: 'message' as const,
    ts: nowIso(),
    ingested_at: nowIso(),
    payload: { slack_ts: '1.0', user, text },
  };
}

function assistantMsg(tk: string, text: string) {
  return {
    event_id: newEventId(),
    thread_key: tk,
    source: 'assistant' as const,
    type: 'message' as const,
    ts: nowIso(),
    ingested_at: nowIso(),
    payload: { slack_ts: '1.0', text },
  };
}

describe('recoverInterruptedSessions', () => {
  test('running session auto-retries (no restart notice posted)', async () => {
    const tk = threadKey('C123', '1700000000.000100');
    await writeSession(tk, { status: 'running', updated_at: 't' });
    await appendEv(tk, slackMsg(tk, 'U1', `<@${BOT_USER}> do something`));

    const { web, posts } = makeWebStub();
    let kickedOff = 0;
    const callModelOverride = mock(async () => {
      kickedOff++;
      return { content: 'ok', tool_calls: undefined };
    });
    await recoverInterruptedSessions({
      web,
      botUserId: BOT_USER,
      fallbackModel: { name: 'm', base_url: 'http://x', api_key_env: 'NOPE' },
      // biome-ignore lint/suspicious/noExplicitAny: stub
      callModelOverride: callModelOverride as any,
    });

    expect(kickedOff).toBeGreaterThanOrEqual(1);
    // No "agent restarted" notice — just the model's reply
    expect(posts.every((p) => !p.text.includes('restarted'))).toBe(true);
  });

  test('stopping session is cleared silently without retry', async () => {
    const tk = threadKey('C456', '1700000001.000200');
    await writeSession(tk, { status: 'stopping', updated_at: 't' });
    await appendEv(tk, slackMsg(tk, 'U1', `<@${BOT_USER}> hi`));

    const { web, posts } = makeWebStub();
    let kickedOff = 0;
    const callModelOverride = mock(async () => {
      kickedOff++;
      return { content: 'ok', tool_calls: undefined };
    });
    await recoverInterruptedSessions({
      web,
      botUserId: BOT_USER,
      fallbackModel: undefined,
      // biome-ignore lint/suspicious/noExplicitAny: stub
      callModelOverride: callModelOverride as any,
    });

    expect(kickedOff).toBe(0);
    expect(posts.every((p) => !p.text.includes('restarted'))).toBe(true);
    expect((await readSession(tk))?.status).toBe('idle');
  });

  test('no-op when there are no interrupted sessions', async () => {
    const { web, posts } = makeWebStub();
    await recoverInterruptedSessions({ web, botUserId: BOT_USER, fallbackModel: undefined });
    expect(posts).toEqual([]);
  });

  test('idle entries do not trigger recovery', async () => {
    const tk = threadKey('C9', '1700000099.000100');
    await writeSession(tk, { status: 'idle', updated_at: 't' });
    const { web, posts } = makeWebStub();
    await recoverInterruptedSessions({ web, botUserId: BOT_USER, fallbackModel: undefined });
    expect(posts).toEqual([]);
    expect((await readSession(tk))?.status).toBe('idle');
  });

  test('flips entries with undecodable threadKey to idle without posting', async () => {
    await writeSession('no-separator', { status: 'running', updated_at: 't' });
    const { web, posts } = makeWebStub();
    await recoverInterruptedSessions({ web, botUserId: BOT_USER, fallbackModel: undefined });
    expect(posts).toEqual([]);
    expect((await readSession('no-separator'))?.status).toBe('idle');
  });

  test('running + no JSONL still retries (buildMessages handles empty JSONL)', async () => {
    const tk = threadKey('C77', '1700000077.000102');
    await writeSession(tk, { status: 'running', updated_at: 't' });

    const { web } = makeWebStub();
    let kickedOff = 0;
    const callModelOverride = mock(async () => {
      kickedOff++;
      return { content: 'ok', tool_calls: undefined };
    });
    await recoverInterruptedSessions({
      web,
      botUserId: BOT_USER,
      fallbackModel: { name: 'm', base_url: 'http://x', api_key_env: 'NOPE' },
      // biome-ignore lint/suspicious/noExplicitAny: stub
      callModelOverride: callModelOverride as any,
    });
    expect(kickedOff).toBeGreaterThanOrEqual(1);
  });

  test('kickoffTurn failure does not abort recovery of other threads', async () => {
    const tk1 = threadKey('C1', '1700000000.000100');
    const tk2 = threadKey('C2', '1700000001.000200');
    await writeSession(tk1, { status: 'running', updated_at: 't' });
    await writeSession(tk2, { status: 'running', updated_at: 't' });
    await appendEv(tk1, slackMsg(tk1, 'U1', `<@${BOT_USER}> hi`));
    await appendEv(tk2, slackMsg(tk2, 'U2', `<@${BOT_USER}> hi`));

    let calls = 0;
    const callModelOverride = mock(async () => {
      calls++;
      if (calls === 1) throw new Error('boom');
      return { content: 'ok', tool_calls: undefined };
    });
    const { web } = makeWebStub();
    await recoverInterruptedSessions({
      web,
      botUserId: BOT_USER,
      fallbackModel: { name: 'm', base_url: 'http://x', api_key_env: 'NOPE' },
      // biome-ignore lint/suspicious/noExplicitAny: stub
      callModelOverride: callModelOverride as any,
    });
    expect(calls).toBe(2);
    expect((await readSession(tk1))?.status).toBe('idle');
  });
});
