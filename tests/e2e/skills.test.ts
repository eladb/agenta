// Migrated to the SDK harness + mock-model (#315 Phase A). The product behavior
// asserted is unchanged — the composed system prompt reflects the home repo's
// README.md + skills/ working tree for each new thread, /delete removes the
// thread's session.json, and a new skill in AGENT_HOME_DIR shows up in the
// prompt — but the model is now driven by the mock-model server
// (ANTHROPIC_BASE_URL) scripted with MockTurn[] instead of the bespoke
// `scriptedCallModel`, and the SYSTEM-PROMPT assertions move from the recorded
// `Message[]` (calls[0][0].content) to the mock's recorded request bodies: the
// composed prompt is passed to the SDK as `options.systemPrompt` and appears in
// each request's `system` field.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { threadKey } from '../../src/tenant/runtime/thread';
import {
  type Agent,
  cleanupTempDataDir,
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
import type { MockModelHandle } from './mock-model';

let agent: Agent;
let tester: Tester;
let channel: string;
const createdThreads: string[] = [];
let agentHomeDir: string;
let originalAgentHomeEnv: string | undefined;

// Pull the recorded request `system` field as a string regardless of shape:
// the SDK passes `options.systemPrompt` as a string, so `request.system` is
// expected to be a string — but stay tolerant (an array of blocks would
// flatten to the same substring search) so the assertions don't hinge on the
// exact wire shape.
function systemText(req: unknown): string {
  // biome-ignore lint/suspicious/noExplicitAny: request body is untyped JSON
  const sys = (req as any)?.system;
  if (typeof sys === 'string') return sys;
  if (sys === undefined || sys === null) return '';
  return JSON.stringify(sys);
}

function someSystemIncludes(mock: MockModelHandle, needle: string): boolean {
  return mock.requests.some((r) => systemText(r).includes(needle));
}

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
  // SDK mode: the tenant runs the Agent SDK harness driven by the mock-model
  // server (returned as `agent.mock`); the callModel arg is unused.
  [agent, tester] = await Promise.all([
    startBotAndTenant(),
    startTester(),
  ]);
}, 120_000);

afterAll(async () => {
  for (const ts of createdThreads) {
    await deleteThread(tester, agent, channel, ts);
  }
  await safeShutdown(agent, tester);
  cleanupTempDataDir();
  if (originalAgentHomeEnv === undefined) delete process.env.AGENT_HOME_DIR;
  else process.env.AGENT_HOME_DIR = originalAgentHomeEnv;
  rmSync(agentHomeDir, { recursive: true, force: true });
}, 120_000);

// TODO(#103): re-enable once the second-mention-in-same-thread bug is fixed.
test.skip('two mentions in one thread -> system message is byte-identical (frozen prompt)', async () => {
  const mock = agent.mock;
  if (!mock) throw new Error('expected SDK-mode mock handle');
  mock.reset();
  // Two assistant turns across the two mentions; the mock picks by conversation
  // progress so each mention continues at the next index.
  mock.setTurns([{ text: 'first reply' }, { text: 'second reply' }]);

  const seed = `e2e-skills-freeze-${Date.now()}`;
  const threadTs = await mention(tester, agent.botUserId, channel, undefined, seed);
  createdThreads.push(threadTs);
  // Wait for the first model call (the mock records it) — more reliable than
  // waiting for the Slack reply round-trip.
  await waitFor(() => mock.requests.length >= 1, { what: 'first model call', timeoutMs: 30_000 });
  // And wait for the first reply too so Slack settles the thread before we send
  // the second mention.
  await waitForReply(tester, channel, threadTs, agent.botUserId, (t) => t.includes('first reply'));

  // Mutate README.md between the two mentions — the frozen prompt for this
  // thread must NOT pick up the change.
  writeFileSync(join(agentHomeDir, 'README.md'), 'MUTATED BOT BODY — should not appear');

  await mention(tester, agent.botUserId, channel, threadTs, `second-turn-${Date.now()}`);
  // Wait for the second reply (round-trip via the agent) — bounds the
  // wall-clock more reliably than just requests.length under Slack latency.
  await waitForReply(
    tester,
    channel,
    threadTs,
    agent.botUserId,
    (t) => t.includes('second reply'),
    { timeoutMs: 90_000 },
  );
  await waitFor(() => mock.requests.length >= 2, { what: 'two model calls', timeoutMs: 30_000 });

  // The composed system prompt is carried on each request's `system` field; the
  // two mentions must produce a byte-identical system prompt (frozen per thread).
  const first = mock.requests[0];
  const second = mock.requests[1];
  if (!first || !second) throw new Error('expected two recorded model calls');
  const sys1 = systemText(first);
  const sys2 = systemText(second);
  expect(sys1).toBe(sys2);
  expect(sys1).toContain('INITIAL BOT BODY');
  expect(sys1).not.toContain('MUTATED BOT BODY');

  // And the frozen prompt is on disk in session.json.
  const runtimePath = join(getDataDir(), threadKey(channel, threadTs), 'session.json');
  const persisted = JSON.parse(readFileSync(runtimePath, 'utf8')) as {
    system_prompt?: string;
  };
  expect(persisted.system_prompt).toBe(sys1);
}, 120_000);

