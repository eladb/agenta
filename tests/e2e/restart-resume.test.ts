import { afterAll, beforeAll, expect, test } from 'bun:test';
import { appendFileSync } from 'node:fs';
import { newEventId, nowIso } from '../../src/tenant/persistence/events';
import { messagesPath } from '../../src/tenant/persistence/store';
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
  startAgent,
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

test('boot recovery resumes a turn for a queued mention with status=running', async () => {
  // 1. Boot the agent first. Socket Mode is connected before we post
  //    anything, so we don't trip the Socket Mode replay window (#165):
  //    when the parent message lands, the agent sees it live and processes
  //    it as a real turn, leaving an assistant `message` event in JSONL.
  agent = await startAgent(stubCallModel);

  // 2. Tester posts a real mention. The agent picks it up, runs a turn,
  //    and stub-replies with `stub: <@BOTUSERID> restart-resume parent`.
  const threadTs = await mention(
    tester,
    agent.botUserId,
    channel,
    undefined,
    'restart-resume parent',
  );
  createdThreads.push(threadTs);

  // 3. Wait for the parent's stub reply — once that arrives, JSONL has
  //    [parent-mention, assistant-reply] and the assistant event is the
  //    boundary recovery's findPendingMention will look past.
  await waitForReply(tester, channel, threadTs, agent.botUserId, (t) =>
    t.startsWith(STUB_REPLY_PREFIX),
  );

  const tk = makeThreadKey(channel, threadTs);

  // 4. Simulate the bot dying mid-turn on a queued mention: flip
  //    session.json back to status='running' while preserving every other
  //    field the prior turn populated (system_prompt, sandbox, git, home,
  //    model, display — see session-preservation-invariant memory / #135).
  const existing = await readSession(tk);
  if (!existing) throw new Error('expected session.json after parent turn');
  await writeSession(tk, {
    ...existing,
    status: 'running',
    updated_at: nowIso(),
  });

  // 5. Append a queued mention into JSONL — this is the event recovery
  //    should re-kick a turn for.
  const uniq = `resume-${Date.now()}`;
  const ev = {
    event_id: newEventId(),
    thread_key: tk,
    source: 'slack',
    type: 'message',
    ts: nowIso(),
    ingested_at: nowIso(),
    payload: {
      slack_ts: `${Date.now() / 1000}`,
      user: tester.botUserId,
      text: `<@${agent.botUserId}> ${uniq}`,
    },
  };
  appendFileSync(messagesPath(tk), `${JSON.stringify(ev)}\n`);

  // 6. Run recovery explicitly (production calls this from src/index.ts on
  //    boot; the test harness's startAgent only wires the listener).
  await recoverInterruptedSessions({
    web: agent.web,
    botUserId: agent.botUserId,
    fallbackModel: {
      name: 'stub-model',
      base_url: 'http://stub.invalid',
      api_key_env: 'AGENTA_TEST_STUB_KEY',
    },
    callModelOverride: stubCallModel,
  });

  // 7. Assert: the resumed turn's stub reply contains the queued
  //    mention's unique text. No "agent restarted" notice is posted
  //    (auto-retry is transparent to the user since #201).
  const replyText = await waitForReply(
    tester,
    channel,
    threadTs,
    agent.botUserId,
    (t) => t.startsWith(STUB_REPLY_PREFIX) && t.includes(uniq),
  );
  expect(replyText).toContain(uniq);
});
