import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import type { AssistantMessage, CallModel, Message } from '../../src/tenant/model/gateway';
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

let agent: Agent;
let tester: Tester;
let channel: string;
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

beforeAll(async () => {
  if (!HAS_DOCKER) return;
  setupTempDataDir();
  channel = requireEnv('TEST_CHANNEL_ID');
  // Lower the in-container /exec timeout so the timeout test doesn't take 60s.
  // docker.ts forwards this env to every container it launches.
  process.env.SANDBOX_EXEC_TIMEOUT_MS = '8000';
  // Build/pull the sandbox image up front so the first mention doesn't time out.
  await ensureImage();
  [agent, tester] = await Promise.all([startBotAndTenant(scriptedCallModel), startTester()]);
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
    script.length = 0;
    calls.length = 0;

    scriptReply({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_bash1',
          type: 'function',
          function: {
            name: 'bash',
            arguments: JSON.stringify({ command: 'echo hello-from-sandbox && pwd' }),
          },
        },
      ],
    });
    scriptReply({ role: 'assistant', content: 'command finished' });

    const threadTs = await mention(
      tester,
      agent.botUserId,
      channel,
      undefined,
      `e2e-bash-${Date.now()}`,
    );
    createdThreads.push(threadTs);

    await waitForReply(tester, channel, threadTs, agent.botUserId, (t) => t === 'command finished');
    await waitFor(() => calls.length === 2, { what: 'two model calls', timeoutMs: 30_000 });

    const second = calls[1];
    if (!second) throw new Error('expected second call');
    const toolMsg = second.find((m) => m.role === 'tool');
    if (toolMsg?.role !== 'tool') throw new Error('expected tool msg');
    expect(toolMsg.content).toContain('exit: 0');
    expect(toolMsg.content).toContain('hello-from-sandbox');
    expect(toolMsg.content).toContain('/home/sandbox');
  },
  60_000,
);

test.if(HAS_DOCKER)(
  'write_file then read_file: round-trips a text file in the sandbox',
  async () => {
    script.length = 0;
    calls.length = 0;
    const payload = `hello fs world ${Date.now()}`;

    scriptReply({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_write',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: JSON.stringify({ path: 'note.txt', content: payload }),
          },
        },
      ],
    });
    scriptReply({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_read',
          type: 'function',
          function: { name: 'read_file', arguments: JSON.stringify({ path: 'note.txt' }) },
        },
      ],
    });
    scriptReply({ role: 'assistant', content: 'roundtrip done' });

    const threadTs = await mention(
      tester,
      agent.botUserId,
      channel,
      undefined,
      `e2e-fs-${Date.now()}`,
    );
    createdThreads.push(threadTs);

    await waitForReply(tester, channel, threadTs, agent.botUserId, (t) => t === 'roundtrip done');
    await waitFor(() => calls.length === 3, { what: 'three model calls', timeoutMs: 30_000 });

    const third = calls[2];
    if (!third) throw new Error('expected third call');
    const readToolMsg = third.find((m) => m.role === 'tool' && m.tool_call_id === 'call_read');
    if (readToolMsg?.role !== 'tool') throw new Error('expected read tool msg');
    expect(readToolMsg.content).toBe(payload);

    const writeToolMsg = third.find((m) => m.role === 'tool' && m.tool_call_id === 'call_write');
    if (writeToolMsg?.role !== 'tool') throw new Error('expected write tool msg');
    expect(writeToolMsg.content).toMatch(/wrote \d+ chars/);
  },
  90_000,
);

