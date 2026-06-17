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

test('mention without a command -> bot posts the model reply', async () => {
  agent.mock.reset();
  agent.mock.setTurns([{ text: 'pong from the model' }]);

  const threadTs = await mention(
    tester,
    agent.botUserId,
    channel,
    undefined,
    `e2e-echo-${Date.now()}`,
  );
  createdThreads.push(threadTs);

  // The SDK harness appends an AI-generated disclaimer to the reply, so match
  // on a substring rather than exact equality.
  const text = await waitForReply(tester, channel, threadTs, agent.botUserId, (t) =>
    t.includes('pong from the model'),
  );
  expect(text).toContain('pong from the model');
}, 120_000);
