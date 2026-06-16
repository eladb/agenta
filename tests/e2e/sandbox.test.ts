// Migrated to the SDK harness + mock-model (#315 Phase A). The product behavior
// asserted is unchanged — the model emits tool_calls, the bot runs them in the
// docker sandbox, the tool results round-trip back to the model, and the real
// sandbox effects (exit:0, file contents, cwd /home/sandbox, uid=1000, egress
// block, container teardown) hold — but the model is now driven by the
// mock-model server (ANTHROPIC_BASE_URL) scripted with MockTurn[] instead of the
// bespoke `scriptedCallModel`/`script` queue, and the tool_result assertions
// move from the recorded OpenAI-shape `Message[]` to the mock's recorded
// request bodies (Anthropic shape).
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { threadKey } from '../../src/tenant/runtime/thread';
import { containerName } from '../../src/tenant/sandbox';
import { ensureImage } from '../../src/tenant/sandbox/docker';
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

// These tests assert docker-specific behavior (egress block via iptables,
// container teardown, uid=1000 checks). Skip when the configured sandbox
// provider isn't docker — the same assertions don't hold on Fly.
const HAS_DOCKER = DOCKER_PROVIDER_ACTIVE;

// The in-container iptables egress block needs NET_ADMIN-level capabilities the
// GitHub Actions docker environment doesn't grant, so the rule never takes
// effect there and curl to an external host succeeds. The egress assertion is
// therefore only meaningful on a dev-box docker host — gate it on non-CI.
// (Surfaced by the #276 CD shakedown when CD moved e2e from fly to docker.)
const EGRESS_ENFORCEABLE = HAS_DOCKER && !process.env.CI;

let agent: Agent;
let tester: Tester;
let channel: string;
const createdThreads: string[] = [];

