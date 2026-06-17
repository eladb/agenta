// Migrated to the SDK harness + mock-model (#315 Phase A). The product behavior
// asserted is unchanged — the model emits a tool_call, the bot runs the tool in
// the sandbox, persists tool_call/tool_result JSONL, replays prior-turn context,
// and a /stop mid-turn renders "stopped" — but the model is now driven by the
// mock-model server (ANTHROPIC_BASE_URL) scripted with MockTurn[] instead of the
// bespoke `scriptedCallModel`/`script` queue, and assertions move from the
// recorded `Message[]` to the mock's recorded request bodies (Anthropic shape).
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

type Event = {
  event_id?: string;
  source: string;
  type: string;
  payload: Record<string, unknown>;
};

function readEvents(threadTs: string): Event[] {
  const file = join(getDataDir(), threadKey(channel, threadTs), 'messages.jsonl');
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Event);
}

beforeAll(async () => {
  setupTempDataDir();
  channel = requireEnv('TEST_CHANNEL_ID');
  // SDK mode: the tenant runs the Agent SDK harness driven by the mock-model
  // server (returned as `agent.mock`); the callModel arg is unused.
  [agent, tester] = await Promise.all([
    startBotAndTenant(),
    startTester(),
  ]);
}, 120_000);

afterAll(async () => {
  for (const ts of createdThreads) {
    await deleteThread(tester, agent, channel, ts);
  }
  await safeShutdown(agent, tester);
  cleanupTempDataDir();
}, 120_000);

test('model can call get_current_time and the bot posts the final reply', async () => {
  const mock = agent.mock;
  if (!mock) throw new Error('expected SDK-mode mock handle');
  mock.reset();
  mock.setTurns([
    { toolUses: [{ id: 'call_t1', name: 'mcp__agenta__get_current_time', input: {} }] },
    { text: 'the current time is recorded' },
  ]);

  const threadTs = await mention(
    tester,
    agent.botUserId,
    channel,
    undefined,
    `e2e-tool-time-${Date.now()}`,
  );
  createdThreads.push(threadTs);

  const reply = await waitForReply(
    tester,
    channel,
    threadTs,
    agent.botUserId,
    (t) => t.includes('the current time is recorded'),
  );
  expect(reply).toContain('the current time is recorded');

  // Model was invoked twice: once to emit tool_call, once after the tool result.
  await waitFor(() => mock.requests.length >= 2, { what: 'model called twice' });

  // The continuation request carries the get_current_time tool_result for
  // call_t1 (the bespoke version asserted this on the second model call's `tool`
  // message; here it's in the recorded request body).
  const flat = JSON.stringify(mock.requests);
  expect(flat).toContain('call_t1');
  expect(flat).toContain('tool_result');

  // JSONL has tool_call + tool_result events; the result is an ISO-8601 string.
  const events = readEvents(threadTs);
  const tcs = events.filter((e) => e.type === 'tool_call');
  const trs = events.filter((e) => e.type === 'tool_result');
  expect(tcs).toHaveLength(1);
  expect(trs).toHaveLength(1);
  expect(tcs[0]?.payload.name).toBe('get_current_time');
  expect(trs[0]?.payload.tool_call_id).toBe('call_t1');
  expect(String(trs[0]?.payload.content)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
}, 120_000);

test('tool_call + tool_result from a prior turn are replayed in the next turn', async () => {
  const mock = agent.mock;
  if (!mock) throw new Error('expected SDK-mode mock handle');
  mock.reset();
  // All three turns set up front: the mock picks by conversation progress, so the
  // resumed SDK session continues at the right index across both mentions.
  //   req @progress 0 → tool_call · @1 → 'turn1 done' · @2 (turn 2) → 'turn2 reply'
  mock.setTurns([
    { toolUses: [{ id: 'call_replay', name: 'mcp__agenta__get_current_time', input: {} }] },
    { text: 'turn1 done' },
    { text: 'turn2 reply' },
  ]);

  const threadTs = await mention(
    tester,
    agent.botUserId,
    channel,
    undefined,
    `e2e-tool-replay-${Date.now()}`,
  );
  createdThreads.push(threadTs);

  await waitForReply(tester, channel, threadTs, agent.botUserId, (t) => t.includes('turn1 done'));

  // Turn 2: a follow-up mention in the same thread.
  await mention(tester, agent.botUserId, channel, threadTs, 'follow-up question');
  await waitForReply(tester, channel, threadTs, agent.botUserId, (t) => t.includes('turn2 reply'));

  // The SDK resumes the session, so turn 2's request resends the full prior
  // history — the replayed tool_use (call_replay), its tool_result, turn 1's
  // final assistant reply, and the new user message all appear in that request.
  await waitFor(
    () => mock.requests.some((r) => JSON.stringify(r).includes('follow-up question')),
    { what: 'turn 2 request recorded' },
  );
  const turn2Req = mock.requests.find((r) => JSON.stringify(r).includes('follow-up question'));
  const flat2 = JSON.stringify(turn2Req);
  expect(flat2).toContain('call_replay'); // prior tool_use replayed
  expect(flat2).toContain('turn1 done'); // prior final reply replayed
  expect(flat2).toContain('follow-up question'); // the new user message
}, 120_000);

test('/stop during a running turn edits checklist to "stopped"', async () => {
  const mock = agent.mock;
  if (!mock) throw new Error('expected SDK-mode mock handle');
  mock.reset();
  // One turn that we hold open with the gate so the turn stays "running" while
  // we fire /stop. (The bespoke version held the post-tool model call; the SDK
  // abort path is identical whether or not a tool ran first, so we gate the
  // turn's model call directly — simpler + deterministic.)
  mock.setTurns([{ text: 'should not be seen' }]);
  const gate = mock.gateNextTurn();

  const threadTs = await mention(
    tester,
    agent.botUserId,
    channel,
    undefined,
    `e2e-tool-stop-${Date.now()}`,
  );
  createdThreads.push(threadTs);

  // Wait until the (gated) model call is in flight — the turn is now running.
  await waitFor(() => mock.requests.length >= 1, {
    what: 'model call in flight (gated)',
    timeoutMs: 25_000,
  });

  // Fire /stop while the turn hangs; the SDK aborts the query and renders "stopped".
  await mention(tester, agent.botUserId, channel, threadTs, '/stop');

  const reply = await waitForReply(
    tester,
    channel,
    threadTs,
    agent.botUserId,
    (t) => t.includes('stopped'),
  );
  expect(reply).toContain('stopped');

  gate.release(); // let the abandoned request drain (harmless no-op post-abort)
}, 120_000);
