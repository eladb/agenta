import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { CallModel, Message } from '../../src/model/gateway';
import {
  type Agent,
  cleanupTempDataDir,
  deleteThread,
  mention,
  requireEnv,
  setupTempDataDir,
  shutdown,
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

// Gated stub: each call pulls the next queued gate and awaits it (or aborts on
// signal). Tests queue gates before firing a mention, then resolve them in
// order. Calls are recorded so assertions can inspect the messages array.
type Gate = { resolve: (reply: string) => void; promise: Promise<string> };
const gates: Gate[] = [];
const calls: Message[][] = [];

function queueGate(): Gate {
  let resolve!: (reply: string) => void;
  const promise = new Promise<string>((r) => {
    resolve = r;
  });
  const g: Gate = { resolve, promise };
  gates.push(g);
  return g;
}

const gatedCallModel: CallModel = async (messages, opts) => {
  calls.push(messages);
  const g = gates.shift();
  if (!g) return { role: 'assistant', content: 'ungated' };
  const text = await new Promise<string>((resolve, reject) => {
    let settled = false;
    g.promise.then((reply) => {
      if (settled) return;
      settled = true;
      resolve(reply);
    });
    opts?.signal?.addEventListener('abort', () => {
      if (settled) return;
      settled = true;
      reject(new DOMException('aborted', 'AbortError'));
    });
  });
  return { role: 'assistant', content: text };
};

beforeAll(async () => {
  setupTempDataDir();
  channel = requireEnv('TEST_CHANNEL_ID');
  [agent, tester] = await Promise.all([startAgent(gatedCallModel), startTester()]);
});

afterAll(async () => {
  for (const ts of createdThreads) {
    await deleteThread(tester, agent, channel, ts);
  }
  await shutdown(agent, tester);
  cleanupTempDataDir();
});

// TODO(#101): re-enable once the test stops waiting for the removed `• thinking…` placeholder.
test.skip('/stop cancels an in-flight turn and edits checklist to "stopped"', async () => {
  const gate = queueGate();
  const threadTs = await mention(
    tester,
    agent.botUserId,
    channel,
    undefined,
    `e2e-stop-${Date.now()}`,
  );
  createdThreads.push(threadTs);

  // Wait until the model is actually being called (the gated stub records calls[]).
  await waitFor(() => calls.length >= 1, { what: 'first model call', timeoutMs: 30_000 });

  // Fire /stop while the turn is hanging on the gate.
  await mention(tester, agent.botUserId, channel, threadTs, '/stop');

  const stopped = await waitForReply(
    tester,
    channel,
    threadTs,
    agent.botUserId,
    (t) => t === 'stopped',
  );
  expect(stopped).toBe('stopped');

  // Releasing the gate now is a no-op (turn already aborted).
  gate.resolve('unreached');
});

test('mention during a running turn is batched into a follow-up turn', async () => {
  calls.length = 0;
  const gate1 = queueGate();
  const gate2 = queueGate();

  const threadTs = await mention(tester, agent.botUserId, channel, undefined, 'first message');
  createdThreads.push(threadTs);

  // Wait until turn 1 has reached the model.
  await waitFor(() => calls.length === 1, { what: 'turn 1 reached callModel' });

  // Second mention while turn 1 is gated — should queue, not start a new turn.
  await mention(tester, agent.botUserId, channel, threadTs, 'second message');

  await new Promise((r) => setTimeout(r, 1500));
  expect(calls.length).toBe(1);

  // Release turn 1 → assistant reply recorded → loop runs turn 2.
  gate1.resolve('reply-one');

  await waitFor(() => calls.length === 2, { what: 'turn 2 reached callModel' });

  const turn2 = calls[1];
  if (!turn2) throw new Error('expected turn 2 to be recorded');
  const userTexts = turn2
    .filter((m) => m.role === 'user')
    .flatMap((m) =>
      typeof m.content === 'string'
        ? [m.content]
        : m.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])),
    )
    .join('\n');
  expect(userTexts).toContain('first message');
  expect(userTexts).toContain('second message');
  expect(turn2.some((m) => m.role === 'assistant' && m.content === 'reply-one')).toBe(true);

  gate2.resolve('reply-two');
  await waitForReply(tester, channel, threadTs, agent.botUserId, (t) => t === 'reply-two');
});
