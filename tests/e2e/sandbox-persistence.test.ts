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

// Sandbox persistence across simulated bot restarts. We can't fork an OS
// process inside `bun test`, but the persistence machinery is in the
// session.json file + the provider's in-memory cache — so we simulate a
// restart by stopping agent A (cleanly disconnecting + resetting the
// provider's in-memory state) and starting agent B with the same data dir.
// docker-only: the simulated-restart path here uses docker-specific
// container/volume operations that have no Fly equivalent.

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
  'sandbox survives simulated bot restart: new agent reuses the same container',
  async () => {
    script.length = 0;
    calls.length = 0;

    // Turn 1 (agent A): write a marker file in the workspace.
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
              command: 'echo first-boot > ~/marker && ls -la ~/marker',
            }),
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
      `e2e-persist-${Date.now()}`,
    );
    createdThreads.push(threadTs);
    const tk = threadKey(channel, threadTs);

    await waitForReply(tester, channel, threadTs, agent.botUserId, (t) => t === 'marker written', {
      timeoutMs: 60_000,
    });
    await waitFor(() => calls.length === 2, { what: 'two model calls', timeoutMs: 30_000 });

    // session.json must now carry the docker sandbox record.
    const session1 = readSessionRaw(tk);
    expect(session1.sandbox?.provider).toBe('docker');
    expect(session1.sandbox?.container_name).toBe(containerName(tk));
    const token1 = session1.sandbox?.token;
    expect(typeof token1).toBe('string');
    expect(dockerInspectRunning(containerName(tk))).toBe(true);

    // Simulate a bot restart: disconnect agent A AND clear the docker
    // provider's in-memory state (the new process would have done both
    // implicitly). We re-import the module fresh? Not necessary — the
    // _resetImageReadyCache test helper clears `tokens` which is what
    // tracks the in-memory route. Release the per-bot lockfile too —
    // `startAgent` below calls `acquire('agent')`, which would otherwise
    // refuse because the file still names THIS pid.
    await agent.socket.disconnect();
    agent.lock.release();
    const { _resetImageReadyCache } = await import('../../src/sandbox/docker');
    _resetImageReadyCache();
    // _resetSyncedAttachments also resets the sandbox/index per-thread cache
    // that's keyed independently of provider state.
    const { _resetSyncedAttachments } = await import('../../src/sandbox');
    _resetSyncedAttachments();

    // Start agent B with the same data dir.
    agent = await startAgent(scriptedCallModel);

    // Turn 2 (agent B): read the marker. If the sandbox was re-provisioned
    // and the volume was wiped, the read would fail. Per-thread persistent
    // volumes mean the workspace state survives both bot restarts and
    // container replacement.
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
    scriptReply({ role: 'assistant', content: 'marker read' });

    await mention(tester, agent.botUserId, channel, threadTs, 'check marker');
    await waitForReply(tester, channel, threadTs, agent.botUserId, (t) => t === 'marker read', {
      timeoutMs: 60_000,
    });
    await waitFor(() => calls.length === 4, { what: 'four model calls', timeoutMs: 30_000 });

    // The bash result for the read should contain `first-boot`, proving the
    // marker survived = the same container.
    const fourth = calls[3];
    if (!fourth) throw new Error('expected fourth call');
    const readResult = fourth.find((m) => m.role === 'tool' && m.tool_call_id === 'call_read');
    if (readResult?.role !== 'tool') throw new Error('expected read tool msg');
    expect(readResult.content).toContain('first-boot');

    // session.json should still reference the same container with the same token.
    const session2 = readSessionRaw(tk);
    expect(session2.sandbox?.container_name).toBe(containerName(tk));
    expect(session2.sandbox?.token).toBe(token1);
  },
  240_000,
);
