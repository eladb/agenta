// Full git-backed agent home e2e test (WS-tunnel transport, phase 24).
//
// Migrated to the SDK harness + mock-model (#315 Phase A). The product behavior
// asserted is unchanged — the model emits a bash tool_call that runs `git push`
// from inside the sandbox over the per-session WS tunnel, exercising the bot's
// git server + pre-receive hook end-to-end. The only change is HOW the model
// side is driven: the bespoke `scriptedCallModel`/`script` queue is replaced by
// the mock-model server (`ANTHROPIC_BASE_URL`) scripted with `MockTurn[]`, and
// the rejected-push tool_result assertion now reads the mock's recorded request
// bodies (Anthropic shape) instead of a recorded `Message[]`.
//
// Drives the bot end-to-end through the per-session WS tunnel: the bot
// starts a per-session git HTTP server on loopback, opens a WS to the
// sandbox's /tunnel route, the sandbox-side multiplexer accepts the
// model's `git clone` / `git push` over loopback TCP inside the
// container, the traffic is framed back through the WS to the bot's git
// server, which spawns `git http-backend` against the agent-home working
// tree resolved from the per-channel home config (#87).
//
// No host sshd, no authorized_keys, no WireGuard — the test runs against
// any active sandbox provider with no opt-in beyond DOCKER_PROVIDER_ACTIVE.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { threadKey } from '../../src/tenant/runtime/thread';
import {
  type Agent,
  cleanupTempDataDir,
  DOCKER_PROVIDER_ACTIVE,
  deleteThread,
  type HomeConfigOverride,
  mention,
  requireEnv,
  safeShutdown,
  setupTempDataDir,
  startBotAndTenant,
  startTester,
  type Tester,
  waitForReply,
  withTempHomeConfig,
} from './helpers';

const TEST_TK_PREFIX = 'e2e-git-ah-';

