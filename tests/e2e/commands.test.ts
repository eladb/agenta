import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  type Agent,
  cleanupTempDataDir,
  deleteThread,
  mention,
  requireEnv,
  safeShutdown,
  setupTempDataDir,
  startBotAndTenant,
  startTester,
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
  [agent, tester] = await Promise.all([startBotAndTenant(), startTester()]);
}, 120_000);

afterAll(async () => {
  for (const ts of createdThreads) {
    await deleteThread(tester, agent, channel, ts);
  }
  await safeShutdown(agent, tester);
  cleanupTempDataDir();
}, 120_000);

test('/stop on idle thread -> bot acks with "stopped"', async () => {
  const threadTs = await mention(tester, agent.botUserId, channel, undefined, '/stop');
  createdThreads.push(threadTs);
  const text = await waitForReply(
    tester,
    channel,
    threadTs,
    agent.botUserId,
    (t) => t === 'stopped',
  );
  expect(text).toBe('stopped');
});

test('/delete -> bot acks with "deleted (stub)"', async () => {
  const threadTs = await mention(tester, agent.botUserId, channel, undefined, '/delete');
  createdThreads.push(threadTs);
  const text = await waitForReply(
    tester,
    channel,
    threadTs,
    agent.botUserId,
    (t) => t === 'deleted (stub)',
  );
  expect(text).toBe('deleted (stub)');
});

test('a non-command message starting with "/" is intercepted by the SDK, not routed to the model', async () => {
  agent.mock.reset();
  agent.mock.setTurns([{ text: 'model-should-not-be-reached' }]);

  const threadTs = await mention(tester, agent.botUserId, channel, undefined, '/stop and please');
  createdThreads.push(threadTs);
  // `/stop and please` is not agenta's exact `/stop` command (parseCommand
  // requires an exact match), so the handler routes it onward as a normal
  // mention. The Claude Agent SDK then parses the leading "/" as a slash command
  // and replies WITHOUT calling the model ("/stop isn't available…") — an
  // accepted SDK-native behavior change from the bespoke harness, which sent
  // leading-"/" text straight to the model. We assert the boundary: the bot
  // replies, but it is neither agenta's `/stop` ack nor the scripted model reply.
  const reply = await waitForReply(
    tester,
    channel,
    threadTs,
    agent.botUserId,
    (t) => t.length > 0,
    {
      timeoutMs: 120_000,
    },
  );
  expect(reply).not.toBe('stopped');
  expect(reply).not.toContain('model-should-not-be-reached');
}, 120_000);
