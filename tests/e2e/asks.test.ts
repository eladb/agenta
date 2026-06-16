// Pilot migration to the SDK harness + mock-model (#315 Phase A).
//
// Same product intent as the bespoke version: the model calls ask_user(buttons),
// a non-mention text reply in the thread resolves the pending ask, the typed
// answer is fed back to the model as the tool_result, and the model's final
// text lands in the thread. The only thing that changed is HOW the model side
// is driven — the bespoke `scriptedCallModel`/`script` queue is replaced by the
// mock-model server (`ANTHROPIC_BASE_URL`) scripted with `MockTurn[]`, and the
// "did the answer reach the model" assertion now reads the mock's recorded
// `requests` instead of a `stubCalls`/`Message[]` array. The real product
// behavior (Slack roundtrip, ask registry, final reply text) is asserted the
// same as before.

import { afterAll, beforeAll, expect, test } from 'bun:test';
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
import type { MockTurn } from './mock-model';

let agent: Agent;
let tester: Tester;
let channel: string;
const createdThreads: string[] = [];

beforeAll(async () => {
  setupTempDataDir();
  channel = requireEnv('TEST_CHANNEL_ID');
  // SDK mode: boot the tenant on the Claude Agent SDK harness driven by the
  // mock-model server (returned as `agent.mock`). The callModel arg is unused
  // in SDK mode but still required positionally.
  [agent, tester] = await Promise.all([
    startBotAndTenant(undefined, { harness: 'sdk' }),
    startTester(),
  ]);
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
  _resetAsks();
  const mock = agent.mock;
  if (!mock) throw new Error('expected SDK-mode mock handle');
  mock.reset();

  // Turn 0: model calls ask_user(buttons). Turn 1: echoes the answer back.
  // (Mock picks the turn by conversation progress, so turn 1 fires on the
  // continuation request that carries the ask tool_result.)
  const turns: MockTurn[] = [
    {
      text: 'I need to know which database you prefer.',
      toolUses: [
        {
          id: 'call_ask',
          name: 'mcp__agenta__ask_user',
          input: {
            question: 'pick a database',
            kind: 'buttons',
            options: ['postgres', 'mysql', 'sqlite'],
          },
        },
      ],
    },
    { text: 'thanks for the answer' },
  ];
  mock.setTurns(turns);

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

  // Bot's final reply lands once the continuation turn returns.
  await waitForReply(
    tester,
    channel,
    threadTs,
    agent.botUserId,
    (t) => t.includes('thanks for the answer'),
    { timeoutMs: 60_000 },
  );

  // The pending ask entry is gone (consumed).
  await waitFor(() => getPendingAskByThread(tk) === undefined, {
    what: 'pending ask consumed',
    timeoutMs: 30_000,
  });

  // The typed answer reached the model as the tool_result for call_ask: the
  // mock recorded a continuation request whose messages carry the ask's
  // tool_result content. (In the bespoke version this was the second model
  // call's `tool` message; here it's the recorded request body.) Assert the
  // answer text is present in a request that also references the ask call id.
  const flat = JSON.stringify(mock.requests);
  expect(flat).toContain('i pick postgres please');
  expect(flat).toContain('call_ask');
}, 90_000);
