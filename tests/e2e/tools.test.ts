import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AssistantMessage, CallModel, Message } from '../../src/model/gateway';
import { threadKey } from '../../src/runtime/thread';
import {
  type Agent,
  cleanupTempDataDir,
  deleteThread,
  getDataDir,
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

// Scripted stub: each invocation of the model dequeues the next response.
// Responses can also be "gate" objects whose promise must resolve before the
// callModel call returns — lets us hold a turn open while we send /stop.
type Scripted =
  | { kind: 'reply'; message: AssistantMessage }
  | { kind: 'gate'; promise: Promise<AssistantMessage> };

const script: Scripted[] = [];
const calls: Message[][] = [];

function scriptReply(message: AssistantMessage): void {
  script.push({ kind: 'reply', message });
}

function scriptGate(): { resolve: (m: AssistantMessage) => void } {
  let resolve!: (m: AssistantMessage) => void;
  const promise = new Promise<AssistantMessage>((r) => {
    resolve = r;
  });
  script.push({ kind: 'gate', promise });
  return { resolve };
}

const scriptedCallModel: CallModel = async (messages, opts) => {
  calls.push(messages);
  const next = script.shift();
  if (!next) return { role: 'assistant', content: 'unscripted' };
  if (next.kind === 'reply') return next.message;
  return await new Promise<AssistantMessage>((resolve, reject) => {
    let settled = false;
    next.promise.then((m) => {
      if (settled) return;
      settled = true;
      resolve(m);
    });
    opts?.signal?.addEventListener('abort', () => {
      if (settled) return;
      settled = true;
      reject(new DOMException('aborted', 'AbortError'));
    });
  });
};

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
  [agent, tester] = await Promise.all([startAgent(scriptedCallModel), startTester()]);
});

afterAll(async () => {
  for (const ts of createdThreads) {
    await deleteThread(tester, agent, channel, ts);
  }
  await shutdown(agent, tester);
  cleanupTempDataDir();
});

test('model can call get_current_time and the bot posts the final reply', async () => {
  script.length = 0;
  calls.length = 0;

  scriptReply({
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call_t1',
        type: 'function',
        function: { name: 'get_current_time', arguments: '{}' },
      },
    ],
  });
  scriptReply({ role: 'assistant', content: 'the current time is recorded' });

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
    (t) => t === 'the current time is recorded',
  );
  expect(reply).toBe('the current time is recorded');

  // Model was invoked twice: once to emit tool_call, once after the tool result.
  await waitFor(() => calls.length === 2, { what: 'model called twice' });

  // Second model call's messages include a tool message with the get_current_time result.
  const secondCall = calls[1];
  if (!secondCall) throw new Error('expected second model call');
  const toolMsg = secondCall.find((m) => m.role === 'tool');
  expect(toolMsg).toBeDefined();
  if (toolMsg?.role !== 'tool') throw new Error('not a tool msg');
  expect(toolMsg.tool_call_id).toBe('call_t1');
  // get_current_time returns an ISO-8601 string.
  expect(toolMsg.content).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

  // JSONL has tool_call + tool_result events.
  const events = readEvents(threadTs);
  const tcs = events.filter((e) => e.type === 'tool_call');
  const trs = events.filter((e) => e.type === 'tool_result');
  expect(tcs).toHaveLength(1);
  expect(trs).toHaveLength(1);
  expect(tcs[0]?.payload.name).toBe('get_current_time');
  expect(trs[0]?.payload.tool_call_id).toBe('call_t1');
});

test('/stop during the tool loop edits checklist to "stopped"', async () => {
  script.length = 0;
  calls.length = 0;

  // First call: tool_call. Second call: hang until /stop aborts the fetch.
  scriptReply({
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call_t2',
        type: 'function',
        function: { name: 'get_current_time', arguments: '{}' },
      },
    ],
  });
  scriptGate();

  const threadTs = await mention(
    tester,
    agent.botUserId,
    channel,
    undefined,
    `e2e-tool-stop-${Date.now()}`,
  );
  createdThreads.push(threadTs);

  // Wait until the loop is sitting on the second (hanging) model call.
  await waitFor(() => calls.length === 2, {
    what: 'second model call reached (post-tool)',
    timeoutMs: 25_000,
  });

  // Fire /stop while the second call is hanging.
  await mention(tester, agent.botUserId, channel, threadTs, '/stop');

  const reply = await waitForReply(
    tester,
    channel,
    threadTs,
    agent.botUserId,
    (t) => t === 'stopped',
  );
  expect(reply).toBe('stopped');
});