test.if(HAS_DOCKER)(
  'coding-agent toolchain: write_file -> grep -> edit_file -> read_file roundtrip',
  async () => {
    script.length = 0;
    calls.length = 0;
    const body = ['def greet(name):', '    # TODO: implement', '    pass', ''].join('\n');

    scriptReply({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_write',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: JSON.stringify({ path: 'app.py', content: body }),
          },
        },
      ],
    });
    scriptReply({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_grep',
          type: 'function',
          function: {
            name: 'grep',
            arguments: JSON.stringify({ pattern: 'TODO', glob: '*.py' }),
          },
        },
      ],
    });
    scriptReply({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_edit',
          type: 'function',
          function: {
            name: 'edit_file',
            arguments: JSON.stringify({
              path: 'app.py',
              old_string: '    # TODO: implement\n    pass',
              new_string: '    return f"hello {name}"',
            }),
          },
        },
      ],
    });
    scriptReply({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_read',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: JSON.stringify({ path: 'app.py', offset: 1, limit: 2 }),
          },
        },
      ],
    });
    scriptReply({ role: 'assistant', content: 'toolchain done' });

    const threadTs = await mention(
      tester,
      agent.botUserId,
      channel,
      undefined,
      `e2e-toolchain-${Date.now()}`,
    );
    createdThreads.push(threadTs);

    await waitForReply(tester, channel, threadTs, agent.botUserId, (t) => t === 'toolchain done');
    await waitFor(() => calls.length === 5, { what: 'five model calls', timeoutMs: 30_000 });

    // Inspect each tool's result in the messages array of the next call.
    const grepResult = calls[2]?.find((m) => m.role === 'tool' && m.tool_call_id === 'call_grep');
    if (grepResult?.role !== 'tool') throw new Error('expected grep tool msg');
    expect(grepResult.content).toContain('app.py');
    expect(grepResult.content).toContain('TODO');

    const editResult = calls[3]?.find((m) => m.role === 'tool' && m.tool_call_id === 'call_edit');
    if (editResult?.role !== 'tool') throw new Error('expected edit tool msg');
    expect(editResult.content).toMatch(/edited app\.py/);

    const readResult = calls[4]?.find((m) => m.role === 'tool' && m.tool_call_id === 'call_read');
    if (readResult?.role !== 'tool') throw new Error('expected read tool msg');
    // After edit + offset=1,limit=2: first two lines of the new file.
    expect(readResult.content).toContain('def greet(name):');
    expect(readResult.content).toContain('return f"hello {name}"');
    expect(readResult.content).not.toContain('TODO');
  },
  120_000,
);

test.if(HAS_DOCKER)(
  'bash runs as the unprivileged sandbox user (uid 1000), no caps',
  async () => {
    script.length = 0;
    calls.length = 0;
    scriptReply({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_whoami',
          type: 'function',
          function: {
            name: 'bash',
            arguments: JSON.stringify({
              command:
                'echo user=$(whoami) uid=$(id -u); echo "caps=$(cat /proc/self/status | grep CapEff | awk \'{print $2}\')"',
            }),
          },
        },
      ],
    });
    scriptReply({ role: 'assistant', content: 'identity checked' });

    const threadTs = await mention(
      tester,
      agent.botUserId,
      channel,
      undefined,
      `e2e-nonroot-${Date.now()}`,
    );
    createdThreads.push(threadTs);

    await waitForReply(tester, channel, threadTs, agent.botUserId, (t) => t === 'identity checked');
    await waitFor(() => calls.length === 2, { what: 'two model calls', timeoutMs: 30_000 });

    const toolMsg = calls[1]?.find((m) => m.role === 'tool');
    if (toolMsg?.role !== 'tool') throw new Error('expected tool msg');
    expect(toolMsg.content).toContain('user=sandbox');
    expect(toolMsg.content).toContain('uid=1000');
    // CapEff = 0000000000000000 means "no effective capabilities".
    expect(toolMsg.content).toMatch(/caps=0+/);
  },
  60_000,
);

