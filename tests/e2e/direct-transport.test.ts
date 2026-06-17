// Direct SSH transport e2e test (#88).
//
// Migrated to the SDK harness + mock-model (#315 Phase A). The product behavior
// asserted is unchanged — the model emits a bash tool_call that runs `git push`
// over the direct SSH transport, and we verify the session branch lands on the
// configured GitHub repo — but the model is now driven by the mock-model server
// (ANTHROPIC_BASE_URL) scripted with MockTurn[] instead of the bespoke
// `scriptedCallModel`/`script` queue. The direct-mode home setup
// (withTempHomeConfig + deploy-key wiring) and the host-side git verification are
// harness-independent and stay verbatim.
//
// Gated on `AGENTA_DIRECT_TEST_DEPLOY_KEY` — a PEM-formatted SSH private
// key that has read+write on whatever GitHub repo
// `AGENTA_DIRECT_TEST_REPO` points at. When the env vars aren't set the
// suite logs a skip message and exits cleanly so default `bun run e2e`
// runs aren't blocked.
//
// What this test exercises end-to-end:
//   1. Configure a `default` home with an `ssh://` / `git@…` remote and a
//      deploy-key env var.
//   2. Mention the agent and run a scripted turn that ends in `git push
//      origin HEAD`.
//   3. Verify the session branch lands on the configured GitHub repo
//      using a parallel host-side clone (using the same deploy key).
//
// Cleanup deletes the session branch on the remote afterwards so reruns
// stay clean.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
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

const DEPLOY_KEY = process.env.AGENTA_DIRECT_TEST_DEPLOY_KEY;
const REMOTE = process.env.AGENTA_DIRECT_TEST_REPO; // e.g. git@github.com:eladb/agenta-direct-e2e.git
const SHOULD_RUN = Boolean(DEPLOY_KEY && REMOTE && DOCKER_PROVIDER_ACTIVE);

const AUTH_ENV = 'AGENTA_DIRECT_TEST_DEPLOY_KEY';
const TEST_TK_PREFIX = 'e2e-direct-';

if (!SHOULD_RUN) {
  test('direct-transport e2e (skipped)', () => {
    if (!DOCKER_PROVIDER_ACTIVE) {
      console.log('[direct-transport] skipped: SANDBOX_PROVIDER=docker is not active');
    } else if (!DEPLOY_KEY) {
      console.log('[direct-transport] skipped: AGENTA_DIRECT_TEST_DEPLOY_KEY is not set');
    } else if (!REMOTE) {
      console.log('[direct-transport] skipped: AGENTA_DIRECT_TEST_REPO is not set');
    }
    expect(true).toBe(true);
  });
} else {
  let agent: Agent;
  let tester: Tester;
  let channel: string;
  let homeOverride: HomeConfigOverride;
  let keyFile: string;
  const createdThreadTs: string[] = [];
  const sessionRefsToDelete: string[] = [];

  function testThreadKey(): string {
    return `${TEST_TK_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  // Run a git command against the remote using the deploy key + the
  // bundled known_hosts file. Returns the result so the caller can
  // assert on stdout/exit.
  function gitWithKey(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const knownHosts = join(import.meta.dir, '..', '..', 'git-hooks', 'known_hosts');
    const env = {
      ...process.env,
      GIT_SSH_COMMAND: `ssh -i ${keyFile} -o IdentitiesOnly=yes -o UserKnownHostsFile=${knownHosts} -o StrictHostKeyChecking=yes`,
    };
    const r = spawnSync('git', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    return {
      status: r.status,
      stdout: r.stdout?.toString('utf8') ?? '',
      stderr: r.stderr?.toString('utf8') ?? '',
    };
  }

  beforeAll(async () => {
    // Stash the deploy key + remote in a tmp dir so we can use it from
    // the host side for verification. The bot reads the PEM from env at
    // bootstrap time; we only need it on disk for our own git calls.
    const tmp = mkdtempSync(join(tmpdir(), 'agenta-e2e-direct-'));
    keyFile = join(tmp, 'id_ed25519');
    writeFileSync(keyFile, DEPLOY_KEY ?? '', { mode: 0o600 });

    // Set the env var the home config references.
    process.env[AUTH_ENV] = DEPLOY_KEY;

    setupTempDataDir();
    homeOverride = withTempHomeConfig(REMOTE ?? '', AUTH_ENV);

    channel = requireEnv('TEST_CHANNEL_ID');
    // SDK mode: the tenant runs the Agent SDK harness driven by the mock-model
    // server (returned as `agent.mock`); the callModel arg is unused.
    [agent, tester] = await Promise.all([
      startBotAndTenant(),
      startTester(),
    ]);

    // Make sure we start from a known-good remote state (the README must
    // exist for the agent's prompt builder, which clones the mirror on
    // boot via entrypoint.sh — for tests it short-circuits since we go
    // through the in-process startBotAndTenant path).
    const probe = gitWithKey(['ls-remote', REMOTE ?? '', 'HEAD']);
    if (probe.status !== 0) {
      throw new Error(
        `direct-transport e2e setup: ls-remote failed (${probe.status}): ${probe.stderr}`,
      );
    }
  }, 120_000);

  afterAll(async () => {
    for (const ts of createdThreadTs) {
      await deleteThread(tester, agent, channel, ts);
    }
    await safeShutdown(agent, tester);
    homeOverride.restore();
    cleanupTempDataDir();
    delete process.env[AUTH_ENV];

    // Delete any session refs we created on the remote so reruns stay
    // clean. Failures here aren't fatal — surfaces as warnings.
    for (const ref of sessionRefsToDelete) {
      const r = gitWithKey(['push', REMOTE ?? '', `:${ref}`]);
      if (r.status !== 0) {
        console.warn(`[direct-transport] failed to delete ${ref}: ${r.stderr}`);
      }
    }
  }, 120_000);

  describe('direct SSH transport', () => {
    test('mention triggers direct bootstrap; sandbox commits + pushes session branch to GitHub', async () => {
      const mock = agent.mock;
      if (!mock) throw new Error('expected SDK-mode mock handle');
      mock.reset();

      const tk = testThreadKey();
      const bashCmd = [
        'set -eu',
        `echo direct-e2e-${tk} > greeting.txt`,
        'git add greeting.txt',
        'git commit -m e2e-direct',
        'git push origin HEAD',
      ].join(' && ');
      // Turn 0: emit the bash tool_call that pushes over SSH. Turn 1: the
      // continuation reply after the tool result.
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
        `e2e-direct ${tk}`,
      );
      createdThreadTs.push(threadTs);

      await waitForReply(tester, channel, threadTs, agent.botUserId, (t) => t.includes('pushed'), {
        timeoutMs: 180_000,
      });

      // Verify the session ref appears on GitHub via ls-remote.
      const sessionTk = threadKey(channel, threadTs);
      const refName = `refs/heads/agenta/sessions/${sessionTk}`;
      sessionRefsToDelete.push(refName);

      const ls = gitWithKey(['ls-remote', REMOTE ?? '', refName]);
      expect(ls.status).toBe(0);
      expect(ls.stdout).toContain(refName);
    }, 240_000);
  });
}