if (!DOCKER_PROVIDER_ACTIVE) {
  test('git-agent-home e2e (skipped)', () => {
    console.log('[git-agent-home] skipped: SANDBOX_PROVIDER=docker is not active');
    expect(true).toBe(true);
  });
} else {
  let agent: Agent;
  let tester: Tester;
  let channel: string;
  let repoPath: string;
  let homeOverride: HomeConfigOverride;
  const createdThreadTs: string[] = [];

  function testThreadKey(): string {
    return `${TEST_TK_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  beforeAll(async () => {
    // Source-of-truth repo on the host. The prompt builder reads from
    // README.md + skills/; the per-session git HTTP server exports the
    // same working tree.
    repoPath = mkdtempSync(join(tmpdir(), 'agenta-e2e-git-ah-repo-'));
    spawnSync('git', ['init', '--initial-branch=main', repoPath]);
    spawnSync('git', ['-C', repoPath, 'config', 'user.email', 'e2e@agenta.test']);
    spawnSync('git', ['-C', repoPath, 'config', 'user.name', 'agenta-e2e']);
    writeFileSync(join(repoPath, 'README.md'), 'E2E TEST BOT BODY\n');
    spawnSync('git', ['-C', repoPath, 'add', 'README.md']);
    spawnSync('git', ['-C', repoPath, 'commit', '-m', 'initial']);
    // git http-backend refuses to receive-pack on a non-bare repo unless
    // http.receivepack is explicitly enabled.
    spawnSync('git', ['-C', repoPath, 'config', 'http.receivepack', 'true']);

    setupTempDataDir();
    // Override the e2e-default home (which points at an empty tmpdir)
    // with one that points at our seeded git repo. bootstrap.ts reads
    // `session.home` to drive the WS-tunneled clone — file:// transport
    // uses the URL pathname directly as the working tree.
    homeOverride = withTempHomeConfig(`file://${repoPath}`);

    channel = requireEnv('TEST_CHANNEL_ID');
    // SDK mode: the tenant runs the Agent SDK harness driven by the mock-model
    // server (returned as `agent.mock`); each test scripts it with setTurns.
    [agent, tester] = await Promise.all([
      startBotAndTenant(),
      startTester(),
    ]);
  }, 120_000);

  afterAll(async () => {
    for (const ts of createdThreadTs) {
      await deleteThread(tester, agent, channel, ts);
    }
    await safeShutdown(agent, tester);
    homeOverride.restore();
    cleanupTempDataDir();
    rmSync(repoPath, { recursive: true, force: true });
  }, 120_000);

  describe('git-backed agent home over WS tunnel', () => {
    test('mention triggers bootstrap; sandbox can clone and push back to allowed ref', async () => {
      const mock = agent.mock;
      if (!mock) throw new Error('expected SDK-mode mock handle');
      mock.reset();
      const tk = testThreadKey();
      // Round-trip: write + commit + push in the sandbox. The bash payload
      // exercises the git server end-to-end including the pre-receive hook
      // (which the bot's git server wires via core.hooksPath).
      const bashCmd = [
        'set -eu',
        'echo hello-from-sandbox > greeting.txt',
        'git add greeting.txt',
        'git commit -m test',
        'git push origin HEAD',
      ].join(' && ');
      // Turn 0: emit the bash tool_call. Turn 1: the continuation reply after
      // the push succeeds. (The mock-tool NAME is mcp__agenta-prefixed; the
      // JSONL records the bare 'bash' name.)
      mock.setTurns([
        {
          toolUses: [{ id: 'call_bash', name: 'mcp__agenta__bash', input: { command: bashCmd } }],
        },
        { text: 'pushed' },
      ]);

      const threadTs = await mention(
        tester,
        agent.botUserId,
        channel,
        undefined,
        `e2e-git-ah ${tk}`,
      );
      createdThreadTs.push(threadTs);

      await waitForReply(tester, channel, threadTs, agent.botUserId, (t) => t.includes('pushed'), {
        timeoutMs: 120_000,
      });

      // The push created the session ref + greeting.txt blob on the host
      // repo. The bot's bootstrap names the ref
      // refs/heads/agenta/sessions/<threadKey>, where threadKey(channel,
      // threadTs) = `${channel}__${threadTs.replace(/\./g, '_')}` (see
      // src/runtime/thread.ts).
      const sessionTk = threadKey(channel, threadTs);
      const log = spawnSync(
        'git',
        ['-C', repoPath, 'log', '--format=%s', '--all', `refs/heads/agenta/sessions/${sessionTk}`],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      expect(log.status).toBe(0);
      const messages = log.stdout.toString('utf8').trim().split('\n');
      expect(messages).toContain('test');

      const show = spawnSync(
        'git',
        ['-C', repoPath, 'show', `refs/heads/agenta/sessions/${sessionTk}:greeting.txt`],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      expect(show.status).toBe(0);
      expect(show.stdout.toString('utf8')).toContain('hello-from-sandbox');
    }, 180_000);

    test('pushing to a disallowed ref is rejected by pre-receive', async () => {
      const mock = agent.mock;
      if (!mock) throw new Error('expected SDK-mode mock handle');
      mock.reset();
      const tk = testThreadKey();
      const bashCmd = [
        'set -eu',
        'echo nope > evil.txt',
        'git add evil.txt',
        'git commit -m attempt',
        // explicit refspec to main, bypassing whatever HEAD currently points at.
        'git push origin HEAD:refs/heads/main',
      ].join(' && ');
      mock.setTurns([
        {
          toolUses: [{ id: 'call_bash', name: 'mcp__agenta__bash', input: { command: bashCmd } }],
        },
        { text: 'tried-and-failed' },
      ]);

      const threadTs = await mention(
        tester,
        agent.botUserId,
        channel,
        undefined,
        `e2e-git-ah-reject ${tk}`,
      );
      createdThreadTs.push(threadTs);

      await waitForReply(
        tester,
        channel,
        threadTs,
        agent.botUserId,
        (t) => t.includes('tried-and-failed'),
        { timeoutMs: 120_000 },
      );

      // The bash tool_result for the failing push includes the rejection
      // message from pre-receive. In the bespoke version this was read off the
      // second model call's `tool` message; here it's carried in the
      // continuation request body recorded by the mock. Find the request that
      // references the bash call id and assert its tool_result content matches
      // the pre-receive rejection.
      const flat = JSON.stringify(mock.requests);
      expect(flat).toContain('call_bash');
      expect(flat).toContain('tool_result');
      expect(flat).toMatch(/not allowed|rejected|pre-receive/i);
    }, 180_000);
  });
}
