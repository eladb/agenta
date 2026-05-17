import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallModel, Message } from '../../src/model/gateway';
import { threadKey } from '../../src/runtime/thread';
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

let agent: Agent;
let tester: Tester;
let channel: string;
const createdThreads: string[] = [];
let agentHomeDir: string;
let originalAgentHomeEnv: string | undefined;

const calls: Message[][] = [];

const scriptedCallModel: CallModel = async (messages) => {
  calls.push(messages);
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
};

beforeAll(async () => {
  // Build a fresh, isolated agent home dir so the test isn't affected by the
  // host's actual agent home contents. Point handler.ts at it via the
  // AGENT_HOME_DIR env var.
  agentHomeDir = mkdtempSync(join(tmpdir(), 'agenta-skills-'));
  writeFileSync(join(agentHomeDir, 'README.md'), 'INITIAL BOT BODY');
  originalAgentHomeEnv = process.env.AGENT_HOME_DIR;
  process.env.AGENT_HOME_DIR = agentHomeDir;

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
  if (originalAgentHomeEnv === undefined) delete process.env.AGENT_HOME_DIR;
  else process.env.AGENT_HOME_DIR = originalAgentHomeEnv;
  rmSync(agentHomeDir, { recursive: true, force: true });
});

test('two mentions in one thread -> system message is byte-identical (frozen prompt)', async () => {
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

  // Mutate README.md between the two mentions — the frozen prompt for this
  // thread must NOT pick up the change.
  writeFileSync(join(agentHomeDir, 'README.md'), 'MUTATED BOT BODY — should not appear');

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

  // And the frozen prompt is on disk in session.json.
  const runtimePath = join(getDataDir(), threadKey(channel, threadTs), 'session.json');
  const persisted = JSON.parse(readFileSync(runtimePath, 'utf8')) as {
    system_prompt?: string;
  };
  expect(persisted.system_prompt).toBe(sys1.content);
}, 120_000);

test('new thread after README.md edit -> system prompt reflects the new README.md', async () => {
  calls.length = 0;
  // Drop the mutated body into README.md (the previous test's mutation persists
  // here intentionally; if it doesn't, re-write it).
  writeFileSync(join(agentHomeDir, 'README.md'), 'NEW BOT BODY for new thread');

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

test('/delete removes session.json (and the rest of the thread dir)', async () => {
  calls.length = 0;

  const seed = `e2e-skills-delete-${Date.now()}`;
  const threadTs = await mention(tester, agent.botUserId, channel, undefined, seed);
  createdThreads.push(threadTs);
  await waitForReply(tester, channel, threadTs, agent.botUserId, (t) =>
    t.startsWith(STUB_REPLY_PREFIX),
  );

  const runtimePath = join(getDataDir(), threadKey(channel, threadTs), 'session.json');
  // After the turn settles, session.json should exist (idle state with prompt).
  await waitFor(
    () => {
      try {
        readFileSync(runtimePath, 'utf8');
        return true;
      } catch {
        return false;
      }
    },
    { what: 'session.json exists after first turn', timeoutMs: 20_000 },
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
    { what: 'session.json gone after /delete', timeoutMs: 20_000 },
  );
});

test('a skill in AGENT_HOME_DIR shows up in the system prompt for a new thread', async () => {
  calls.length = 0;

  // Drop a fresh skill into the host-side agent home BEFORE the next mention
  // — the prompt builder reads from the AGENT_HOME_DIR working tree
  // directly, so a new thread sees it. (Existing threads keep their frozen
  // prompt; see the "frozen prompt" test above.)
  mkdirSync(join(agentHomeDir, 'skills', 'demo-skill'), { recursive: true });
  writeFileSync(
    join(agentHomeDir, 'skills', 'demo-skill', 'SKILL.md'),
    [
      '---',
      'name: demo-skill',
      'description: A demo skill added by the e2e suite.',
      '---',
      '',
      'Body text for the demo skill.',
      '',
    ].join('\n'),
  );

  const seed = `e2e-skills-prompt-${Date.now()}`;
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
  // The composed prompt advertises skills as a JSON block. We assert
  // both the registration metadata and the path the model would read.
  expect(typeof sys.content === 'string' && sys.content).toContain('demo-skill');
  expect(typeof sys.content === 'string' && sys.content).toContain('skills/demo-skill/SKILL.md');
});