test.if(HAS_DOCKER)(
  'bash live-streams stdout into the Slack checklist while running',
  async () => {
    script.length = 0;
    calls.length = 0;
    // Bash command runs ~4s, printing a line every second. Long enough for
    // the 800ms debounce to fire multiple checklist edits, short enough to
    // stay under the 5s SANDBOX_EXEC_TIMEOUT_MS this test file sets.
    scriptReply({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_stream',
          type: 'function',
          function: {
            name: 'bash',
            arguments: JSON.stringify({
              command: 'for i in 1 2 3 4; do echo step $i; sleep 1; done',
            }),
          },
        },
      ],
    });
    scriptReply({ role: 'assistant', content: 'stream done' });

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
    await waitForReply(tester, channel, threadTs, agent.botUserId, (t) => t === 'stream done', {
      timeoutMs: 30_000,
    });

    // And verify the recorded tool_result contains all the streamed lines.
    await waitFor(() => calls.length === 2, { what: 'two model calls', timeoutMs: 30_000 });
    const toolMsg = calls[1]?.find((m) => m.role === 'tool');
    if (toolMsg?.role !== 'tool') throw new Error('expected tool msg');
    for (const n of [1, 2, 3, 4]) {
      expect(toolMsg.content).toContain(`step ${n}`);
    }
  },
  60_000,
);

test.if(HAS_DOCKER)(
  'bash command timeout: long-running command is killed and returns a clear marker',
  async () => {
    script.length = 0;
    calls.length = 0;
    // The container's exec timeout is set via SANDBOX_EXEC_TIMEOUT_MS in
    // beforeAll (5s for tests).
    scriptReply({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_sleep',
          type: 'function',
          function: {
            name: 'bash',
            arguments: JSON.stringify({ command: 'sleep 300' }),
          },
        },
      ],
    });
    scriptReply({ role: 'assistant', content: 'slept' });

    const threadTs = await mention(
      tester,
      agent.botUserId,
      channel,
      undefined,
      `e2e-timeout-${Date.now()}`,
    );
    createdThreads.push(threadTs);

    await waitForReply(tester, channel, threadTs, agent.botUserId, (t) => t === 'slept', {
      timeoutMs: 45_000,
    });
    await waitFor(() => calls.length === 2, { what: 'two model calls', timeoutMs: 45_000 });

    const second = calls[1];
    if (!second) throw new Error('expected second call');
    const toolMsg = second.find((m) => m.role === 'tool');
    if (toolMsg?.role !== 'tool') throw new Error('expected tool msg');
    expect(toolMsg.content).toContain('timed out');
  },
  60_000,
);

test.if(HAS_DOCKER)(
  'egress is blocked: curl to an external host fails inside the sandbox',
  async () => {
    script.length = 0;
    calls.length = 0;
    scriptReply({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_curl',
          type: 'function',
          function: {
            name: 'bash',
            arguments: JSON.stringify({
              command: 'curl --max-time 3 -sS https://example.com; echo "exit=$?"',
            }),
          },
        },
      ],
    });
    scriptReply({ role: 'assistant', content: 'curl attempted' });

    const threadTs = await mention(
      tester,
      agent.botUserId,
      channel,
      undefined,
      `e2e-egress-${Date.now()}`,
    );
    createdThreads.push(threadTs);

    await waitForReply(tester, channel, threadTs, agent.botUserId, (t) => t === 'curl attempted');
    await waitFor(() => calls.length === 2, { what: 'two model calls', timeoutMs: 30_000 });

    const second = calls[1];
    if (!second) throw new Error('expected second call');
    const toolMsg = second.find((m) => m.role === 'tool');
    if (toolMsg?.role !== 'tool') throw new Error('expected tool msg');
    // bash always exits 0 (we appended `echo "exit=$?"`); curl's own exit
    // should be non-zero (DNS or connect failure) and the body must not be
    // example.com HTML.
    expect(toolMsg.content).not.toContain('exit=0');
    expect(toolMsg.content).not.toContain('<title>Example Domain');
  },
  60_000,
);

test.if(HAS_DOCKER)(
  '/delete removes the sandbox container',
  async () => {
    script.length = 0;
    calls.length = 0;
    // First mention only — no tools, just ensures the container is created.
    scriptReply({ role: 'assistant', content: 'hi' });

    const threadTs = await mention(
      tester,
      agent.botUserId,
      channel,
      undefined,
      `e2e-delete-${Date.now()}`,
    );
    createdThreads.push(threadTs);
    await waitForReply(tester, channel, threadTs, agent.botUserId, (t) => t === 'hi');

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
  90_000,
);

function scriptReply(message: AssistantMessage): void {
  script.push({ kind: 'reply', message });
}
