import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessage, CallModel, Message } from '../../src/model/gateway';
import { threadKey } from '../../src/runtime/thread';
import { ensureImage } from '../../src/sandbox/docker';
import {
  type Agent,
  cleanupTempDataDir,
  deleteThread,
  getDataDir,
  mention,
  requireEnv,
  STUB_REPLY_PREFIX,
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
let botspaceDir: string;
let originalBotspaceEnv: string | undefined;

type Scripted = { kind: 'reply'; message: AssistantMessage };
const script: Scripted[] = [];
const calls: Message[][] = [];

const scriptedCallModel: CallModel = async (messages) => {
  calls.push(messages);
  const next = script.shift();
  if (!next) {
    // Fall back to the simple echo stub if the script ran dry — keeps the
    // freeze test happy without scripting a reply per turn.
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role !== 'user') continue;
      const text =
        typeof m.content === 'string'
          ? m.content
          : m.content.find((p) => p.type === 'text')?.type === 'text'
            ? (m.content.find((p) => p.type === 'text') as { type: 'text'; text: string }).text
            : '(multipart)';
      return { role: 'assistant', content: `${STUB_REPLY_PREFIX}${text}` };
    }
    return { role: 'assistant', content: `${STUB_REPLY_PREFIX}(no user message)` };
  }
  return next.message;
};

function scriptReply(message: AssistantMessage): void {
  script.push({ kind: 'reply', message });
}

beforeAll(async () => {
  // Build a fresh, isolated botspace dir so the test isn't affected by the
  // repo's actual `sandbox/botspace/` contents. Point handler.ts at it via
  // the BOTSPACE_DIR env var.
  botspaceDir = mkdtempSync(join(tmpdir(), 'agenta-skills-'));
  writeFileSync(join(botspaceDir, 'BOT.md'), 'INITIAL BOT BODY');
  originalBotspaceEnv = process.env.BOTSPACE_DIR;
  process.env.BOTSPACE_DIR = botspaceDir;

  setupTempDataDir();
  channel = requireEnv('TEST_CHANNEL_ID');
  if (HAS_DOCKER) {
    // Only the docker-gated test needs the image; build it up front so the
    // first sandbox-touching turn doesn't time out.
    await ensureImage();
  }
  [agent, tester] = await Promise.all([startAgent(scriptedCallModel), startTester()]);
});

afterAll(async () => {
  for (const ts of createdThreads) {
    await deleteThread(tester, agent, channel, ts);
  }
  await shutdown(agent, tester);
  cleanupTempDataDir();
  if (originalBotspaceEnv === undefined) delete process.env.BOTSPACE_DIR;
  else process.env.BOTSPACE_DIR = originalBotspaceEnv;
  rmSync(botspaceDir, { recursive: true, force: true });
});

test('two mentions in one thread -> system message is byte-identical (frozen prompt)', async () => {
  script.length = 0;
  calls.length = 0;

  const seed = `e2e-skills-freeze-${Date.now()}`;
  const threadTs = await mention(tester, agent.botUserId, channel, undefined, seed);
  createdThreads.push(threadTs);
  // Wait for the first model call (the stub records it) — more reliable
  // than waiting for the Slack reply round-trip.
  await waitFor(() => calls.length >= 1, { what: 'first model call', timeoutMs: 30_000 });
  // And wait for the first reply too so Slack settles the thread before
  // we send the second mention.
  await waitForReply(tester, channel, threadTs, agent.botUserId, (t) =>
    t.startsWith(STUB_REPLY_PREFIX),
  );

  // Mutate BOT.md between the two mentions — the frozen prompt for this
  // thread must NOT pick up the change.
  writeFileSync(join(botspaceDir, 'BOT.md'), 'MUTATED BOT BODY — should not appear');

  const secondMentionText = `second-turn-${Date.now()}`;
  await mention(tester, agent.botUserId, channel, threadTs, secondMentionText);
  // Wait for the second reply (round-trip via the agent) — bounds the
  // wall-clock more reliably than just calls.length under Slack latency.
  await waitForReply(
    tester,
    channel,
    threadTs,
    agent.botUserId,
    (t) => t === `${STUB_REPLY_PREFIX}<@${agent.botUserId}> ${secondMentionText}`,
    { timeoutMs: 60_000 },
  );
  await waitFor(() => calls.length >= 2, { what: 'two model calls', timeoutMs: 30_000 });

  const first = calls[0];
  const second = calls[1];
  if (!first || !second) throw new Error('expected two recorded model calls');
  const sys1 = first[0];
  const sys2 = second[0];
  if (sys1?.role !== 'system' || sys2?.role !== 'system') {
    throw new Error('expected system message first');
  }
  expect(sys1.content).toBe(sys2.content);
  expect(typeof sys1.content === 'string' && sys1.content).toContain('INITIAL BOT BODY');
  expect(typeof sys1.content === 'string' && sys1.content).not.toContain('MUTATED BOT BODY');

  // And the frozen prompt is on disk in runtime.json.
  const runtimePath = join(getDataDir(), threadKey(channel, threadTs), 'runtime.json');
  const persisted = JSON.parse(readFileSync(runtimePath, 'utf8')) as {
    system_prompt?: string;
  };
  expect(persisted.system_prompt).toBe(sys1.content);
}, 120_000);

