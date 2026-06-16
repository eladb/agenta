// Migrated to the SDK harness + mock-model (#315 Phase A). An inbound Slack
// attachment is (1) inlined into the model request with a `[attached:
// attachments/<id>-<name>]` path hint and (2) synced into the sandbox so a bash
// tool can read it. On the SDK path the sync runs in the MCP tool preamble
// (mcp-tools.ts) before any requiresSandbox tool, and the path hint rides the
// streaming-input user message. The model is driven by the mock-model server
// (mock.setTurns) and the model-internal assertions read mock.requests; the real
// effects (file on disk under attachments/, the bash tool reading it) are
// asserted unchanged.

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { threadKey } from '../../src/tenant/runtime/thread';
import { ensureImage } from '../../src/tenant/sandbox/docker';
import {
  type Agent,
  cleanupTempDataDir,
  DOCKER_PROVIDER_ACTIVE,
  deleteThread,
  getDataDir,
  requireEnv,
  safeShutdown,
  setupTempDataDir,
  startBotAndTenant,
  startTester,
  type Tester,
  waitFor,
  waitForReply,
} from './helpers';

const HAS_DOCKER = DOCKER_PROVIDER_ACTIVE;

let agent: Agent;
let tester: Tester;
let channel: string;
const createdThreads: string[] = [];

beforeAll(async () => {
  if (!HAS_DOCKER) return;
  setupTempDataDir();
  channel = requireEnv('TEST_CHANNEL_ID');
  // Pre-build the sandbox image so the first turn doesn't time out building it.
  await ensureImage();
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

type SlackMessageRecord = {
  source: 'slack';
  type: 'message';
  payload: {
    slack_ts: string;
    text: string;
    files?: Array<{ file_id: string; name: string; mimetype: string; local_path: string }>;
  };
};

function readJsonl(threadTs: string): Array<Record<string, unknown>> {
  const file = join(getDataDir(), threadKey(channel, threadTs), 'messages.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

// The test discovers threadTs by scanning the e2e data dir for a JSONL entry
// that references the uploaded file_id. Slack creates the parent message of an
// upload asynchronously, so we can't capture it up front from files.uploadV2's
// response — we wait for the agent to ingest it.
function dataDirThreads(): string[] {
  const root = getDataDir();
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root);
  } catch {
    return [];
  }
}

test.if(HAS_DOCKER)(
  'inbound attachment is synced to ~/attachments and a bash tool reads it',
  async () => {
    const mock = agent.mock;
    if (!mock) throw new Error('expected SDK-mode mock handle');
    mock.reset();

    const fileContents = `inbound-attach-test ${Date.now()}\nline two\n`;
    const filename = 'inbound.txt';

    // Script the turns BEFORE upload: files.uploadV2 fires the mention
    // immediately. Turn 0 calls bash to cat the synced attachment (glob since
    // fileId isn't known yet — it's the only file in attachments/); turn 1 is
    // the final reply.
    mock.setTurns([
      {
        toolUses: [
          {
            id: 'call_cat',
            name: 'mcp__agenta__bash',
            input: { command: `cat attachments/*-${filename}` },
          },
        ],
      },
      { text: 'done' },
    ]);

    // Upload the file as the root of a new thread, with a mention.
    const upload = await tester.web.files.uploadV2({
      channel_id: channel,
      filename,
      file: Buffer.from(fileContents),
      initial_comment: `<@${agent.botUserId}> read the file I sent`,
    });
    const top = upload.files?.[0] as { id?: string; files?: Array<{ id?: string }> } | undefined;
    const fileId = top?.files?.[0]?.id ?? top?.id;
    if (!fileId) throw new Error('files.uploadV2 returned no file id');

    // Slack creates the parent message asynchronously. Poll until the agent
    // ingests a slack message event referencing this file_id; that record
    // carries the slack_ts we'll use as the thread root.
    let threadTs: string | undefined;
    await waitFor(
      () => {
        for (const tk of dataDirThreads()) {
          const file = join(getDataDir(), tk, 'messages.jsonl');
          if (!existsSync(file)) continue;
          const events = readFileSync(file, 'utf8')
            .split('\n')
            .filter((l) => l.length > 0)
            .map((l) => JSON.parse(l) as SlackMessageRecord);
          for (const rec of events) {
            if (
              rec.source === 'slack' &&
              rec.type === 'message' &&
              (rec.payload.files ?? []).some((f) => f.file_id === fileId)
            ) {
              threadTs = rec.payload.slack_ts;
              return true;
            }
          }
        }
        return false;
      },
      { what: `slack message event for ${fileId}`, timeoutMs: 30_000 },
    );
    if (!threadTs) throw new Error('threadTs not resolved');
    createdThreads.push(threadTs);

    // The path the bot injects into the user message + syncs into the sandbox.
    const expectedPath = `attachments/${fileId}-${filename}`;

    // Wait for the final reply.
    await waitForReply(tester, channel, threadTs, agent.botUserId, (t) => t.includes('done'), {
      timeoutMs: 90_000,
    });
    await waitFor(() => mock.requests.length >= 2, {
      what: 'two model requests (tool call + continuation)',
      timeoutMs: 30_000,
    });

    const flat = JSON.stringify(mock.requests);

    // 1) The user message carries the `[attached: ...]` path hint, and the
    //    continuation request round-trips the bash tool_result for call_cat.
    expect(flat).toContain(`[attached: ${expectedPath}]`);
    expect(flat).toContain('call_cat');
    expect(flat).toContain('tool_result');

    // 2) The bash tool actually read the synced file: assert on the raw JSONL
    //    tool_result event (not the JSON-escaped request body — newlines there
    //    are `\n`, not real newlines). The MCP tool preamble synced the
    //    attachment into the sandbox before the bash ran.
    const events = readJsonl(threadTs);
    const toolResult = events.find((e) => (e as { type?: string }).type === 'tool_result') as
      | { payload?: { content?: string } }
      | undefined;
    expect(toolResult?.payload?.content).toContain('exit: 0');
    expect(toolResult?.payload?.content).toContain(fileContents.trim());

    // 3) JSONL has the slack message event with files[].local_path under attachments/.
    const fileEvent = events.find(
      (e) =>
        (e as { source?: string }).source === 'slack' &&
        (e as { type?: string }).type === 'message' &&
        ((e as SlackMessageRecord).payload.files ?? []).some((f) => f.file_id === fileId),
    ) as SlackMessageRecord | undefined;
    expect(fileEvent).toBeDefined();
    const localPath = fileEvent?.payload.files?.[0]?.local_path ?? '';
    expect(localPath.startsWith('attachments/')).toBe(true);
  },
  120_000,
);
