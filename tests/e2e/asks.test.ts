import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { AssistantMessage, CallModel, Message } from '../../src/tenant/model/gateway';
import { _resetAsks, getPendingAskByThread } from '../../src/tenant/runtime/asks';
import { threadKey } from '../../src/tenant/runtime/thread';
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
  waitFor,
  waitForReply,
} from './helpers';

let agent: Agent;
let tester: Tester;
let channel: string;
const createdThreads: string[] = [];

type Scripted = { kind: 'reply'; message: AssistantMessage };
const script: Scripted[] = [];
const calls: Message[][] = [];

const scriptedCallModel: CallModel = async (messages) => {
  calls.push(messages);
  const next = script.shift();
  if (!next) return { role: 'assistant', content: 'unscripted' };
  return next.message;
};

function scriptReply(message: AssistantMessage): void {
  script.push({ kind: 'reply', message });
}

beforeAll(async () => {
  setupTempDataDir();
  channel = requireEnv('TEST_CHANNEL_ID');
  [agent, tester] = await Promise.all([startBotAndTenant(scriptedCallModel), startTester()]);
}, 120_000);

afterAll(async () => {
  for (const ts of createdThreads) {
    await deleteThread(tester, agent, channel, ts);
  }
  await safeShutdown(agent, tester);
  cleanupTempDataDir();
  _resetAsks();
}, 120_000);

test('ask_user is resolved by a non-mention text reply in the same thread', async () => {
  script.length = 0;
  calls.length = 0;
  _resetAsks();

  // Turn 1: emit an ask_user(buttons) tool_call.
  scriptReply({
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call_ask',
        type: 'function',
        function: {
          name: 'ask_user',
          arguments: JSON.stringify({
            question: 'pick a database',
            kind: 'buttons',
            options: ['postgres', 'mysql', 'sqlite'],
          }),
        },
      },
    ],
  });
  // Turn 2: echo the user's answer.
  scriptReply({ role: 'assistant', content: 'thanks for the answer' });

  const threadTs = await mention(
    tester,
    agent.botUserId,
    channel,
    undefined,
    `e2e-ask-${Date.now()}`,
  );
  createdThreads.push(threadTs);

  const tk = threadKey(channel, threadTs);

  // Wait for the agent to actually register the ask. Until that happens,
  // a text reply could land before the pending entry is in the map and
  // we'd silently miss the override.
  await waitFor(() => getPendingAskByThread(tk) !== undefined, {
    what: 'ask_user registered the pending entry',
    timeoutMs: 30_000,
  });

  // Tester replies in the thread with text — should auto-resolve the ask.
  const reply = await tester.web.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: 'i pick postgres please',
  });
  expect(reply.ok).toBe(true);

  // Bot's final reply lands once the second model call returns.
  await waitForReply(
    tester,
    channel,
    threadTs,
    agent.botUserId,
    (t) => t === 'thanks for the answer',
    { timeoutMs: 30_000 },
  );
  await waitFor(() => calls.length === 2, { what: 'two model calls', timeoutMs: 30_000 });

  // Second model call's tool_result for call_ask should be the typed text.
  const second = calls[1];
  if (!second) throw new Error('expected second model call');
  const toolMsg = second.find((m) => m.role === 'tool' && m.tool_call_id === 'call_ask');
  if (toolMsg?.role !== 'tool') throw new Error('expected tool message');
  expect(toolMsg.content).toBe('i pick postgres please');

  // The pending ask entry is gone (consumed).
  expect(getPendingAskByThread(tk)).toBeUndefined();
}, 60_000);
