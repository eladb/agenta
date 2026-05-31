import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AssistantMessage, CallModel, Message } from '../../src/tenant/model/gateway';
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
  startAgent,
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
  // Pre-build the sandbox image so the first turn doesn't time out building it.
  await ensureImage();
  [agent, tester] = await Promise.all([startAgent(scriptedCallModel), startTester()]);
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

// The test discovers threadTs by scanning the e2e data dir for a JSONL
// entry that references the uploaded file_id. Slack creates the parent
// message of an upload asynchronously, so we can't capture it up front
// from files.uploadV2's response — we wait for the agent to ingest it.
function dataDirThreads(): string[] {
  const root = getDataDir();
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root);
  } catch {
    return [];
  }
}

function scriptReply(message: AssistantMessage): void {
  script.push({ kind: 'reply', message });
}

test.if(HAS_DOCKER)(
  'inbound attachment is synced to ~/attachments and read_file sees it',
  async () => {
    script.length = 0;
    calls.length = 0;

    const fileContents = `inbound-attach-test ${Date.now()}\nline two\n`;
    const filename = 'inbound.txt';

    // 1) Pre-script the replies BEFORE upload. files.uploadV2 fires the
    //    mention immediately and the bot's runTurn calls the model before
    //    the test can push scripts otherwise (race: `scriptedCallModel`
    //    returns "unscripted" → test times out waiting for "done").
    //    The bash command uses a glob since fileId isn't known yet —
    //    attachments/<fileId>-<filename> is the only file in the dir.
    scriptReply({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_cat',
          type: 'function',
          function: {
            name: 'bash',
            arguments: JSON.stringify({ command: `cat attachments/*-${filename}` }),
          },
        },
      ],
    });
    scriptReply({ role: 'assistant', content: 'done' });

    // 2) Upload the file as the root of a new thread, with a mention.
    //    files.uploadV2 with no thread_ts creates a new top-level message.
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
          // tk is the on-disk thread key; we don't have the threadTs to
          // build it ourselves, but the JSONL is keyed by the same name so
          // we can read each thread dir directly.
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

    // 3) Compute the path the bot will inject into the user message and
    //    use it in the assertion below. This is the same shape used by
    //    `attachments.ts` host-side.
    const expectedPath = `attachments/${fileId}-${filename}`;

    // 4) Wait for final reply + the two model calls (initial + post-tool).
    await waitForReply(tester, channel, threadTs, agent.botUserId, (t) => t === 'done', {
      timeoutMs: 90_000,
    });
    await waitFor(() => calls.length === 2, { what: 'two model calls', timeoutMs: 30_000 });

    // 4a) First call's messages: user message text includes the hint suffix.
    const first = calls[0];
    if (!first) throw new Error('expected first call');
    const lastUser = [...first].reverse().find((m) => m.role === 'user');
    if (lastUser?.role !== 'user') throw new Error('expected last user message');
    let userText: string;
    if (typeof lastUser.content === 'string') {
      userText = lastUser.content;
    } else {
      const textParts = lastUser.content.filter((p) => p.type === 'text');
      userText = textParts.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
    }
    expect(userText).toContain(`[attached: ${expectedPath}]`);

    // 4b) Second call's tool_result has the file's exact contents.
    const second = calls[1];
    if (!second) throw new Error('expected second call');
    const toolMsg = second.find((m) => m.role === 'tool' && m.tool_call_id === 'call_cat');
    if (toolMsg?.role !== 'tool') throw new Error('expected tool msg');
    expect(toolMsg.content).toContain('exit: 0');
    expect(toolMsg.content).toContain(fileContents.trim());

    // 4c) JSONL has the slack message event with files[].local_path under attachments/.
    const events = readJsonl(threadTs);
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
