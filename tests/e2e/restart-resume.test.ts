import { afterAll, beforeAll, expect, test } from 'bun:test';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newEventId, nowIso } from '../../src/persistence/events';
import { ensureThreadDir, messagesPath, threadDir } from '../../src/persistence/store';
import { recoverInterruptedSessions } from '../../src/runtime/recovery';
import { threadKey as makeThreadKey } from '../../src/runtime/thread';
import {
  type Agent,
  cleanupTempDataDir,
  deleteThread,
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
  // 1. Seed the parent message in a real Slack thread (so the thread
  //    exists on Slack's side and we can poll replies). Use the tester
  //    bot's tokens directly — the agent isn't running yet.
  const parent = await tester.web.chat.postMessage({
    channel,
    text: 'restart-resume parent',
  });
  if (!parent.ts) throw new Error('no parent ts');
  const threadTs = parent.ts;
  createdThreads.push(threadTs);

  const uniq = `resume-${Date.now()}`;

  // 2. Simulate "bot died mid-turn with queued mention":
  //    - session.json: status='running'
  //    - JSONL: a slack message event whose text contains the bot mention
  //
  //    Discover the agent's bot user id without starting Socket Mode by
  //    resolving from auth.test using just the bot token (the helper for
  //    that lives inside connect(); we replicate the minimum).
  const { WebClient } = await import('@slack/web-api');
  const probe = new WebClient(requireEnv('SLACK_BOT_TOKEN'));
  const auth = await probe.auth.test();
  const botUserId = auth.user_id;
  if (!botUserId) throw new Error('could not resolve agent bot user id');

  const tk = makeThreadKey(channel, threadTs);
  ensureThreadDir(tk);

  // Write a session.json with status: running and the frozen prompt.
  const sessionPath = join(threadDir(tk), 'session.json');
  writeFileSync(
    sessionPath,
    JSON.stringify({
      status: 'running',
      updated_at: nowIso(),
      system_prompt: 'you are a test agent',
    }),
  );

  // Append a slack mention event into JSONL.
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
      text: `<@${botUserId}> ${uniq}`,
    },
  };
  appendFileSync(messagesPath(tk), `${JSON.stringify(ev)}\n`);

  // 3. Boot the agent (registers event handler + acquires socket). Then
  //    explicitly invoke recoverInterruptedSessions — production runs
  //    this from src/index.ts at boot, but the test harness's
  //    `startAgent` only wires up the listener. Passing the same stub
  //    call_model so the resumed turn echoes through STUB_REPLY_PREFIX.
  agent = await startAgent();
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

  // 4. Assert the bot posted both the restart notice and a reply to the
  //    queued mention.
  await waitForReply(tester, channel, threadTs, agent.botUserId, (t) => /restarted/i.test(t));
  const replyText = await waitForReply(tester, channel, threadTs, agent.botUserId, (t) =>
    t.startsWith(STUB_REPLY_PREFIX),
  );
  expect(replyText).toContain(uniq);
});
