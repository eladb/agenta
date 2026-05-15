// Full git-backed-botspace e2e test.
//
// This test drives the bot end-to-end through the per-session SSH bootstrap:
// generate keypair on the host -> drop an authorized_keys line -> sandbox
// shallow-clones the configured repo over SSH -> the model runs `git push`
// back to the host, which routes via agenta-git-shell and is enforced by
// `git-hooks/pre-receive`.
//
// **Opt-in only.** This test touches the REAL `~/.ssh/authorized_keys` of
// the user running the test, because the host's sshd is what the sandbox
// connects back to and sshd reads the real file (not anything we can
// override per-process). We tag every line we add with
// `agenta-<test_thread_key>` and clean up rigorously, but a crashed test
// COULD leave one tagged line behind. To remove a leak by hand:
//
//   grep -v ' agenta-e2e-test-' ~/.ssh/authorized_keys > /tmp/ak && \
//     mv /tmp/ak ~/.ssh/authorized_keys
//
// To run this test you must set `AGENTA_TEST_SSHD_OPT_IN=1`. Without it
// every test in this file is skipped with a `console.log` line explaining
// how to opt in.
//
// Additionally requires:
//   - DOCKER_PROVIDER_ACTIVE (docker installed AND SANDBOX_PROVIDER=docker)
//   - SSHD_REACHABLE (localhost:22 answers to BatchMode ssh)

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeEntry as removeAuthorizedKeysEntry } from '../../src/git/authorized-keys';
import { stopTunnel } from '../../src/git/tunnel';
import type { AssistantMessage, CallModel, Message } from '../../src/model/gateway';
import { removeContainer } from '../../src/sandbox';
import {
  type Agent,
  cleanupTempDataDir,
  DOCKER_PROVIDER_ACTIVE,
  deleteThread,
  FLY_TUNNEL_ACTIVE,
  mention,
  requireEnv,
  SSHD_REACHABLE,
  STUB_REPLY_PREFIX,
  setupTempDataDir,
  shutdown,
  startAgent,
  startTester,
  type Tester,
  waitForReply,
} from './helpers';

const OPT_IN = process.env.AGENTA_TEST_SSHD_OPT_IN === '1';
const CAN_RUN = DOCKER_PROVIDER_ACTIVE && SSHD_REACHABLE && OPT_IN;

const TEST_TK_PREFIX = 'e2e-git-bs-';

