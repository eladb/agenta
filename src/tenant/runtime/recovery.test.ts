import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newEventId, nowIso } from '../persistence/events';
import { ensureThreadDir, messagesPath } from '../persistence/store';
import { recoverInterruptedSessions } from './recovery';
import { readSession, writeSession } from './session-store';
import { threadKey } from './thread';

let dataDir: string;
let homeDir: string;

const BOT_USER = 'U0BOT';

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'agenta-recovery-'));
  homeDir = mkdtempSync(join(tmpdir(), 'agenta-recovery-home-'));
  writeFileSync(join(homeDir, 'README.md'), '# test home');
  process.env.AGENTA_DATA_DIR = dataDir;
  // Per-thread home arrives in the envelope under #253; tests seed it via
  // FROZEN_HOME directly into session.json. `AGENT_HOME_DIR` is the prompt
  // builder's test override (untouched by #253).
  process.env.AGENT_HOME_DIR = homeDir;
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
  delete process.env.AGENTA_DATA_DIR;
  delete process.env.AGENT_HOME_DIR;
});

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

describe('recoverInterruptedSessions', () => {
  // Under #253 the bot↔tenant split means recovery has no WebClient at
  // boot (xoxb is request-scoped). Spec trade: drop the boot-time Slack
  // notice AND the auto-retry. Recovery just reconciles state —
  // running/stopping → idle — and the user's next mention starts fresh.
  const FROZEN_HOME = { remote: `file://${tmpdir()}/test-home` };

  test('running session is silently cleared to idle (no retry, no notice)', async () => {
    const tk = threadKey('C123', '1700000000.000100');
    await writeSession(tk, { status: 'running', updated_at: 't', home: FROZEN_HOME });
    await appendEv(tk, slackMsg(tk, 'U1', `<@${BOT_USER}> do something`));

    await recoverInterruptedSessions();

    expect((await readSession(tk))?.status).toBe('idle');
  });

  test('stopping session is cleared silently', async () => {
    const tk = threadKey('C456', '1700000001.000200');
    await writeSession(tk, { status: 'stopping', updated_at: 't' });
    await appendEv(tk, slackMsg(tk, 'U1', `<@${BOT_USER}> hi`));

    await recoverInterruptedSessions();

    expect((await readSession(tk))?.status).toBe('idle');
  });

  test('no-op when there are no interrupted sessions', async () => {
    await recoverInterruptedSessions();
    // Nothing to assert beyond "doesn't throw" — listSessions is empty so
    // there's no state to inspect.
  });

  test('idle entries are left alone', async () => {
    const tk = threadKey('C9', '1700000099.000100');
    await writeSession(tk, { status: 'idle', updated_at: 't' });
    await recoverInterruptedSessions();
    expect((await readSession(tk))?.status).toBe('idle');
  });

  test('clears entries with undecodable threadKey too', async () => {
    // `clearSession` doesn't care about threadKey decodability — it just
    // rewrites session.json in place. Recovery used to special-case this
    // for the retry path; the silent variant treats it uniformly.
    await writeSession('no-separator', { status: 'running', updated_at: 't' });
    await recoverInterruptedSessions();
    expect((await readSession('no-separator'))?.status).toBe('idle');
  });

  test('clears multiple interrupted sessions independently', async () => {
    const tk1 = threadKey('C1', '1700000000.000100');
    const tk2 = threadKey('C2', '1700000001.000200');
    await writeSession(tk1, { status: 'running', updated_at: 't', home: FROZEN_HOME });
    await writeSession(tk2, { status: 'stopping', updated_at: 't' });

    await recoverInterruptedSessions();

    expect((await readSession(tk1))?.status).toBe('idle');
    expect((await readSession(tk2))?.status).toBe('idle');
  });
});
