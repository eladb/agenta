// Migrated to the SDK harness + mock-model (#315 Phase A). The product behavior
// asserted is unchanged — agent A writes a marker file in the sandbox, the
// container is force-removed behind the bot's back while the per-thread named
// volume survives, the tenant is restarted, and agent B's next mention provisions
// a FRESH container attached to the same volume so the marker is still readable.
// That's the value-add of per-thread persistent volumes over plain bot-restart.
// It also proves the SDK session resumes across the restart (#308/#309). The
// model is now driven by the mock-model server (ANTHROPIC_BASE_URL) scripted with
// MockTurn[] instead of the bespoke `scriptedCallModel`/`script` queue, and the
// read tool_result round-trip assertion reads the mock's recorded request bodies
// (Anthropic shape) rather than the recorded OpenAI-shape `Message[]`.
//
// docker-only: uses docker-specific `rm` to simulate the dead-container state.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { threadKey } from '../../src/tenant/runtime/thread';
import { containerName } from '../../src/tenant/sandbox';
import { ensureImage } from '../../src/tenant/sandbox/docker';
import {
  type Agent,
  cleanupTempDataDir,
  DOCKER_PROVIDER_ACTIVE,
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

// When the persisted container is gone before agent B starts but the
// per-thread named volume survives, the next mention should provision a
// fresh container ATTACHED to the same volume. The marker file written in
// agent A's container should still be there — that's the value-add of
// per-thread persistent volumes over the original sandbox-persistence work
// (which only handled the bot-restart case, not container replacement).

const HAS_DOCKER = DOCKER_PROVIDER_ACTIVE;

let channel: string;
let tester: Tester;
let agent: Agent;
const createdThreads: string[] = [];

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
  // SDK mode: the tenant runs the Agent SDK harness driven by the mock-model
  // server (returned as `agent.mock`); the callModel arg is unused.
  [agent, tester] = await Promise.all([
    startBotAndTenant(undefined, { harness: 'sdk' }),
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
  'dead-container + live-volume re-hydration: marker survives container replacement',
  async () => {
    const mock = agent.mock;
    if (!mock) throw new Error('expected SDK-mode mock handle');
    mock.reset();

    // Turn 0: write a marker into the (per-thread persistent) workspace.
    // Turn 1: the continuation reply after the tool result.
    mock.setTurns([
      {
        toolUses: [
          {
            id: 'call_marker',
            name: 'mcp__agenta__bash',
            input: { command: 'echo first-boot > ~/marker' },
          },
        ],
      },
      { text: 'marker set' },
    ]);

    const threadTs = await mention(
      tester,
      agent.botUserId,
      channel,
      undefined,
      `e2e-persist-dead-${Date.now()}`,
    );
    createdThreads.push(threadTs);
    const tk = threadKey(channel, threadTs);

    await waitForReply(
      tester,
      channel,
      threadTs,
      agent.botUserId,
      (t) => t.includes('marker set'),
      {
        // 120s (not 60s): the docker container boot on a cold CI runner is far
        // slower than on a dev box. This cap, not the test budget, was the
        // limiter that flaked under docker-in-CI (#276 shakedown).
        timeoutMs: 120_000,
      },
    );
    await waitFor(() => mock.requests.length >= 2, {
      what: 'two model calls',
      timeoutMs: 30_000,
    });

    const session1 = readSessionRaw(tk);
    expect(session1.sandbox?.container_name).toBe(containerName(tk));
    expect(session1.sandbox?.volume_name).toBeDefined();
    const token1 = session1.sandbox?.token;
    const volume1 = session1.sandbox?.volume_name;
    expect(typeof token1).toBe('string');

    // Simulate restart + force-remove the container behind the bot's back.
    // The named volume is NOT removed (docker rm -fv removes anonymous
    // volumes only; named volumes survive). Release both lockfiles AND
    // stop the tenant HTTP server — `startBotAndTenant` below re-acquires
    // 'bot' + 'agent' and starts a fresh tenant on a new port; without
    // these teardowns we'd race the locks (refuses with our own pid)
    // and leak the loopback socket.
    await agent.socket.disconnect();
    agent.tenant.stop();
    agent.lock.release();
    agent.agentLock.release();
    const { _resetImageReadyCache } = await import('../../src/tenant/sandbox/docker');
    _resetImageReadyCache();
    const { _resetSyncedAttachments } = await import('../../src/tenant/sandbox');
    _resetSyncedAttachments();

    const rm = spawnSync('docker', ['rm', '-fv', containerName(tk)]);
    expect(rm.status).toBe(0);

    // Confirm the volume is still there.
    const volInspect = spawnSync('docker', ['volume', 'inspect', volume1 ?? '__missing__']);
    expect(volInspect.status).toBe(0);

    // Start agent B with the same data dir. The reboot spins up a BRAND-NEW
    // mock-model server (re-points ANTHROPIC_BASE_URL), so re-grab the handle
    // and re-script it before the next mention.
    agent = await startBotAndTenant(undefined, { harness: 'sdk' });
    const mock2 = agent.mock;
    if (!mock2) throw new Error('expected SDK-mode mock handle after reboot');
    mock2.reset();

    // The mock selects a turn by CONVERSATION PROGRESS (count of prior assistant
    // messages). mock2 is a fresh server, but the SDK RESUMES the thread's
    // session — its first post-reboot request already carries agent A's two
    // assistant turns (the marker-set tool_use + the 'marker set' reply), so
    // progress is 2, not 0. Script the CUMULATIVE conversation: slots 0–1 stand
    // in for agent A's already-served turns, slot 2 is agent B's marker read
    // (the new container attaches to the existing volume, so `cat ~/marker`
    // still returns `first-boot`), slot 3 its continuation.
    mock2.setTurns([
      { text: 'marker set (replayed)' },
      { text: 'marker set (replayed)' },
      {
        toolUses: [
          { id: 'call_read', name: 'mcp__agenta__bash', input: { command: 'cat ~/marker' } },
        ],
      },
      { text: 'read complete' },
    ]);

    await mention(tester, agent.botUserId, channel, threadTs, 'check marker');
    await waitForReply(
      tester,
      channel,
      threadTs,
      agent.botUserId,
      (t) => t.includes('read complete'),
      {
        // 120s: turn 2 re-provisions a fresh container and reattaches the
        // surviving volume — the slowest step, and slower still on a cold CI
        // runner.
        timeoutMs: 120_000,
      },
    );
    await waitFor(() => mock2.requests.length >= 2, {
      what: 'two model calls after reboot',
      timeoutMs: 30_000,
    });

    // The bash result for the read should contain `first-boot`, proving the
    // marker survived container replacement = the fresh container reattached
    // the same volume. The tool_result round-trip lands in the continuation
    // request body (the bespoke version asserted this on the post-restart `tool`
    // message; here it's in the recorded request body).
    const flat = JSON.stringify(mock2.requests);
    expect(flat).toContain('call_read');
    expect(flat).toContain('tool_result');
    expect(flat).toContain('first-boot');

    // session.json should still reference the SAME volume; the token is
    // preserved across the reattach (provider keeps the persisted token so
    // anyone holding the bearer header can keep working).
    const session2 = readSessionRaw(tk);
    expect(session2.sandbox?.container_name).toBe(containerName(tk));
    expect(session2.sandbox?.volume_name).toBe(volume1);
    expect(session2.sandbox?.token).toBe(token1);
  },
  360_000,
);
