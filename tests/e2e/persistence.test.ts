import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { threadKey } from '../../src/runtime/thread';
import {
  type Agent,
  cleanupTempDataDir,
  deleteThread,
  getDataDir,
  mention,
  requireEnv,
  STUB_REPLY_PREFIX,
  setupTempDataDir,
  safeShutdown,
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

function readJsonl(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

test('mention persists slack message + assistant message events', async () => {
  const unique = `e2e-persist-${Date.now()}`;
  const threadTs = await mention(tester, agent.botUserId, channel, undefined, unique);
  createdThreads.push(threadTs);

  await waitForReply(tester, channel, threadTs, agent.botUserId, (t) =>
    t.startsWith(STUB_REPLY_PREFIX),
  );
  await new Promise((r) => setTimeout(r, 300));

  const tk = threadKey(channel, threadTs);
  const file = join(getDataDir(), tk, 'messages.jsonl');
  const events = readJsonl(file);

  expect(events.length).toBe(2);

  const [incoming, reply] = events as [
    { source: string; type: string; payload: { user: string; text: string; slack_ts: string } },
    { source: string; type: string; payload: { text: string; slack_ts: string } },
  ];
  expect(incoming.source).toBe('slack');
  expect(incoming.type).toBe('message');
  expect(incoming.payload.user).toBe(tester.botUserId);
  expect(incoming.payload.text).toBe(unique);
  expect(incoming.payload.slack_ts).toBe(threadTs);

  expect(reply.source).toBe('assistant');
  expect(reply.type).toBe('message');
  expect(reply.payload.text).toBe(`${STUB_REPLY_PREFIX}${unique}`);
});

test('/delete removes the thread data directory', async () => {
  const threadTs = await mention(tester, agent.botUserId, channel, undefined, '/delete');
  createdThreads.push(threadTs);

  await waitForReply(tester, channel, threadTs, agent.botUserId, (t) => t === 'deleted (stub)');
  await new Promise((r) => setTimeout(r, 300));

  const tk = threadKey(channel, threadTs);
  const dir = join(getDataDir(), tk);
  expect(existsSync(dir)).toBe(false);
});
