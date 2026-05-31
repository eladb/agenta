import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  type Agent,
  cleanupTempDataDir,
  deleteThread,
  mention,
  requireEnv,
  STUB_REPLY_PREFIX,
  safeShutdown,
  setupTempDataDir,
  startAgent,
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
  [agent, tester] = await Promise.all([startAgent(), startTester()]);
}, 120_000);

afterAll(async () => {
  for (const ts of createdThreads) {
    await deleteThread(tester, agent, channel, ts);
  }
  await safeShutdown(agent, tester);
  cleanupTempDataDir();
}, 120_000);

test('mention without command -> bot replies via the model gateway (stub)', async () => {
  const unique = `e2e-echo-${Date.now()}`;
  const threadTs = await mention(tester, agent.botUserId, channel, undefined, unique);
  createdThreads.push(threadTs);

  const text = await waitForReply(tester, channel, threadTs, agent.botUserId, (t) =>
    t.startsWith(STUB_REPLY_PREFIX),
  );

  expect(text).toBe(`${STUB_REPLY_PREFIX}${unique}`);
});
