import { afterAll, beforeAll, expect, test } from 'bun:test';
import { nowIso } from '../../src/tenant/persistence/events';
import { recoverInterruptedSessions } from '../../src/tenant/runtime/recovery';
import { readSession, writeSession } from '../../src/tenant/runtime/session-store';
import { threadKey as makeThreadKey } from '../../src/tenant/runtime/thread';
import {
  type Agent,
  cleanupTempDataDir,
  deleteThread,
  mention,
  requireEnv,
  STUB_REPLY_PREFIX,
  setupTempDataDir,
  shutdown,
  startBotAndTenant,
  startTester,
  stubCallModel,
  type Tester,
  waitForReply,
} from './helpers';

let agent: Agent;
let tester: Tester;
let channel: string;
const createdThreads: string[] = [];

beforeAll(async () => {
  setupTempDataDir();
  channel = requireEnv('TEST_CHANNEL_ID');
  tester = await startTester();
});

afterAll(async () => {
  for (const ts of createdThreads) {
    if (agent) await deleteThread(tester, agent, channel, ts);
  }
  if (agent) await shutdown(agent, tester);
  else await tester.socket.disconnect();
  cleanupTempDataDir();
});

// Boot recovery is silent under #253: a 'running' session left behind by a
// crashed turn is cleared to 'idle' without auto-retry and without posting
// any Slack notice. The user's next mention re-triggers work fresh.
test('boot recovery silently clears interrupted sessions to idle', async () => {
  agent = await startBotAndTenant(stubCallModel);

  // Run one real mention so a session.json exists with all the fields a
  // prior turn would populate (sandbox/git/home/model/display — see
  // session-preservation-invariant memory / #135).
  const threadTs = await mention(
    tester,
    agent.botUserId,
    channel,
    undefined,
    'restart-resume parent',
  );
  createdThreads.push(threadTs);
  await waitForReply(tester, channel, threadTs, agent.botUserId, (t) =>
    t.startsWith(STUB_REPLY_PREFIX),
  );

  const tk = makeThreadKey(channel, threadTs);

  // Simulate a crash mid-turn: flip session.json back to status='running'
  // while preserving every other field.
  const existing = await readSession(tk);
  if (!existing) throw new Error('expected session.json after parent turn');
  await writeSession(tk, {
    ...existing,
    status: 'running',
    updated_at: nowIso(),
  });

  // Recovery should silently reconcile state — no Slack call, no model call.
  await recoverInterruptedSessions();

  const after = await readSession(tk);
  expect(after?.status).toBe('idle');
});