beforeAll(async () => {
  if (!HAS_DOCKER) return;
  setupTempDataDir();
  channel = requireEnv('TEST_CHANNEL_ID');
  // Lower the in-container /exec timeout so the timeout test doesn't take 60s.
  // docker.ts forwards this env to every container it launches.
  process.env.SANDBOX_EXEC_TIMEOUT_MS = '8000';
  // Build/pull the sandbox image up front so the first mention doesn't time out.
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
  'bash tool: model can execute a command in the sandbox container',
  async () => {
    const mock = agent.mock;
    if (!mock) throw new Error('expected SDK-mode mock handle');
    mock.reset();
    mock.setTurns([
      {
        toolUses: [
          {
            id: 'call_bash1',
            name: 'mcp__agenta__bash',
            input: { command: 'echo hello-from-sandbox && pwd' },
          },
        ],
      },
      { text: 'command finished' },
    ]);

    const threadTs = await mention(
      tester,
      agent.botUserId,
      channel,
      undefined,
      `e2e-bash-${Date.now()}`,
    );
    createdThreads.push(threadTs);

    await waitForReply(tester, channel, threadTs, agent.botUserId, (t) =>
      t.includes('command finished'),
    );
    await waitFor(() => mock.requests.length >= 2, { what: 'two model calls', timeoutMs: 30_000 });

    // The continuation request carries the bash tool_result for call_bash1: the
    // command output (exit: 0, echoed text, cwd) round-trips back to the model.
    const flat = JSON.stringify(mock.requests);
    expect(flat).toContain('call_bash1');
    expect(flat).toContain('tool_result');
    expect(flat).toContain('exit: 0');
    expect(flat).toContain('hello-from-sandbox');
    expect(flat).toContain('/home/sandbox');
  },
  120_000,
);

test.if(HAS_DOCKER)(
  'write_file then read_file: round-trips a text file in the sandbox',
  async () => {
    const mock = agent.mock;
    if (!mock) throw new Error('expected SDK-mode mock handle');
    mock.reset();
    const payload = `hello fs world ${Date.now()}`;

    mock.setTurns([
      {
        toolUses: [
          {
            id: 'call_write',
            name: 'mcp__agenta__write_file',
            input: { path: 'note.txt', content: payload },
          },
        ],
      },
      {
        toolUses: [
          {
            id: 'call_read',
            name: 'mcp__agenta__read_file',
            input: { path: 'note.txt' },
          },
        ],
      },
      { text: 'roundtrip done' },
    ]);

    const threadTs = await mention(
      tester,
      agent.botUserId,
      channel,
      undefined,
      `e2e-fs-${Date.now()}`,
    );
    createdThreads.push(threadTs);

    await waitForReply(tester, channel, threadTs, agent.botUserId, (t) =>
      t.includes('roundtrip done'),
    );
    await waitFor(() => mock.requests.length >= 3, {
      what: 'three model calls',
      timeoutMs: 30_000,
    });

    // The final continuation request carries both tool_results: the write result
    // ("wrote N chars") and the read result (the exact payload round-tripped).
    const flat = JSON.stringify(mock.requests);
    expect(flat).toContain('call_write');
    expect(flat).toContain('call_read');
    expect(flat).toContain(payload);
    expect(flat).toMatch(/wrote \d+ chars/);
  },
  120_000,
);

test.if(HAS_DOCKER)(
  'coding-agent toolchain: write_file -> bash(grep) -> edit_file -> read_file roundtrip',
  async () => {
    const mock = agent.mock;
    if (!mock) throw new Error('expected SDK-mode mock handle');
    mock.reset();
    const body = ['def greet(name):', '    # TODO: implement', '    pass', ''].join('\n');

    mock.setTurns([
      {
        toolUses: [
          {
            id: 'call_write',
            name: 'mcp__agenta__write_file',
            input: { path: 'app.py', content: body },
          },
        ],
      },
      {
        toolUses: [
          {
            // grep/glob tools were removed (#300); the agent greps via bash now.
            // `-Hn` forces the filename so the assertions below still see app.py.
            id: 'call_grep',
            name: 'mcp__agenta__bash',
            input: { command: 'grep -Hn TODO *.py' },
          },
        ],
      },
      {
        toolUses: [
          {
            id: 'call_edit',
            name: 'mcp__agenta__edit_file',
            input: {
              path: 'app.py',
              old_string: '    # TODO: implement\n    pass',
              new_string: '    return f"hello {name}"',
            },
          },
        ],
      },
      {
        toolUses: [
          {
            id: 'call_read',
            name: 'mcp__agenta__read_file',
            input: { path: 'app.py', offset: 1, limit: 2 },
          },
        ],
      },
      { text: 'toolchain done' },
    ]);

    const threadTs = await mention(
      tester,
      agent.botUserId,
      channel,
      undefined,
      `e2e-toolchain-${Date.now()}`,
    );
    createdThreads.push(threadTs);

    await waitForReply(tester, channel, threadTs, agent.botUserId, (t) =>
      t.includes('toolchain done'),
    );
    await waitFor(() => mock.requests.length >= 5, {
      what: 'five model calls',
      timeoutMs: 30_000,
    });

    // Every tool result round-trips back to the model in the recorded requests:
    // the grep hit (app.py + TODO), the edit confirmation, and the post-edit
    // read (offset=1,limit=2) showing the new file body without the TODO line.
    const flat = JSON.stringify(mock.requests);
    expect(flat).toContain('call_grep');
    expect(flat).toContain('app.py');
    expect(flat).toContain('TODO');
    expect(flat).toContain('call_edit');
    expect(flat).toMatch(/edited app\.py/);
    expect(flat).toContain('call_read');
    expect(flat).toContain('def greet(name):');
    expect(flat).toContain('return f\\"hello {name}\\"');
  },
  120_000,
);

test.if(HAS_DOCKER)(
  'bash runs as the unprivileged sandbox user (uid 1000), no caps',
  async () => {
    const mock = agent.mock;
    if (!mock) throw new Error('expected SDK-mode mock handle');
    mock.reset();
    mock.setTurns([
      {
        toolUses: [
          {
            id: 'call_whoami',
            name: 'mcp__agenta__bash',
            input: {
              command:
                'echo user=$(whoami) uid=$(id -u); echo "caps=$(cat /proc/self/status | grep CapEff | awk \'{print $2}\')"',
            },
          },
        ],
      },
      { text: 'identity checked' },
    ]);

    const threadTs = await mention(
      tester,
      agent.botUserId,
      channel,
      undefined,
      `e2e-nonroot-${Date.now()}`,
    );
    createdThreads.push(threadTs);

    await waitForReply(tester, channel, threadTs, agent.botUserId, (t) =>
      t.includes('identity checked'),
    );
    await waitFor(() => mock.requests.length >= 2, { what: 'two model calls', timeoutMs: 30_000 });

    const flat = JSON.stringify(mock.requests);
    expect(flat).toContain('user=sandbox');
    expect(flat).toContain('uid=1000');
    // CapEff = 0000000000000000 means "no effective capabilities".
    expect(flat).toMatch(/caps=0+/);
  },
  120_000,
);

test.if(HAS_DOCKER)(
  'bash live-streams stdout into the Slack checklist while running',
  async () => {
    const mock = agent.mock;
    if (!mock) throw new Error('expected SDK-mode mock handle');
    mock.reset();
    // Bash command runs ~4s, printing a line every second. Long enough for
    // the 800ms debounce to fire multiple checklist edits, short enough to
    // stay under the 8s SANDBOX_EXEC_TIMEOUT_MS this test file sets.
    mock.setTurns([
      {
        toolUses: [
          {
            id: 'call_stream',
            name: 'mcp__agenta__bash',
            input: { command: 'for i in 1 2 3 4; do echo step $i; sleep 1; done' },
          },
        ],
      },
      { text: 'stream done' },
    ]);

    const threadTs = await mention(
      tester,
      agent.botUserId,
      channel,
      undefined,
      `e2e-stream-${Date.now()}`,
    );
    createdThreads.push(threadTs);

    // Poll the checklist message until we see the live preview prefix on its
    // own line. The preview line starts with three spaces (see liveLine() in
    // turn.ts). Bail with a clear error if the command finishes before we
    // catch a streaming sample.
    let sawLivePreview = false;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const res = await tester.web.conversations.replies({ channel, ts: threadTs });
      const botMsg = (res.messages ?? []).find((m) => m.user === agent.botUserId);
      const text = botMsg?.text ?? '';
      // Look for a line that contains streamed step content but NOT the final
      // exit summary (which replaces the preview with "→ exit: 0").
      if (text.includes('step ') && !text.includes('→ exit')) {
        sawLivePreview = true;
        break;
      }
      if (text.startsWith('stream done')) break; // tool already done
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(sawLivePreview).toBe(true);

    // Now wait for the final model reply.
    await waitForReply(
      tester,
      channel,
      threadTs,
      agent.botUserId,
      (t) => t.includes('stream done'),
      { timeoutMs: 30_000 },
    );

    // And verify the recorded tool_result contains all the streamed lines.
    await waitFor(() => mock.requests.length >= 2, { what: 'two model calls', timeoutMs: 30_000 });
    const flat = JSON.stringify(mock.requests);
    for (const n of [1, 2, 3, 4]) {
      expect(flat).toContain(`step ${n}`);
    }
  },
  120_000,
);

test.if(HAS_DOCKER)(
  'bash command timeout: long-running command is killed and returns a clear marker',
  async () => {
    const mock = agent.mock;
    if (!mock) throw new Error('expected SDK-mode mock handle');
    mock.reset();
    // The container's exec timeout is set via SANDBOX_EXEC_TIMEOUT_MS in
    // beforeAll (8s for tests).
    mock.setTurns([
      {
        toolUses: [
          {
            id: 'call_sleep',
            name: 'mcp__agenta__bash',
            input: { command: 'sleep 300' },
          },
        ],
      },
      { text: 'slept' },
    ]);

    const threadTs = await mention(
      tester,
      agent.botUserId,
      channel,
      undefined,
      `e2e-timeout-${Date.now()}`,
    );
    createdThreads.push(threadTs);

    await waitForReply(tester, channel, threadTs, agent.botUserId, (t) => t.includes('slept'), {
      timeoutMs: 45_000,
    });
    await waitFor(() => mock.requests.length >= 2, { what: 'two model calls', timeoutMs: 45_000 });

    const flat = JSON.stringify(mock.requests);
    expect(flat).toContain('call_sleep');
    expect(flat).toContain('timed out');
  },
  120_000,
);

test.if(EGRESS_ENFORCEABLE)(
  'egress is blocked: curl to an external host fails inside the sandbox',
  async () => {
    const mock = agent.mock;
    if (!mock) throw new Error('expected SDK-mode mock handle');
    mock.reset();
    mock.setTurns([
      {
        toolUses: [
          {
            id: 'call_curl',
            name: 'mcp__agenta__bash',
            input: { command: 'curl --max-time 3 -sS https://example.com; echo "exit=$?"' },
          },
        ],
      },
      { text: 'curl attempted' },
    ]);

    const threadTs = await mention(
      tester,
      agent.botUserId,
      channel,
      undefined,
      `e2e-egress-${Date.now()}`,
    );
    createdThreads.push(threadTs);

    await waitForReply(tester, channel, threadTs, agent.botUserId, (t) =>
      t.includes('curl attempted'),
    );
    await waitFor(() => mock.requests.length >= 2, { what: 'two model calls', timeoutMs: 30_000 });

    // bash always exits 0 (we appended `echo "exit=$?"`); curl's own exit
    // should be non-zero (DNS or connect failure) and the body must not be
    // example.com HTML. The tool_result round-trips in the recorded request.
    const flat = JSON.stringify(mock.requests);
    expect(flat).toContain('call_curl');
    expect(flat).not.toContain('exit=0');
    expect(flat).not.toContain('<title>Example Domain');
  },
  120_000,
);

test.if(HAS_DOCKER)(
  '/delete removes the sandbox container',
  async () => {
    const mock = agent.mock;
    if (!mock) throw new Error('expected SDK-mode mock handle');
    mock.reset();
    // First mention only — no tools, just ensures the container is created.
    mock.setTurns([{ text: 'hi' }]);

    const threadTs = await mention(
      tester,
      agent.botUserId,
      channel,
      undefined,
      `e2e-delete-${Date.now()}`,
    );
    createdThreads.push(threadTs);
    await waitForReply(tester, channel, threadTs, agent.botUserId, (t) => t.includes('hi'));

    const cname = containerName(threadKey(channel, threadTs));
    await waitFor(
      () => spawnSync('docker', ['inspect', '-f', '{{.State.Status}}', cname]).status === 0,
      { what: 'container created', timeoutMs: 30_000 },
    );

    await mention(tester, agent.botUserId, channel, threadTs, '/delete');

    await waitFor(
      () => spawnSync('docker', ['inspect', '-f', '{{.State.Status}}', cname]).status !== 0,
      { what: 'container removed', timeoutMs: 30_000 },
    );

    const after = spawnSync('docker', ['inspect', '-f', '{{.State.Status}}', cname]);
    expect(after.status).not.toBe(0);
  },
  120_000,
);