if (!CAN_RUN) {
  test('git-botspace e2e (skipped)', () => {
    const reasons: string[] = [];
    if (!DOCKER_PROVIDER_ACTIVE) reasons.push('SANDBOX_PROVIDER=docker is not active');
    if (!SSHD_REACHABLE) reasons.push('localhost sshd not reachable via BatchMode');
    if (!OPT_IN) reasons.push('AGENTA_TEST_SSHD_OPT_IN=1 not set');
    console.log(
      `[git-botspace] skipped: ${reasons.join('; ')}.\n` +
        '  Opt in by exporting AGENTA_TEST_SSHD_OPT_IN=1 — the test will add and\n' +
        `  remove agenta-<thread_key> lines tagged with the prefix '${TEST_TK_PREFIX}'\n` +
        '  to your REAL ~/.ssh/authorized_keys.',
    );
    expect(true).toBe(true);
  });
} else {
  // Real-flow path. Everything below this point only runs under opt-in.
  let agent: Agent;
  let tester: Tester;
  let channel: string;
  let repoPath: string;
  let _botspaceDir: string;
  let originalRepoPathEnv: string | undefined;
  let originalAuthKeysEnv: string | undefined;
  const createdThreadKeys = new Set<string>();
  const createdThreadTs: string[] = [];
  const realAuthorizedKeys = join(homedir(), '.ssh', 'authorized_keys');

  const calls: Message[][] = [];
  // The model script returns one assistant message per call. Tests push
  // these into the queue before mentioning.
  const script: AssistantMessage[] = [];
  const scriptedCallModel: CallModel = async (messages) => {
    calls.push(messages);
    const next = script.shift();
    if (next) return next;
    // Default tail: echo, so the turn terminates.
    return { role: 'assistant', content: 'done' };
  };

  function testThreadKey(): string {
    return `${TEST_TK_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  async function cleanupAuthorizedKeysEntries(): Promise<void> {
    // Sweep every line we know we tagged. Best-effort — file may have been
    // touched out-of-band, but removeEntry preserves unrelated lines.
    for (const tk of createdThreadKeys) {
      await removeAuthorizedKeysEntry(tk).catch(() => {});
    }
  }

  // Belt-and-suspenders: register a process exit hook so even an
  // unexpected crash inside beforeAll/afterAll leaves the user's
  // authorized_keys clean. node's `exit` handler is sync; we read the
  // file inline and rewrite filtered.
  function exitHook(): void {
    if (!existsSync(realAuthorizedKeys)) return;
    try {
      const body = readFileSync(realAuthorizedKeys, 'utf8');
      const filtered = body
        .split('\n')
        .filter((l) => {
          for (const tk of createdThreadKeys) {
            if (l.endsWith(` agenta-${tk}`)) return false;
          }
          return true;
        })
        .join('\n');
      if (filtered !== body) writeFileSync(realAuthorizedKeys, filtered, { mode: 0o600 });
    } catch {
      // Best effort; nothing more we can do here.
    }
  }
  process.on('exit', exitHook);

  beforeAll(async () => {
    // Set up a non-bare repo with a README + skill. This is the bot's
    // "source of truth" — the prompt builder reads from it and the sandbox
    // clones from it via SSH.
    repoPath = mkdtempSync(join(tmpdir(), 'agenta-e2e-git-bs-repo-'));
    spawnSync('git', ['init', repoPath]);
    spawnSync('git', ['-C', repoPath, 'config', 'user.email', 'e2e@agenta.test']);
    spawnSync('git', ['-C', repoPath, 'config', 'user.name', 'agenta-e2e']);
    writeFileSync(join(repoPath, 'README.md'), 'E2E TEST BOT BODY\n');
    spawnSync('git', ['-C', repoPath, 'add', 'README.md']);
    spawnSync('git', ['-C', repoPath, 'commit', '-m', 'initial']);

    // The host-side `buildSystemPrompt` reads BOTSPACE_DIR ?? AGENTA_REPO_PATH.
    // We need to point it at the same tree.
    _botspaceDir = repoPath;
    originalRepoPathEnv = process.env.AGENTA_REPO_PATH;
    process.env.AGENTA_REPO_PATH = repoPath;
    originalAuthKeysEnv = process.env.AGENTA_AUTHORIZED_KEYS_PATH;
    // CRITICAL: opt-in path — point at the REAL authorized_keys so sshd
    // actually accepts the keys we register.
    process.env.AGENTA_AUTHORIZED_KEYS_PATH = realAuthorizedKeys;

    setupTempDataDir();
    channel = requireEnv('TEST_CHANNEL_ID');
    [agent, tester] = await Promise.all([startAgent(scriptedCallModel), startTester()]);
  });

  afterEach(async () => {
    await cleanupAuthorizedKeysEntries();
  });

  afterAll(async () => {
    await cleanupAuthorizedKeysEntries();
    for (const ts of createdThreadTs) {
      await deleteThread(tester, agent, channel, ts);
    }
    await shutdown(agent, tester);
    cleanupTempDataDir();
    rmSync(repoPath, { recursive: true, force: true });
    if (originalRepoPathEnv === undefined) delete process.env.AGENTA_REPO_PATH;
    else process.env.AGENTA_REPO_PATH = originalRepoPathEnv;
    if (originalAuthKeysEnv === undefined) delete process.env.AGENTA_AUTHORIZED_KEYS_PATH;
    else process.env.AGENTA_AUTHORIZED_KEYS_PATH = originalAuthKeysEnv;
    process.removeListener('exit', exitHook);
  });

  describe('git-backed botspace (opt-in)', () => {
    test('mention triggers bootstrap; sandbox can clone and push back to allowed ref', async () => {
      const tk = testThreadKey();
      createdThreadKeys.add(tk);
      // The bash payload exercises the read+write side of the bootstrap
      // and round-trips through pre-receive: write a file in the cloned
      // repo, commit, push to HEAD (which the bootstrap put on
      // agenta/sessions/<thread_key>).
      const bashCmd = [
        'set -eu',
        'echo hello-from-sandbox > greeting.txt',
        'git add greeting.txt',
        'git commit -m test',
        'git push origin HEAD',
      ].join(' && ');
      script.push({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_bash',
            type: 'function',
            function: { name: 'bash', arguments: JSON.stringify({ command: bashCmd }) },
          },
        ],
      });
      script.push({ role: 'assistant', content: 'pushed' });

      const threadTs = await mention(
        tester,
        agent.botUserId,
        channel,
        undefined,
        `e2e-git-bs ${tk}`,
      );
      createdThreadTs.push(threadTs);

      // The model's second turn returns plain text 'pushed' as the final
      // reply. waitForReply confirms the agent completed both turns.
      await waitForReply(
        tester,
        channel,
        threadTs,
        agent.botUserId,
        (t) => t === 'pushed' || t.startsWith(STUB_REPLY_PREFIX),
        { timeoutMs: 120_000 },
      );

      // The push must have created the ref + the greeting.txt blob on the
      // host repo. The repo is non-bare, so check `git log --all` for the
      // commit message.
      const log = spawnSync(
        'git',
        ['-C', repoPath, 'log', '--format=%s', '--all', `refs/heads/agenta/sessions/${tk}`],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const messages = log.stdout.toString('utf8').trim().split('\n');
      expect(messages).toContain('test');

      // The blob lands in the tree at refs/heads/agenta/sessions/<tk>:greeting.txt.
      const show = spawnSync(
        'git',
        ['-C', repoPath, 'show', `refs/heads/agenta/sessions/${tk}:greeting.txt`],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      expect(show.status).toBe(0);
      expect(show.stdout.toString('utf8')).toContain('hello-from-sandbox');

      // authorized_keys carries the tagged line WHILE the thread is alive.
      const body = readFileSync(realAuthorizedKeys, 'utf8');
      expect(body).toContain(`agenta-${tk}`);

      // /delete removes the entry.
      await mention(tester, agent.botUserId, channel, threadTs, '/delete');
      // Poll for line removal — /delete is async on the agent side.
      const deadline = Date.now() + 30_000;
      let cleaned = false;
      while (Date.now() < deadline) {
        const after = readFileSync(realAuthorizedKeys, 'utf8');
        if (!after.includes(`agenta-${tk}`)) {
          cleaned = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(cleaned).toBe(true);
      createdThreadKeys.delete(tk); // already cleaned
    }, 180_000);

    test('pushing to a disallowed ref is rejected by pre-receive', async () => {
      const tk = testThreadKey();
      createdThreadKeys.add(tk);
      // Try to push to refs/heads/main — the pre-receive hook should
      // reject this and `git push` returns non-zero. The model receives the
      // failed tool_result and we move on.
      const bashCmd = [
        'set -eu',
        'echo nope > evil.txt',
        'git add evil.txt',
        'git commit -m attempt',
        // explicit refspec to main, bypassing whatever HEAD currently points at.
        'git push origin HEAD:refs/heads/main',
      ].join(' && ');
      script.push({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_bash',
            type: 'function',
            function: { name: 'bash', arguments: JSON.stringify({ command: bashCmd }) },
          },
        ],
      });
      script.push({ role: 'assistant', content: 'tried-and-failed' });

      const threadTs = await mention(
        tester,
        agent.botUserId,
        channel,
        undefined,
        `e2e-git-bs-reject ${tk}`,
      );
      createdThreadTs.push(threadTs);

      await waitForReply(
        tester,
        channel,
        threadTs,
        agent.botUserId,
        (t) => t === 'tried-and-failed' || t.startsWith(STUB_REPLY_PREFIX),
        { timeoutMs: 120_000 },
      );

      // The tool_result for the bash call should be visible in calls[1]
      // (the second model invocation, which receives the prior call's
      // output). Find the rejection text.
      const second = calls[calls.length - 1];
      if (!second) throw new Error('expected a second model call');
      const toolMsg = second.find((m) => m.role === 'tool' && m.tool_call_id === 'call_bash');
      if (toolMsg?.role !== 'tool') throw new Error('expected bash tool result');
      // pre-receive prints "ref '...' is not allowed (only '...')" on stderr.
      // bash's tool result includes stderr.
      expect(toolMsg.content).toMatch(/not allowed|rejected|pre-receive/i);

      // No new ref was created on the host repo.
      const refs = spawnSync('git', ['-C', repoPath, 'show-ref', '--heads'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const refsText = refs.stdout.toString('utf8');
      expect(refsText).not.toContain('evil.txt'); // sanity — just no match
    }, 180_000);
  });
}

// ---------------------------------------------------------------------------
// Phase 23: Fly path with the reverse-SSH tunnel.
//
// Same shape as the docker path above, but uses the per-thread autossh
// tunnel into the sandbox (via the user's WireGuard mesh) instead of
// host.docker.internal.
//
// To run this block end-to-end the operator must:
//   1. Run `bun run setup-tunnel` (one-time): generates the Mac-side
//      ed25519 keypair and creates a Fly WireGuard peer for this Mac.
//   2. Import the generated `agenta-mac.conf` into the macOS WireGuard
//      app and activate the tunnel — `ping6 fdaa::1` must succeed.
//   3. Set SANDBOX_PROVIDER=fly + FLY_API_TOKEN + FLY_APP_NAME in env.
//   4. Set AGENTA_TEST_TUNNEL_OPT_IN=1.
//
// The test creates a fresh Fly machine per case (slow — ~30–60s of
// provisioning + image pull) and cleans up after itself: stops the
// tunnel, /delete-s the thread (which removes the Fly machine + volume
// + authorized_keys line). Like the docker case it also touches the
// real ~/.ssh/authorized_keys — same TEST_TK_PREFIX-based cleanup
// machinery applies.
// ---------------------------------------------------------------------------

if (FLY_TUNNEL_ACTIVE) {
  let agentFly: Agent;
  let testerFly: Tester;
  let channelFly: string;
  let repoPathFly: string;
  let originalRepoPathEnvFly: string | undefined;
  let originalAuthKeysEnvFly: string | undefined;
  const createdTkFly = new Set<string>();
  const createdTsFly: string[] = [];
  const realAuthorizedKeysFly = join(homedir(), '.ssh', 'authorized_keys');

  const callsFly: Message[][] = [];
  const scriptFly: AssistantMessage[] = [];
  const scriptedCallModelFly: CallModel = async (messages) => {
    callsFly.push(messages);
    const next = scriptFly.shift();
    if (next) return next;
    return { role: 'assistant', content: 'done' };
  };

  function testTkFly(): string {
    return `e2e-git-bs-fly-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  async function cleanupAuthKeysFly(): Promise<void> {
    for (const tk of createdTkFly) {
      await removeAuthorizedKeysEntry(tk).catch(() => {});
    }
  }

  function exitHookFly(): void {
    if (!existsSync(realAuthorizedKeysFly)) return;
    try {
      const body = readFileSync(realAuthorizedKeysFly, 'utf8');
      const filtered = body
        .split('\n')
        .filter((l) => {
          for (const tk of createdTkFly) if (l.endsWith(` agenta-${tk}`)) return false;
          return true;
        })
        .join('\n');
      if (filtered !== body) writeFileSync(realAuthorizedKeysFly, filtered, { mode: 0o600 });
    } catch {
      // best-effort
    }
  }
  process.on('exit', exitHookFly);

  beforeAll(async () => {
    repoPathFly = mkdtempSync(join(tmpdir(), 'agenta-e2e-git-bs-fly-repo-'));
    spawnSync('git', ['init', repoPathFly]);
    spawnSync('git', ['-C', repoPathFly, 'config', 'user.email', 'e2e@agenta.test']);
    spawnSync('git', ['-C', repoPathFly, 'config', 'user.name', 'agenta-e2e']);
    writeFileSync(join(repoPathFly, 'README.md'), 'E2E TEST BOT BODY (fly)\n');
    spawnSync('git', ['-C', repoPathFly, 'add', 'README.md']);
    spawnSync('git', ['-C', repoPathFly, 'commit', '-m', 'initial']);

    originalRepoPathEnvFly = process.env.AGENTA_REPO_PATH;
    process.env.AGENTA_REPO_PATH = repoPathFly;
    originalAuthKeysEnvFly = process.env.AGENTA_AUTHORIZED_KEYS_PATH;
    process.env.AGENTA_AUTHORIZED_KEYS_PATH = realAuthorizedKeysFly;

    setupTempDataDir();
    channelFly = requireEnv('TEST_CHANNEL_ID');
    [agentFly, testerFly] = await Promise.all([startAgent(scriptedCallModelFly), startTester()]);
  });

  afterEach(async () => {
    await cleanupAuthKeysFly();
  });

  afterAll(async () => {
    await cleanupAuthKeysFly();
    // Tear down tunnels we spawned, then the Fly machines themselves via
    // /delete equivalent operations on each thread.
    for (const tk of createdTkFly) {
      await stopTunnel(tk).catch(() => {});
      await removeContainer(tk).catch(() => {});
    }
    for (const ts of createdTsFly) {
      await deleteThread(testerFly, agentFly, channelFly, ts);
    }
    await shutdown(agentFly, testerFly);
    cleanupTempDataDir();
    rmSync(repoPathFly, { recursive: true, force: true });
    if (originalRepoPathEnvFly === undefined) delete process.env.AGENTA_REPO_PATH;
    else process.env.AGENTA_REPO_PATH = originalRepoPathEnvFly;
    if (originalAuthKeysEnvFly === undefined) delete process.env.AGENTA_AUTHORIZED_KEYS_PATH;
    else process.env.AGENTA_AUTHORIZED_KEYS_PATH = originalAuthKeysEnvFly;
    process.removeListener('exit', exitHookFly);
  });

  describe('git-backed botspace on Fly (opt-in)', () => {
    test('mention triggers tunneled bootstrap; sandbox can push back via the reverse tunnel', async () => {
      const tk = testTkFly();
      createdTkFly.add(tk);
      const bashCmd = [
        'set -eu',
        'echo hello-from-fly-sandbox > greeting.txt',
        'git add greeting.txt',
        'git commit -m test-fly',
        'git push origin HEAD',
      ].join(' && ');
      scriptFly.push({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_bash',
            type: 'function',
            function: { name: 'bash', arguments: JSON.stringify({ command: bashCmd }) },
          },
        ],
      });
      scriptFly.push({ role: 'assistant', content: 'pushed' });

      const threadTs = await mention(
        testerFly,
        agentFly.botUserId,
        channelFly,
        undefined,
        `e2e-git-bs-fly ${tk}`,
      );
      createdTsFly.push(threadTs);

      await waitForReply(
        testerFly,
        channelFly,
        threadTs,
        agentFly.botUserId,
        (t) => t === 'pushed' || t.startsWith(STUB_REPLY_PREFIX),
        // Fly machine provisioning is slower than Docker; bump generously.
        { timeoutMs: 240_000 },
      );

      const log = spawnSync(
        'git',
        ['-C', repoPathFly, 'log', '--format=%s', '--all', `refs/heads/agenta/sessions/${tk}`],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      expect(log.stdout.toString('utf8').trim().split('\n')).toContain('test-fly');

      const show = spawnSync(
        'git',
        ['-C', repoPathFly, 'show', `refs/heads/agenta/sessions/${tk}:greeting.txt`],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      expect(show.status).toBe(0);
      expect(show.stdout.toString('utf8')).toContain('hello-from-fly-sandbox');

      const body = readFileSync(realAuthorizedKeysFly, 'utf8');
      expect(body).toContain(`agenta-${tk}`);
    }, 300_000);
  });
} else if (process.env.SANDBOX_PROVIDER === 'fly') {
  // If we're on Fly but the operator hasn't opted into the tunnel test,
  // emit a hint so they know how.
  test('git-botspace on Fly (skipped)', () => {
    console.log(
      '[git-botspace fly] skipped. Opt in by:\n' +
        '  1. bun run setup-tunnel\n' +
        '  2. import + activate ./agenta-mac.conf in WireGuard.app\n' +
        '  3. export AGENTA_TEST_TUNNEL_OPT_IN=1 SANDBOX_PROVIDER=fly FLY_API_TOKEN=…',
    );
    expect(true).toBe(true);
  });
}
