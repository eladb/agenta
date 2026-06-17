// Migrated to the SDK harness + mock-model (#315 Phase A). The product behavior
// asserted is unchanged — the model emits a bash tool_call, the bot runs it in
// the per-thread sandbox (creating the named volume), and a `/delete` tears down
// both the container and the volume — but the model is now driven by the
// mock-model server (ANTHROPIC_BASE_URL) scripted with MockTurn[] instead of the
// bespoke `scriptedCallModel`/`script` queue. The "model called N times" gate
// moves from the recorded `Message[]` to the mock's recorded request bodies.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
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
  startBotAndTenant,
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
  // SDK mode: the tenant runs the Agent SDK harness driven by the mock-model
  // server (returned as `agent.mock`); the callModel arg is unused.
  [agent, tester] = await Promise.all([
    startBotAndTenant(),
    startTester(),
  ]);
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
    const mock = agent.mock;
    if (!mock) throw new Error('expected SDK-mode mock handle');
    mock.reset();

    // Turn 1: write a file to the workspace. Forces sandbox provisioning,
    // which creates the named volume; without a sandbox-touching tool the
    // bot's lazy-provisioning path never builds the container. Turn 2 is the
    // text continuation after the tool result.
    mock.setTurns([
      {
        toolUses: [
          {
            id: 'call_write',
            name: 'mcp__agenta__bash',
            input: { command: 'echo persisted > ~/marker' },
          },
        ],
      },
      { text: 'marker written' },
    ]);

    const threadTs = await mention(
      tester,
      agent.botUserId,
      channel,
      undefined,
      `e2e-volume-delete-${Date.now()}`,
    );
    createdThreads.push(threadTs);
    const tk = threadKey(channel, threadTs);

    await waitForReply(
      tester,
      channel,
      threadTs,
      agent.botUserId,
      (t) => t.includes('marker written'),
      { timeoutMs: 90_000 },
    );
    // Model was invoked twice: once to emit tool_call, once after the tool result.
    await waitFor(() => mock.requests.length >= 2, {
      what: 'two model calls',
      timeoutMs: 30_000,
    });

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