test('new thread after README.md edit -> system prompt reflects the new README.md', async () => {
  const mock = agent.mock;
  if (!mock) throw new Error('expected SDK-mode mock handle');
  mock.reset();
  mock.setTurns([{ text: 'new-thread reply' }]);
  // Drop the mutated body into README.md (the previous test's mutation persists
  // here intentionally; if it doesn't, re-write it).
  writeFileSync(join(agentHomeDir, 'README.md'), 'NEW BOT BODY for new thread');

  const seed = `e2e-skills-new-${Date.now()}`;
  const threadTs = await mention(tester, agent.botUserId, channel, undefined, seed);
  createdThreads.push(threadTs);
  await waitForReply(tester, channel, threadTs, agent.botUserId, (t) =>
    t.includes('new-thread reply'),
  );
  await waitFor(() => mock.requests.length >= 1, { what: 'one model call', timeoutMs: 30_000 });

  // The new README body appears in the composed prompt carried on a request's
  // `system` field.
  expect(someSystemIncludes(mock, 'NEW BOT BODY for new thread')).toBe(true);
}, 120_000);

test('/delete removes session.json (and the rest of the thread dir)', async () => {
  // Higher per-test timeout: on the Fly provider, /delete's on-disk cleanup
  // waits for the Fly Machines DELETE roundtrip, which can take ~20s in CI.
  const mock = agent.mock;
  if (!mock) throw new Error('expected SDK-mode mock handle');
  mock.reset();
  mock.setTurns([{ text: 'delete-thread reply' }]);

  const seed = `e2e-skills-delete-${Date.now()}`;
  const threadTs = await mention(tester, agent.botUserId, channel, undefined, seed);
  createdThreads.push(threadTs);
  await waitForReply(tester, channel, threadTs, agent.botUserId, (t) =>
    t.includes('delete-thread reply'),
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
    // 90s: Fly machine destroy + volume detach occasionally creeps past
    // 60s (observed 62s in CD 2026-05-19 #43). Test wall clock is 120s.
    { what: 'session.json gone after /delete', timeoutMs: 90_000 },
  );
}, 120_000);

test('a skill in AGENT_HOME_DIR shows up in the system prompt for a new thread', async () => {
  const mock = agent.mock;
  if (!mock) throw new Error('expected SDK-mode mock handle');
  mock.reset();
  mock.setTurns([{ text: 'skill-prompt reply' }]);

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
    t.includes('skill-prompt reply'),
  );
  await waitFor(() => mock.requests.length >= 1, { what: 'one model call', timeoutMs: 30_000 });

  // The composed prompt advertises skills as a JSON block on the request's
  // `system` field. We assert both the registration metadata and the path the
  // model would read.
  expect(someSystemIncludes(mock, 'demo-skill')).toBe(true);
  expect(someSystemIncludes(mock, 'skills/demo-skill/SKILL.md')).toBe(true);
}, 120_000);
