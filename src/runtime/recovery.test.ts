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
  // Minimal README so buildSystemPrompt has something to compose.
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
    },
    users: {
      info: mock(async () => ({
        ok: true,
        user: { real_name: 'Test', profile: { email: 'test@example.com' } },
      })),
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
  test('posts a notice for each non-idle session.json then flips it to idle', async () => {
    const tk1 = threadKey('C123', '1700000000.000100');
    const tk2 = threadKey('C456', '1700000001.000200');
    await writeSession(tk1, { status: 'running', updated_at: 't', system_prompt: 'sp1' });
    await writeSession(tk2, { status: 'stopping', updated_at: 't', system_prompt: 'sp2' });

    const { web, posts } = makeWebStub();
    await recoverInterruptedSessions({ web, botUserId: BOT_USER, fallbackModel: undefined });

    expect(posts).toHaveLength(2);
    const byChannel = Object.fromEntries(posts.map((p) => [p.channel, p]));
    expect(byChannel.C123?.thread_ts).toBe('1700000000.000100');
    expect(byChannel.C123?.text).toMatch(/restarted/);
    expect(byChannel.C123?.text).toMatch(/running/);
    expect(byChannel.C456?.text).toMatch(/stopping/);

    // After clearing the entry transitions to idle with system_prompt
    // preserved. The next mention picks the prompt back up.
    const after1 = await readSession(tk1);
    const after2 = await readSession(tk2);
    expect(after1?.status).toBe('idle');
    expect(after1?.system_prompt).toBe('sp1');
    expect(after2?.status).toBe('idle');
    expect(after2?.system_prompt).toBe('sp2');
  });

  test('no-op when there are no interrupted sessions', async () => {
    const { web, posts } = makeWebStub();
    await recoverInterruptedSessions({ web, botUserId: BOT_USER, fallbackModel: undefined });
    expect(posts).toEqual([]);
  });

  test('idle entries do not trigger boot announcements', async () => {
    const tk = threadKey('C9', '1700000099.000100');
    await writeSession(tk, { status: 'idle', updated_at: 't', system_prompt: 'sp' });
    const { web, posts } = makeWebStub();
    await recoverInterruptedSessions({ web, botUserId: BOT_USER, fallbackModel: undefined });
    expect(posts).toEqual([]);
    expect((await readSession(tk))?.status).toBe('idle');
  });

  test('Slack post failure does not abort recovery of other threads', async () => {
    const tk1 = threadKey('C1', '1700000000.000100');
    const tk2 = threadKey('C2', '1700000001.000200');
    await writeSession(tk1, { status: 'running', updated_at: 't' });
    await writeSession(tk2, { status: 'running', updated_at: 't' });

    let calls = 0;
    const web = {
      chat: {
        postMessage: mock(async (args: { channel: string }) => {
          calls++;
          if (args.channel === 'C1') throw new Error('channel_not_found');
          return { ok: true, ts: 'ok' };
        }),
      },
    };
    await recoverInterruptedSessions({
      // biome-ignore lint/suspicious/noExplicitAny: stub
      web: web as any,
      botUserId: BOT_USER,
      fallbackModel: undefined,
    });
    expect(calls).toBe(2);
    expect((await readSession(tk1))?.status).toBe('idle');
    expect((await readSession(tk2))?.status).toBe('idle');
  });

  test('flips entries with undecodable threadKey to idle without posting', async () => {
    await writeSession('no-separator', { status: 'running', updated_at: 't' });
    const { web, posts } = makeWebStub();
    await recoverInterruptedSessions({ web, botUserId: BOT_USER, fallbackModel: undefined });
    expect(posts).toEqual([]);
    expect((await readSession('no-separator'))?.status).toBe('idle');
  });

  test('running + slack mention after last assistant msg → resume fires', async () => {
    const tk = threadKey('C77', '1700000077.000100');
    await writeSession(tk, { status: 'running', updated_at: 't' });
    await appendEv(tk, slackMsg(tk, 'U1', `<@${BOT_USER}> hi`));
    await appendEv(tk, assistantMsg(tk, 'reply'));
    // This is the unanswered mention:
    await appendEv(tk, slackMsg(tk, 'U2', `<@${BOT_USER}> follow up`));

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

    // Restart notice posted.
    expect(posts[0]?.text).toMatch(/restarted/);
    // And the model was invoked for the resumed turn (could be one or more
    // iterations; we just want >=1).
    expect(kickedOff).toBeGreaterThanOrEqual(1);
  });

  test('running + JSONL has only non-mention slack msg → just clears, no resume', async () => {
    const tk = threadKey('C77', '1700000077.000101');
    await writeSession(tk, { status: 'running', updated_at: 't' });
    await appendEv(tk, slackMsg(tk, 'U1', `<@${BOT_USER}> hi`));
    await appendEv(tk, assistantMsg(tk, 'reply'));
    await appendEv(tk, slackMsg(tk, 'U2', 'just talking, not a mention'));

    const { web } = makeWebStub();
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
    expect((await readSession(tk))?.status).toBe('idle');
  });

  test('running + no JSONL → just clears, no resume', async () => {
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
      fallbackModel: undefined,
      // biome-ignore lint/suspicious/noExplicitAny: stub
      callModelOverride: callModelOverride as any,
    });
    expect(kickedOff).toBe(0);
    expect((await readSession(tk))?.status).toBe('idle');
  });

  test('stopping + pending mention → resume fires', async () => {
    const tk = threadKey('C78', '1700000078.000100');
    await writeSession(tk, { status: 'stopping', updated_at: 't' });
    // No prior assistant message — every slack mention from file-start
    // counts as pending.
    await appendEv(tk, slackMsg(tk, 'U2', `<@${BOT_USER}> ping`));

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

  test('unparseable JSONL line does not abort the loop', async () => {
    const tk1 = threadKey('C90', '1700000090.000100');
    const tk2 = threadKey('C91', '1700000091.000100');
    await writeSession(tk1, { status: 'running', updated_at: 't' });
    await writeSession(tk2, { status: 'running', updated_at: 't' });
    // Write garbage JSONL for tk1.
    ensureThreadDir(tk1);
    await writeFile(messagesPath(tk1), '{not valid json\n');

    const { web, posts } = makeWebStub();
    await recoverInterruptedSessions({ web, botUserId: BOT_USER, fallbackModel: undefined });
    // Both threads got notices posted; both are now idle.
    expect(posts.length).toBe(2);
    expect((await readSession(tk1))?.status).toBe('idle');
    expect((await readSession(tk2))?.status).toBe('idle');
  });
});
