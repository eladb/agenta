import { afterAll, beforeAll, expect, test } from 'bun:test';
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
});

afterAll(async () => {
  for (const ts of createdThreads) {
    await deleteThread(tester, agent, channel, ts);
  }
  await shutdown(agent, tester);
  cleanupTempDataDir();
});

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

test('/stop with extra text -> treated as normal mention (routed to model)', async () => {
  const threadTs = await mention(tester, agent.botUserId, channel, undefined, '/stop and please');
  createdThreads.push(threadTs);
  const text = await waitForReply(tester, channel, threadTs, agent.botUserId, (t) =>
    t.startsWith(STUB_REPLY_PREFIX),
  );
  expect(text).toBe(`${STUB_REPLY_PREFIX}/stop and please`);
});
