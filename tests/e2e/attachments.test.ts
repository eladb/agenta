// Migrated to the SDK harness + mock-model (#315 Phase A). Inbound Slack
// attachments are inlined into the model request — but on the SDK path that's
// the NATIVE Anthropic content-block shape (image/document/text blocks on a
// streaming-input user message), not the bespoke OpenAI-compat `image_url` data
// URI. So the assertions move from the recorded Message[] (`stubCalls`) to the
// mock's recorded request bodies (`mock.requests`), inspecting the last user
// message's content blocks. The real product behavior (MIME-from-bytes, on-disk
// attachment copy, JSONL file event) is asserted unchanged.

import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { threadKey } from '../../src/tenant/runtime/thread';
import { BINARY_BYTES, PDF_BYTES, PNG_BYTES, TEXT_BYTES } from './fixtures';
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
  uploadFile,
  waitFor,
  waitForReply,
} from './helpers';

let agent: Agent;
let tester: Tester;
let channel: string;
const createdThreads: string[] = [];

beforeAll(async () => {
  setupTempDataDir();
  channel = requireEnv('TEST_CHANNEL_ID');
  // SDK mode: the tenant runs the Agent SDK harness driven by the mock-model
  // server (agent.mock). Attachments are inlined into the request the SDK sends.
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
}, 120_000);

beforeEach(() => {
  const mock = agent.mock;
  if (!mock) throw new Error('expected SDK-mode mock handle');
  mock.reset();
  // Every turn (the thread-seed mention + the upload) just gets a text reply;
  // the test asserts on the request the SDK sent, not the reply.
  mock.setTurns([{ text: 'attachment ack' }]);
});

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

function findFileEvent(threadTs: string, fileId: string): SlackMessageRecord | undefined {
  return readJsonl(threadTs).find(
    (e) =>
      (e as { source?: string }).source === 'slack' &&
      (e as { type?: string }).type === 'message' &&
      ((e as SlackMessageRecord).payload.files ?? []).some((f) => f.file_id === fileId),
  ) as SlackMessageRecord | undefined;
}

// The native content blocks of the last user message across all recorded model
// requests. The attachment turn resumes the SDK session, so the request carries
// prior history; the NEW (multimodal) user message is the last one.
// biome-ignore lint/suspicious/noExplicitAny: raw request bodies are untyped JSON
function attachmentBlocks(): any[] {
  const mock = agent.mock;
  if (!mock) throw new Error('expected SDK-mode mock handle');
  // biome-ignore lint/suspicious/noExplicitAny: untyped request body
  const blocks: any[] = [];
  for (const req of mock.requests) {
    const msgs = Array.isArray(req?.messages) ? req.messages : [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.role !== 'user') continue;
      const content = msgs[i].content;
      if (Array.isArray(content)) blocks.push(...content);
      break;
    }
  }
  return blocks;
}

async function createThreadFor(seed: string): Promise<string> {
  const threadTs = await mention(tester, agent.botUserId, channel, undefined, seed);
  createdThreads.push(threadTs);
  await waitForReply(tester, channel, threadTs, agent.botUserId, (t) =>
    t.includes('attachment ack'),
  );
  return threadTs;
}

async function uploadAndWait(
  threadTs: string,
  bytes: Buffer,
  filename: string,
  comment: string,
): Promise<{ fileId: string; event: SlackMessageRecord }> {
  const mock = agent.mock;
  if (!mock) throw new Error('expected SDK-mode mock handle');
  const requestsBefore = mock.requests.length;
  const fileId = await uploadFile(
    tester,
    agent.botUserId,
    channel,
    threadTs,
    bytes,
    filename,
    comment,
  );
  await waitFor(
    () => Boolean(findFileEvent(threadTs, fileId)) && mock.requests.length > requestsBefore,
    { what: `file ${filename} ingested + new model request` },
  );
  return { fileId, event: findFileEvent(threadTs, fileId)! };
}