test('new thread after BOT.md edit -> system prompt reflects the new BOT.md', async () => {
  script.length = 0;
  calls.length = 0;
  // Drop the mutated body into BOT.md (the previous test's mutation persists
  // here intentionally; if it doesn't, re-write it).
  writeFileSync(join(botspaceDir, 'BOT.md'), 'NEW BOT BODY for new thread');

  const seed = `e2e-skills-new-${Date.now()}`;
  const threadTs = await mention(tester, agent.botUserId, channel, undefined, seed);
  createdThreads.push(threadTs);
  await waitForReply(tester, channel, threadTs, agent.botUserId, (t) =>
    t.startsWith(STUB_REPLY_PREFIX),
  );
  await waitFor(() => calls.length >= 1, { what: 'one model call', timeoutMs: 30_000 });

  const first = calls[0];
  if (!first) throw new Error('expected a recorded model call');
  const sys = first[0];
  if (sys?.role !== 'system') throw new Error('expected system message first');
  expect(typeof sys.content === 'string' && sys.content).toContain('NEW BOT BODY for new thread');
});

test('/delete removes runtime.json (and the rest of the thread dir)', async () => {
  script.length = 0;
  calls.length = 0;

  const seed = `e2e-skills-delete-${Date.now()}`;
  const threadTs = await mention(tester, agent.botUserId, channel, undefined, seed);
  createdThreads.push(threadTs);
  await waitForReply(tester, channel, threadTs, agent.botUserId, (t) =>
    t.startsWith(STUB_REPLY_PREFIX),
  );

  const runtimePath = join(getDataDir(), threadKey(channel, threadTs), 'runtime.json');
  // After the turn settles, runtime.json should exist (idle state with prompt).
  await waitFor(
    () => {
      try {
        readFileSync(runtimePath, 'utf8');
        return true;
      } catch {
        return false;
      }
    },
    { what: 'runtime.json exists after first turn', timeoutMs: 20_000 },
  );

  // Now /delete.
  await mention(tester, agent.botUserId, channel, threadTs, '/delete');
  await waitFor(
    () => {
      try {
        readFileSync(runtimePath, 'utf8');
        return false;
      } catch {
        return true;
      }
    },
    { what: 'runtime.json gone after /delete', timeoutMs: 20_000 },
  );
});

test.if(HAS_DOCKER)(
  'model can read_file a skill SKILL.md inside the sandbox (botspace copied into /workspace)',
  async () => {
    script.length = 0;
    calls.length = 0;
    // The host BOTSPACE_DIR only controls what the prompt builder sees,
    // not what the sandbox image carries. The shipped botspace (the repo's
    // `sandbox/botspace/`) is what got COPYed into the image. So we script
    // a read_file against the python-charts skill that the repo actually
    // ships.
    scriptReply({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_read',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: JSON.stringify({ path: 'skills/python-charts/SKILL.md' }),
          },
        },
      ],
    });
    scriptReply({ role: 'assistant', content: 'skill read' });

    const threadTs = await mention(
      tester,
      agent.botUserId,
      channel,
      undefined,
      `e2e-skills-read-${Date.now()}`,
    );
    createdThreads.push(threadTs);

    await waitForReply(tester, channel, threadTs, agent.botUserId, (t) => t === 'skill read');
    await waitFor(() => calls.length === 2, { what: 'two model calls', timeoutMs: 60_000 });

    const second = calls[1];
    if (!second) throw new Error('expected second call');
    const toolMsg = second.find((m) => m.role === 'tool' && m.tool_call_id === 'call_read');
    if (toolMsg?.role !== 'tool') throw new Error('expected read tool result');
    expect(toolMsg.content).toContain('name: python-charts');
    expect(toolMsg.content).toContain('Python charts');
  },
  90_000,
);
