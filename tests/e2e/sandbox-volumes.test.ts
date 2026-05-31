import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import type { AssistantMessage, CallModel, Message } from '../../src/tenant/model/gateway';
import { threadKey } from '../../src/tenant/runtime/thread';
import { containerName } from '../../src/tenant/sandbox';
import { ensureImage, volumeName } from '../../src/tenant/sandbox/docker';
import {
  type Agent,
  cleanupTempDataDir,
  DOCKER_PROVIDER_ACTIVE,
  deleteThread,
  mention,
  requireEnv,
  safeShutdown,
  setupTempDataDir,
  startAgent,
  startTester,
  type Tester,
  waitFor,
  waitForReply,
} from './helpers';

// Per-thread persistent sandbox volumes — end-to-end coverage that's not
// already on `sandbox-persistence-dead.test.ts` (which exercises the
// dead-container + live-volume reattach path): here we focus on the
// `/delete` lifecycle, making sure the named volume is destroyed alongside
// the container so a `/delete` truly wipes the thread. docker-only.

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

function volumeExists(name: string): boolean {
  return spawnSync('docker', ['volume', 'inspect', name]).status === 0;
}

function containerExists(name: string): boolean {
  return spawnSync('docker', ['inspect', '-f', '{{.Id}}', name]).status === 0;
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
  '/delete tears down both the container and the per-thread volume',
  async () => {
    script.length = 0;
    calls.length = 0;

    // Turn 1: write a file to the workspace. Forces sandbox provisioning,
    // which creates the named volume; without a sandbox-touching tool the
    // bot's lazy-provisioning path never builds the container.
    scriptReply({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_write',
          type: 'function',
          function: {
            name: 'bash',
            arguments: JSON.stringify({ command: 'echo persisted > ~/marker' }),
          },
        },
      ],
    });
    scriptReply({ role: 'assistant', content: 'marker written' });

    const threadTs = await mention(
      tester,
      agent.botUserId,
      channel,
      undefined,
      `e2e-volume-delete-${Date.now()}`,
    );
    createdThreads.push(threadTs);
    const tk = threadKey(channel, threadTs);

    await waitForReply(tester, channel, threadTs, agent.botUserId, (t) => t === 'marker written', {
      timeoutMs: 60_000,
    });
    await waitFor(() => calls.length === 2, { what: 'two model calls', timeoutMs: 30_000 });

    const cname = containerName(tk);
    const vname = volumeName(tk);
    expect(containerExists(cname)).toBe(true);
    expect(volumeExists(vname)).toBe(true);

    // /delete: should destroy the container AND the volume.
    await mention(tester, agent.botUserId, channel, threadTs, '/delete');
    await waitFor(() => !containerExists(cname), {
      what: 'container removed by /delete',
      timeoutMs: 30_000,
    });
    await waitFor(() => !volumeExists(vname), {
      what: 'volume removed by /delete',
      timeoutMs: 30_000,
    });
  },
  120_000,
);
