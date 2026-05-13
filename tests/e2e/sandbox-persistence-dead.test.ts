import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AssistantMessage, CallModel, Message } from '../../src/model/gateway';
import { threadKey } from '../../src/runtime/thread';
import { containerName } from '../../src/sandbox';
import { ensureImage } from '../../src/sandbox/docker';
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

// When the persisted container is gone before agent B starts, the next
// mention should re-provision a fresh container without erroring out the
// turn. The marker file written in agent A's container should NOT be there.

function dockerAvailable(): boolean {
  const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    stdio: 'ignore',
  });
  return r.status === 0;
}

const HAS_DOCKER = dockerAvailable();

let channel: string;
let tester: Tester;
let agent: Agent;
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

function readSessionRaw(tk: string): {
  sandbox?: { provider: string; container_name?: string; token?: string };
} {
  return JSON.parse(readFileSync(join(getDataDir(), tk, 'session.json'), 'utf8'));
}

beforeAll(async () => {
  if (!HAS_DOCKER) return;
  setupTempDataDir();
  channel = requireEnv('TEST_CHANNEL_ID');
  process.env.SANDBOX_EXEC_TIMEOUT_MS = '8000';
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
  'dead-container re-hydration: agent B re-provisions when the persisted container is gone',
  async () => {
    script.length = 0;
    calls.length = 0;

    // Turn 1: write a marker.
    scriptReply({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_marker',
          type: 'function',
          function: {
            name: 'bash',
            arguments: JSON.stringify({
              command: 'echo first-boot > /workspace/marker',
            }),
          },
        },
      ],
    });
    scriptReply({ role: 'assistant', content: 'marker set' });

    const threadTs = await mention(
      tester,
      agent.botUserId,
      channel,
      undefined,
      `e2e-persist-dead-${Date.now()}`,
    );
    createdThreads.push(threadTs);
    const tk = threadKey(channel, threadTs);

    await waitForReply(tester, channel, threadTs, agent.botUserId, (t) => t === 'marker set', {
      timeoutMs: 60_000,
    });
    await waitFor(() => calls.length === 2, { what: 'two model calls', timeoutMs: 30_000 });

    const session1 = readSessionRaw(tk);
    expect(session1.sandbox?.container_name).toBe(containerName(tk));
    const token1 = session1.sandbox?.token;
    expect(typeof token1).toBe('string');

    // Simulate restart + force-remove the container behind the bot's back.
    await agent.socket.disconnect();
    const { _resetImageReadyCache } = await import('../../src/sandbox/docker');
    _resetImageReadyCache();
    const { _resetSyncedAttachments } = await import('../../src/sandbox');
    _resetSyncedAttachments();

    const rm = spawnSync('docker', ['rm', '-fv', containerName(tk)]);
    expect(rm.status).toBe(0);

    agent = await startAgent(scriptedCallModel);

    // Turn 2: try to read the marker. Should re-provision a fresh container
    // and `cat /workspace/marker` should fail (marker is in the dead
    // container, not the new one).
    scriptReply({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_read',
          type: 'function',
          function: {
            name: 'bash',
            arguments: JSON.stringify({ command: 'cat /workspace/marker 2>&1 || echo MISSING' }),
          },
        },
      ],
    });
    scriptReply({ role: 'assistant', content: 'attempted read' });

    await mention(tester, agent.botUserId, channel, threadTs, 'check marker');
    await waitForReply(tester, channel, threadTs, agent.botUserId, (t) => t === 'attempted read', {
      timeoutMs: 60_000,
    });
    await waitFor(() => calls.length === 4, { what: 'four model calls', timeoutMs: 30_000 });

    const fourth = calls[3];
    if (!fourth) throw new Error('expected fourth call');
    const readResult = fourth.find((m) => m.role === 'tool' && m.tool_call_id === 'call_read');
    if (readResult?.role !== 'tool') throw new Error('expected read tool msg');
    expect(readResult.content).toContain('MISSING');
    expect(readResult.content).not.toContain('first-boot');

    // session.json should now reference a NEW token (fresh container).
    const session2 = readSessionRaw(tk);
    expect(session2.sandbox?.container_name).toBe(containerName(tk));
    expect(session2.sandbox?.token).not.toBe(token1);
  },
  240_000,
);
