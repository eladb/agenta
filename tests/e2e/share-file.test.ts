// Migrated to the SDK harness + mock-model (#315 Phase A). The product behavior
// asserted is unchanged — the model writes a file in the sandbox, calls
// share_file, the bot uploads it to the thread and persists the assistant
// message event + a local copy of the bytes — but the model is now driven by the
// mock-model server (ANTHROPIC_BASE_URL) scripted with MockTurn[] instead of the
// bespoke `scriptedCallModel`/`script` queue, and the share_file tool_result
// assertion ("shared note.txt …" / "file_id=") moves from the recorded
// `Message[]` to the mock's recorded request bodies (Anthropic shape).
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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

beforeAll(async () => {
  if (!HAS_DOCKER) return;
  setupTempDataDir();
  channel = requireEnv('TEST_CHANNEL_ID');
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
  'share_file: writes a file in the sandbox, shares it to the thread, persists JSONL + local copy',
  async () => {
    const mock = agent.mock;
    if (!mock) throw new Error('expected SDK-mode mock handle');
    mock.reset();
    const content = `sandbox file payload ${Date.now()}`;

    mock.setTurns([
      // Turn 1: write a small file inside the sandbox.
      {
        toolUses: [
          {
            id: 'call_write',
            name: 'mcp__agenta__write_file',
            input: { path: 'note.txt', content },
          },
        ],
      },
      // Turn 2: share it.
      {
        toolUses: [
          {
            id: 'call_share',
            name: 'mcp__agenta__share_file',
            input: { path: 'note.txt' },
          },
        ],
      },
      // Turn 3: confirm.
      { text: 'file shared' },
    ]);

    const threadTs = await mention(
      tester,
      agent.botUserId,
      channel,
      undefined,
      `e2e-share-${Date.now()}`,
    );
    createdThreads.push(threadTs);

    // 100s timeouts: this test does three model turns inside a brand-new
    // sandbox. On the docker provider the first turn pays the container cold
    // start for the per-thread sandbox, then write_file / share_file / reply
    // each round-trip through the sandbox HTTP server. 60s was observed too
    // tight in CD 2026-05-19. Test wall clock is 150s.
    await waitForReply(
      tester,
      channel,
      threadTs,
      agent.botUserId,
      (t) => t.includes('file shared'),
      { timeoutMs: 100_000 },
    );
    await waitFor(() => mock.requests.length >= 3, {
      what: 'three model calls',
      timeoutMs: 100_000,
    });

    // share_file's tool_result should land in a continuation request body as
    // "shared note.txt … file_id=…" (the bespoke version asserted this on the
    // third model call's `tool` message; here it's in the recorded request body).
    const flat = JSON.stringify(mock.requests);
    expect(flat).toContain('call_share');
    expect(flat).toContain('tool_result');
    expect(flat).toContain('shared note.txt');
    expect(flat).toContain('file_id=');

    // The Slack thread now contains a message with an attached file.
    // Slack's files.uploadV2 has eventual consistency vs conversations.replies —
    // both the attached message AND the file's metadata (name/mimetype) can
    // populate at different beats. Poll until the file object actually has
    // a name set, not just until any files-bearing message appears. 30s
    // deadline because Slack metadata propagation has been observed up to
    // ~25s in CD (CD #38 2026-05-19 hit `name === undefined` at 15s).
    let fileMsg: { files?: Array<{ name?: string; mimetype?: string }> } | undefined;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const replies = await tester.web.conversations.replies({ channel, ts: threadTs });
      fileMsg = (replies.messages ?? []).find((m) => {
        const files = (m as { files?: Array<{ name?: string }> }).files;
        return Array.isArray(files) && files.length > 0 && typeof files[0]?.name === 'string';
      }) as { files?: Array<{ name?: string; mimetype?: string }> } | undefined;
      if (fileMsg) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(fileMsg).toBeDefined();
    const fileInfo = fileMsg?.files?.[0];
    expect(fileInfo?.name).toBe('note.txt');

    // JSONL has an assistant message event with the files payload, and a
    // local copy of the bytes lives under attachments/.
    const jsonlPath = join(getDataDir(), threadKey(channel, threadTs), 'messages.jsonl');
    const lines = readFileSync(jsonlPath, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map(
        (l) =>
          JSON.parse(l) as {
            source: string;
            type: string;
            payload: { text?: string; files?: Array<{ name: string; local_path: string }> };
          },
      );
    const shared = lines.find(
      (e) => e.source === 'assistant' && e.type === 'message' && (e.payload.files?.length ?? 0) > 0,
    );
    expect(shared).toBeDefined();
    expect(shared?.payload.files?.[0]?.name).toBe('note.txt');
    expect(shared?.payload.text).toContain('[shared note.txt]');
    const local = join(
      getDataDir(),
      threadKey(channel, threadTs),
      shared?.payload.files?.[0]?.local_path ?? '',
    );
    expect(existsSync(local)).toBe(true);
    expect(readFileSync(local, 'utf8')).toBe(content);
  },
  150_000,
);
