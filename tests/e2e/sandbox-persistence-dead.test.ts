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
  DOCKER_PROVIDER_ACTIVE,
  getDataDir,
  mention,
  requireEnv,
  setupTempDataDir,
  safeShutdown,
  startAgent,
  startTester,
  type Tester,
  waitFor,
  waitForReply,
} from './helpers';

// When the persisted container is gone before agent B starts but the
// per-thread named volume survives, the next mention should provision a
// fresh container ATTACHED to the same volume. The marker file written in
// agent A's container should still be there — that's the value-add of
// per-thread persistent volumes over the original sandbox-persistence work
// (which only handled the bot-restart case, not container replacement).
// docker-only: uses docker-specific `rm` to simulate the dead-container
// state.

const HAS_DOCKER = DOCKER_PROVIDER_ACTIVE;

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
  sandbox?: {
    provider: string;
    container_name?: string;
    token?: string;
    volume_name?: string;
  };
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
}, 120_000);

afterAll(async () => {
  if (!HAS_DOCKER) return;
  for (const ts of createdThreads) {
    await deleteThread(tester, agent, channel, ts);
  }
  await safeShutdown(agent, tester);
  cleanupTempDataDir();
}, 120_000);

test.if(HAS_DOCKER)(
  'dead-container + live-volume re-hydration: marker survives container replacement',
  async () => {
    script.length = 0;
    calls.length = 0;

    // Turn 1: write a marker into the (per-thread persistent) workspace.
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
              command: 'echo first-boot > ~/marker',
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
    expect(session1.sandbox?.volume_name).toBeDefined();
    const token1 = session1.sandbox?.token;
    const volume1 = session1.sandbox?.volume_name;
    expect(typeof token1).toBe('string');

    // Simulate restart + force-remove the container behind the bot's back.
    // The named volume is NOT removed (docker rm -fv removes anonymous
    // volumes only; named volumes survive). Release the per-bot lockfile
    // too — `startAgent` below calls `acquire('agent')`, which would
    // otherwise refuse because the file still names THIS pid.
    await agent.socket.disconnect();
    agent.lock.release();
    const { _resetImageReadyCache } = await import('../../src/sandbox/docker');
    _resetImageReadyCache();
    const { _resetSyncedAttachments } = await import('../../src/sandbox');
    _resetSyncedAttachments();

    const rm = spawnSync('docker', ['rm', '-fv', containerName(tk)]);
    expect(rm.status).toBe(0);

    // Confirm the volume is still there.
    const volInspect = spawnSync('docker', ['volume', 'inspect', volume1 ?? '__missing__']);
    expect(volInspect.status).toBe(0);

    agent = await startAgent(scriptedCallModel);

    // Turn 2: read the marker. The new container is attached to the
    // existing volume, so `cat ~/marker` should still return `first-boot`.
    scriptReply({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_read',
          type: 'function',
          function: {
            name: 'bash',
            arguments: JSON.stringify({ command: 'cat ~/marker' }),
          },
        },
      ],
    });
    scriptReply({ role: 'assistant', content: 'read complete' });

    await mention(tester, agent.botUserId, channel, threadTs, 'check marker');
    await waitForReply(tester, channel, threadTs, agent.botUserId, (t) => t === 'read complete', {
      timeoutMs: 60_000,
    });
    await waitFor(() => calls.length === 4, { what: 'four model calls', timeoutMs: 30_000 });

    const fourth = calls[3];
    if (!fourth) throw new Error('expected fourth call');
    const readResult = fourth.find((m) => m.role === 'tool' && m.tool_call_id === 'call_read');
    if (readResult?.role !== 'tool') throw new Error('expected read tool msg');
    expect(readResult.content).toContain('first-boot');

    // session.json should still reference the SAME volume; the token is
    // preserved across the reattach (provider keeps the persisted token so
    // anyone holding the bearer header can keep working).
    const session2 = readSessionRaw(tk);
    expect(session2.sandbox?.container_name).toBe(containerName(tk));
    expect(session2.sandbox?.volume_name).toBe(volume1);
    expect(session2.sandbox?.token).toBe(token1);
  },
  240_000,
);
