import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import type { AssistantMessage, CallModel, Message } from '../../src/model/gateway';
import { threadKey } from '../../src/runtime/thread';
import { containerName, ensureImage } from '../../src/sandbox/docker';
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

function dockerAvailable(): boolean {
  const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    stdio: 'ignore',
  });
  return r.status === 0;
}

const HAS_DOCKER = dockerAvailable();

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

beforeAll(async () => {
  if (!HAS_DOCKER) return;
  setupTempDataDir();
  channel = requireEnv('TEST_CHANNEL_ID');
  // Build/pull the sandbox image up front so the first mention doesn't time out.
  await ensureImage();
  [agent, tester] = await Promise.all([startAgent(scriptedCallModel), startTester()]);
});

afterAll(async () => {
  if (!HAS_DOCKER) return;
  for (const ts of createdThreads) {
    await deleteThread(tester, agent, channel, ts);
  }
  await shutdown(agent, tester);
  cleanupTempDataDir();
});

test.if(HAS_DOCKER)(
  'bash tool: model can execute a command in the sandbox container',
  async () => {
    script.length = 0;
    calls.length = 0;

    scriptReply({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_bash1',
          type: 'function',
          function: {
            name: 'bash',
            arguments: JSON.stringify({ command: 'echo hello-from-sandbox && pwd' }),
          },
        },
      ],
    });
    scriptReply({ role: 'assistant', content: 'command finished' });

    const threadTs = await mention(
      tester,
      agent.botUserId,
      channel,
      undefined,
      `e2e-bash-${Date.now()}`,
    );
    createdThreads.push(threadTs);

    await waitForReply(tester, channel, threadTs, agent.botUserId, (t) => t === 'command finished');
    await waitFor(() => calls.length === 2, { what: 'two model calls', timeoutMs: 30_000 });

    const second = calls[1];
    if (!second) throw new Error('expected second call');
    const toolMsg = second.find((m) => m.role === 'tool');
    if (toolMsg?.role !== 'tool') throw new Error('expected tool msg');
    expect(toolMsg.content).toContain('exit: 0');
    expect(toolMsg.content).toContain('hello-from-sandbox');
    expect(toolMsg.content).toContain('/workspace');
  },
  60_000,
);

test.if(HAS_DOCKER)(
  '/delete removes the sandbox container',
  async () => {
    script.length = 0;
    calls.length = 0;
    // First mention only — no tools, just ensures the container is created.
    scriptReply({ role: 'assistant', content: 'hi' });

    const threadTs = await mention(
      tester,
      agent.botUserId,
      channel,
      undefined,
      `e2e-delete-${Date.now()}`,
    );
    createdThreads.push(threadTs);
    await waitForReply(tester, channel, threadTs, agent.botUserId, (t) => t === 'hi');

    const cname = containerName(threadKey(channel, threadTs));
    await waitFor(
      () => spawnSync('docker', ['inspect', '-f', '{{.State.Status}}', cname]).status === 0,
      { what: 'container created', timeoutMs: 30_000 },
    );

    await mention(tester, agent.botUserId, channel, threadTs, '/delete');

    await waitFor(
      () => spawnSync('docker', ['inspect', '-f', '{{.State.Status}}', cname]).status !== 0,
      { what: 'container removed', timeoutMs: 30_000 },
    );

    const after = spawnSync('docker', ['inspect', '-f', '{{.State.Status}}', cname]);
    expect(after.status).not.toBe(0);
  },
  90_000,
);

function scriptReply(message: AssistantMessage): void {
  script.push({ kind: 'reply', message });
}