test('PNG upload: detected as image/png, sent to model as a native base64 image block', async () => {
  const threadTs = await createThreadFor(`e2e-attach-png-${Date.now()}`);

  const { event } = await uploadAndWait(threadTs, PNG_BYTES, 'photo.png', 'what is this');

  // JSONL: mime + local_path + file actually on disk with correct bytes
  const file = event.payload.files![0]!;
  expect(file.mimetype).toBe('image/png');
  expect(file.local_path.startsWith('attachments/')).toBe(true);
  const filePath = join(getDataDir(), threadKey(channel, threadTs), file.local_path);
  const onDisk = readFileSync(filePath);
  expect(onDisk.byteLength).toBe(PNG_BYTES.byteLength);

  // Model request: the user message carries a native image block (base64).
  const blocks = attachmentBlocks();
  const imageBlock = blocks.find((b) => b.type === 'image');
  expect(imageBlock?.source?.type).toBe('base64');
  expect(imageBlock?.source?.media_type).toBe('image/png');
  expect(typeof imageBlock?.source?.data).toBe('string');
  expect(imageBlock?.source?.data).toBe(PNG_BYTES.toString('base64'));
}, 120_000);

test('PDF upload: detected as application/pdf, sent as a native document block', async () => {
  const threadTs = await createThreadFor(`e2e-attach-pdf-${Date.now()}`);

  const { event } = await uploadAndWait(threadTs, PDF_BYTES, 'doc.pdf', 'check this pdf');

  const file = event.payload.files![0]!;
  expect(file.mimetype).toBe('application/pdf');

  const blocks = attachmentBlocks();
  const docBlock = blocks.find((b) => b.type === 'document');
  expect(docBlock?.source?.type).toBe('base64');
  expect(docBlock?.source?.media_type).toBe('application/pdf');
  expect(docBlock?.source?.data).toBe(PDF_BYTES.toString('base64'));
}, 120_000);

test('text upload: detected as text/plain, content inlined as a text block', async () => {
  const threadTs = await createThreadFor(`e2e-attach-text-${Date.now()}`);

  const { event } = await uploadAndWait(threadTs, TEXT_BYTES, 'notes.txt', 'read this');

  const file = event.payload.files![0]!;
  expect(file.mimetype).toBe('text/plain');

  const blocks = attachmentBlocks();
  const inlined = blocks.find(
    (b) =>
      b.type === 'text' &&
      typeof b.text === 'string' &&
      b.text.includes('[attached file: notes.txt]'),
  );
  expect(inlined?.text).toContain('hello from agenta e2e');
}, 120_000);

test('PNG bytes uploaded as .txt: mime detected from contents (image/png), overrides filename', async () => {
  const threadTs = await createThreadFor(`e2e-attach-lie-${Date.now()}`);

  const { event } = await uploadAndWait(
    threadTs,
    PNG_BYTES,
    'fake.txt',
    'extension lies, bytes are PNG',
  );

  const file = event.payload.files![0]!;
  // The agent must trust the bytes, not Slack's filename-derived mimetype
  expect(file.mimetype).toBe('image/png');

  const blocks = attachmentBlocks();
  const imageBlock = blocks.find((b) => b.type === 'image');
  expect(imageBlock?.source?.media_type).toBe('image/png');
  expect(imageBlock?.source?.data).toBe(PNG_BYTES.toString('base64'));
}, 120_000);

test('binary blob upload: detected as application/octet-stream, emits text placeholder', async () => {
  const threadTs = await createThreadFor(`e2e-attach-bin-${Date.now()}`);

  const { event } = await uploadAndWait(threadTs, BINARY_BYTES, 'blob.bin', 'random bytes');

  const file = event.payload.files![0]!;
  expect(file.mimetype).toBe('application/octet-stream');

  const blocks = attachmentBlocks();
  const placeholder = blocks.find(
    (b) =>
      b.type === 'text' &&
      typeof b.text === 'string' &&
      b.text.includes('[attached:') &&
      b.text.includes('application/octet-stream'),
  );
  expect(placeholder).toBeDefined();
}, 120_000);
