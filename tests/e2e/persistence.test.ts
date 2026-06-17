import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { threadKey } from '../../src/tenant/runtime/thread';
import {
  type Agent,
  cleanupTempDataDir,
  deleteThread,
  getDataDir,
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

function readJsonl(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

test('mention persists the inbound slack message + the assistant reply', async () => {
  agent.mock.reset();
  agent.mock.setTurns([{ text: 'recorded reply' }]);

  const unique = `e2e-persist-${Date.now()}`;
  const threadTs = await mention(tester, agent.botUserId, channel, undefined, unique);
  createdThreads.push(threadTs);

  await waitForReply(tester, channel, threadTs, agent.botUserId, (t) =>
    t.includes('recorded reply'),
  );
  await new Promise((r) => setTimeout(r, 300));

  const tk = threadKey(channel, threadTs);
  const file = join(getDataDir(), tk, 'messages.jsonl');
  const events = readJsonl(file) as Array<{
    source: string;
    type: string;
    payload: { user?: string; text?: string; slack_ts?: string };
  }>;

  // The inbound mention is recorded as a slack message event verbatim.
  const incoming = events.find((e) => e.source === 'slack' && e.type === 'message');
  expect(incoming).toBeDefined();
  expect(incoming?.payload.user).toBe(tester.botUserId);
  expect(incoming?.payload.text).toBe(unique);
  expect(incoming?.payload.slack_ts).toBe(threadTs);

  // The model's reply is recorded as an assistant message event. (The SDK
  // harness may also record tool_call/tool_result events on tool-using turns;
  // this is a pure text turn, so we just assert the assistant text landed.)
  const reply = events.find(
    (e) =>
      e.source === 'assistant' &&
      e.type === 'message' &&
      (e.payload.text ?? '').includes('recorded reply'),
  );
  expect(reply).toBeDefined();
}, 120_000);

test('/delete removes the thread data directory', async () => {
  const threadTs = await mention(tester, agent.botUserId, channel, undefined, '/delete');
  createdThreads.push(threadTs);

  await waitForReply(tester, channel, threadTs, agent.botUserId, (t) => t === 'deleted (stub)');
  await new Promise((r) => setTimeout(r, 300));

  const tk = threadKey(channel, threadTs);
  const dir = join(getDataDir(), tk);
  expect(existsSync(dir)).toBe(false);
});
