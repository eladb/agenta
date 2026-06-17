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
  [agent, tester] = await Promise.all([startBotAndTenant(), startTester()]);
}, 120_000);

afterAll(async () => {
  for (const ts of createdThreads) {
    await deleteThread(tester, agent, channel, ts);
  }
  await safeShutdown(agent, tester);
  cleanupTempDataDir();
}, 120_000);

// The session state machine (session.ts:startOrQueue) is shared by every turn.
// A mention that arrives while a turn is running must NOT start a concurrent
// turn — it flips the session's `pending` flag and is picked up as a single
// follow-up turn after the current one finishes. We gate the model mid-flight
// to hold turn 1 open, fire a second mention, and assert exactly two model
// turns ran (not three) with the second message folded into the follow-up.
test('mention during a running turn is batched into a single follow-up turn', async () => {
  agent.mock.reset();
  // Two scripted replies — turn 1 and the batched follow-up turn 2. Selection
  // keys off conversation progress, so turn 1 (no prior assistant) → reply-one,
  // turn 2 (one prior assistant) → reply-two.
  agent.mock.setTurns([{ text: 'reply-one' }, { text: 'reply-two' }]);
  // Hold turn 1's model call open so the second mention lands mid-turn.
  const gate = agent.mock.gateNextTurn();

  const threadTs = await mention(tester, agent.botUserId, channel, undefined, 'first message');
  createdThreads.push(threadTs);

  // Turn 1 has reached the (gated) model.
  await waitFor(() => agent.mock.requests.length === 1, {
    what: 'turn 1 reached the model',
    timeoutMs: 60_000,
  });

  // Second mention while turn 1 is gated — must queue, not start a new turn.
  await mention(tester, agent.botUserId, channel, threadTs, 'second message');
  await new Promise((r) => setTimeout(r, 1_500));
  expect(agent.mock.requests.length).toBe(1);

  // Release turn 1 → its reply is recorded → the loop runs the batched turn 2.
  gate.release();

  await waitFor(() => agent.mock.requests.length === 2, {
    what: 'batched follow-up turn 2 reached the model',
    timeoutMs: 60_000,
  });

  // The follow-up turn carries the second message (the new input batched after
  // turn 1). Exactly two model turns ran — the second mention did not spawn a
  // concurrent third turn.
  const turn2 = JSON.stringify(agent.mock.requests[1]);
  expect(turn2).toContain('second message');

  await waitForReply(tester, channel, threadTs, agent.botUserId, (t) => t.includes('reply-two'), {
    timeoutMs: 120_000,
  });
}, 180_000);
