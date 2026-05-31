import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { threadKey } from '../../src/tenant/runtime/thread';
import {
  type Agent,
  cleanupTempDataDir,
  deleteThread,
  getDataDir,
  mention,
  requireEnv,
  STUB_REPLY_PREFIX,
  safeShutdown,
  setupTempDataDir,
  startAgent,
  startTester,
  type Tester,
  waitFor,
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

type Event = {
  source: string;
  type: string;
  payload: { slack_ts: string; text?: string; new_text?: string };
};

function readEvents(threadTs: string): Event[] {
  const file = join(getDataDir(), threadKey(channel, threadTs), 'messages.jsonl');
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Event);
}

async function createThread(seed: string): Promise<string> {
  const threadTs = await mention(tester, agent.botUserId, channel, undefined, seed);
  createdThreads.push(threadTs);
  await waitForReply(tester, channel, threadTs, agent.botUserId, (t) =>
    t.startsWith(STUB_REPLY_PREFIX),
  );
  return threadTs;
}

test('edit of a non-mention thread reply is recorded as a slack edit event', async () => {
  const threadTs = await createThread(`e2e-edit-${Date.now()}`);

  const originalText = 'first version';
  const res = await tester.web.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: originalText,
  });
  if (!res.ts) throw new Error('post returned no ts');
  const replyTs = res.ts;

  await waitFor(
    () =>
      readEvents(threadTs).some(
        (e) =>
          e.source === 'slack' &&
          e.type === 'message' &&
          e.payload.slack_ts === replyTs &&
          e.payload.text === originalText,
      ),
    { what: 'initial reply ingested' },
  );

  const newText = 'edited version';
  await tester.web.chat.update({ channel, ts: replyTs, text: newText });

  await waitFor(
    () =>
      readEvents(threadTs).some(
        (e) =>
          e.source === 'slack' &&
          e.type === 'edit' &&
          e.payload.slack_ts === replyTs &&
          e.payload.new_text === newText,
      ),
    { what: 'edit event recorded' },
  );

  const events = readEvents(threadTs);
  const msgIdx = events.findIndex((e) => e.type === 'message' && e.payload.slack_ts === replyTs);
  const editIdx = events.findIndex((e) => e.type === 'edit' && e.payload.slack_ts === replyTs);
  expect(msgIdx).toBeGreaterThanOrEqual(0);
  expect(editIdx).toBeGreaterThan(msgIdx);
});

test('delete of a non-mention thread reply is recorded as a slack delete event', async () => {
  const threadTs = await createThread(`e2e-delete-${Date.now()}`);

  const res = await tester.web.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: 'will be deleted',
  });
  if (!res.ts) throw new Error('post returned no ts');
  const replyTs = res.ts;

  await waitFor(
    () =>
      readEvents(threadTs).some(
        (e) => e.source === 'slack' && e.type === 'message' && e.payload.slack_ts === replyTs,
      ),
    { what: 'reply ingested' },
  );

  await tester.web.chat.delete({ channel, ts: replyTs });

  await waitFor(
    () =>
      readEvents(threadTs).some(
        (e) => e.source === 'slack' && e.type === 'delete' && e.payload.slack_ts === replyTs,
      ),
    { what: 'delete event recorded' },
  );

  // event stream preserves the original message + delete, in order
  const events = readEvents(threadTs);
  const msgIdx = events.findIndex((e) => e.type === 'message' && e.payload.slack_ts === replyTs);
  const delIdx = events.findIndex((e) => e.type === 'delete' && e.payload.slack_ts === replyTs);
  expect(msgIdx).toBeGreaterThanOrEqual(0);
  expect(delIdx).toBeGreaterThan(msgIdx);
});
