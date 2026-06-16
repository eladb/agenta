// Migrated to the SDK harness + mock-model (#315 Phase A). The product behavior
// asserted is unchanged — agent A writes a marker file in the sandbox, the tenant
// is restarted (simulated bot restart), and agent B reads the marker back, proving
// the per-thread persistent volume + sandbox record survive a restart and that the
// SDK session resumes across it (#308/#309). The model is now driven by the
// mock-model server (ANTHROPIC_BASE_URL) scripted with MockTurn[] instead of the
// bespoke `scriptedCallModel`/`script` queue, and the tool_result round-trip
// assertion reads the mock's recorded request bodies (Anthropic shape) rather than
// the recorded OpenAI-shape `Message[]`.
//
// docker-only: the simulated-restart path here uses docker-specific
// container/volume operations that have no Fly equivalent.
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

const HAS_DOCKER = DOCKER_PROVIDER_ACTIVE;

let channel: string;
let tester: Tester;
let agent: Agent;
const createdThreads: string[] = [];

function dockerInspectRunning(name: string): boolean {
  const r = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', name]);
  if (r.status !== 0) return false;
  return r.stdout.toString().trim() === 'true';
}

function readSessionRaw(tk: string): {
  status?: string;
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
  'sandbox survives simulated bot restart: new agent reuses the same container',
  async () => {
    const mock = agent.mock;
    if (!mock) throw new Error('expected SDK-mode mock handle');
    mock.reset();

    // Turn 0 (agent A): write a marker file in the workspace. Turn 1: the
    // continuation reply after the tool result.
    mock.setTurns([
      {
        toolUses: [
          {
            id: 'call_marker',
            name: 'mcp__agenta__bash',
            input: { command: 'echo first-boot > ~/marker && ls -la ~/marker' },
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
      `e2e-persist-${Date.now()}`,
    );
    createdThreads.push(threadTs);
    const tk = threadKey(channel, threadTs);

    // Cold fresh-container provisioning on the docker-CD sandbox runs ~65s
    // (slower than the old Fly provider, #276); the old 60s floor flaked (#310).
    // 90s matches the helper default and stays well under the 240s per-test cap.
    await waitForReply(
      tester,
      channel,
      threadTs,
      agent.botUserId,
      (t) => t.includes('marker written'),
      { timeoutMs: 90_000 },
    );
    // Model invoked twice: once to emit the tool_call, once after the tool result.
    await waitFor(() => mock.requests.length >= 2, {
      what: 'two model calls',
      timeoutMs: 30_000,
    });

    // session.json must now carry the docker sandbox record.
    const session1 = readSessionRaw(tk);
    expect(session1.sandbox?.provider).toBe('docker');
    expect(session1.sandbox?.container_name).toBe(containerName(tk));
    const token1 = session1.sandbox?.token;
    expect(typeof token1).toBe('string');
    expect(dockerInspectRunning(containerName(tk))).toBe(true);

    // Simulate a bot restart: disconnect agent A AND clear the docker
    // provider's in-memory state (the new process would have done both
    // implicitly). Release both lockfiles AND stop the tenant HTTP server —
    // `startBotAndTenant` below re-acquires 'bot' + 'agent' and starts a fresh
    // tenant on a new port; without these teardowns we'd race the locks (refuses
    // with our own pid) and leak the loopback socket.
    await agent.socket.disconnect();
    agent.tenant.stop();
    agent.lock.release();
    agent.agentLock.release();
    const { _resetImageReadyCache } = await import('../../src/tenant/sandbox/docker');
    _resetImageReadyCache();
    // _resetSyncedAttachments also resets the sandbox/index per-thread cache
    // that's keyed independently of provider state.
    const { _resetSyncedAttachments } = await import('../../src/tenant/sandbox');
    _resetSyncedAttachments();

    // Start agent B with the same data dir. The reboot spins up a BRAND-NEW
    // mock-model server (re-points ANTHROPIC_BASE_URL), so re-grab the handle
    // and re-script it before the next mention.
    agent = await startBotAndTenant(undefined, { harness: 'sdk' });
    const mock2 = agent.mock;
    if (!mock2) throw new Error('expected SDK-mode mock handle after reboot');
    mock2.reset();

    // The mock selects a turn by CONVERSATION PROGRESS (count of prior assistant
    // messages in the request). Even though mock2 is a brand-new server with an
    // empty request log, the SDK RESUMES the thread's session — so its first
    // post-reboot request already carries agent A's two assistant turns (the
    // marker-write tool_use + the 'marker written' reply). Progress is therefore
    // 2, not 0. We script the CUMULATIVE conversation so the read lands at the
    // right index: slots 0–1 stand in for agent A's already-served turns (mock2
    // never actually serves them), slot 2 is agent B's marker read, slot 3 its
    // continuation. If the sandbox was re-provisioned + the volume wiped, the
    // read would fail; per-thread persistent volumes mean it survives.
    mock2.setTurns([
      { text: 'marker written (replayed)' },
      { text: 'marker written (replayed)' },
      {
        toolUses: [
          { id: 'call_read', name: 'mcp__agenta__bash', input: { command: 'cat ~/marker' } },
        ],
      },
      { text: 'marker read' },
    ]);

    await mention(tester, agent.botUserId, channel, threadTs, 'check marker');
    // Same docker-CD slowness on the restart-reuse turn (#310).
    await waitForReply(
      tester,
      channel,
      threadTs,
      agent.botUserId,
      (t) => t.includes('marker read'),
      { timeoutMs: 90_000 },
    );
    await waitFor(() => mock2.requests.length >= 2, {
      what: 'two model calls after reboot',
      timeoutMs: 30_000,
    });

    // The bash result for the read should contain `first-boot`, proving the
    // marker survived = the same container. The tool_result round-trip lands in
    // the continuation request body (the bespoke version asserted this on the
    // post-restart `tool` message; here it's in the recorded request body).
    const flat = JSON.stringify(mock2.requests);
    expect(flat).toContain('call_read');
    expect(flat).toContain('tool_result');
    expect(flat).toContain('first-boot');

    // session.json should still reference the same container with the same token.
    const session2 = readSessionRaw(tk);
    expect(session2.sandbox?.container_name).toBe(containerName(tk));
    expect(session2.sandbox?.token).toBe(token1);
  },
  240_000,
);
