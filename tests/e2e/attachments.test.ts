import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Message } from '../../src/model/gateway';
import { threadKey } from '../../src/runtime/thread';
import { BINARY_BYTES, PDF_BYTES, PNG_BYTES, TEXT_BYTES } from './fixtures';
import {
  type Agent,
  cleanupTempDataDir,
  deleteThread,
  getDataDir,
  lastStubCall,
  mention,
  requireEnv,
  resetStubCalls,
  STUB_REPLY_PREFIX,
  setupTempDataDir,
  safeShutdown,
  startAgent,
  startTester,
  stubCalls,
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
  [agent, tester] = await Promise.all([startAgent(), startTester()]);
}, 120_000);

afterAll(async () => {
  for (const ts of createdThreads) {
    await deleteThread(tester, agent, channel, ts);
  }
  await safeShutdown(agent, tester);
  cleanupTempDataDir();
}, 120_000);

beforeEach(() => {
  resetStubCalls();
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

function lastUserMessage(call: Message[]): Message | undefined {
  for (let i = call.length - 1; i >= 0; i--) {
    if (call[i]?.role === 'user') return call[i];
  }
  return undefined;
}

async function createThreadFor(seed: string): Promise<string> {
  const threadTs = await mention(tester, agent.botUserId, channel, undefined, seed);
  createdThreads.push(threadTs);
  await waitForReply(tester, channel, threadTs, agent.botUserId, (t) =>
    t.startsWith(STUB_REPLY_PREFIX),
  );
  return threadTs;
}

async function uploadAndWait(
  threadTs: string,
  bytes: Buffer,
  filename: string,
  comment: string,
): Promise<{ fileId: string; event: SlackMessageRecord; call: Message[] }> {
  const callsBefore = stubCalls.length;
  const fileId = await uploadFile(
    tester,
    agent.botUserId,
    channel,
    threadTs,
    bytes,
    filename,
    comment,
  );
  await waitFor(() => Boolean(findFileEvent(threadTs, fileId)) && stubCalls.length > callsBefore, {
    what: `file ${filename} ingested + new model call`,
  });
  return {
    fileId,
    event: findFileEvent(threadTs, fileId)!,
    call: lastStubCall()!,
  };
}

test('PNG upload: detected as image/png, sent to model as image_url part', async () => {
  const threadTs = await createThreadFor(`e2e-attach-png-${Date.now()}`);

  const { event, call } = await uploadAndWait(threadTs, PNG_BYTES, 'photo.png', 'what is this');

  // JSONL: mime + local_path + file actually on disk with correct bytes
  const file = event.payload.files![0]!;
  expect(file.mimetype).toBe('image/png');
  expect(file.local_path.startsWith('attachments/')).toBe(true);
  const filePath = join(getDataDir(), threadKey(channel, threadTs), file.local_path);
  const onDisk = readFileSync(filePath);
  expect(onDisk.byteLength).toBe(PNG_BYTES.byteLength);

  // Stub call: last user message has multipart content including image_url
  const lastUser = lastUserMessage(call);
  expect(Array.isArray(lastUser?.content)).toBe(true);
  const parts = lastUser?.content as Array<{ type: string; image_url?: { url: string } }>;
  const imagePart = parts.find((p) => p.type === 'image_url');
  expect(imagePart?.image_url?.url.startsWith('data:image/png;base64,')).toBe(true);
});

test('PDF upload: detected as application/pdf, sent as image_url part with pdf data URI', async () => {
  const threadTs = await createThreadFor(`e2e-attach-pdf-${Date.now()}`);

  const { event, call } = await uploadAndWait(threadTs, PDF_BYTES, 'doc.pdf', 'check this pdf');

  const file = event.payload.files![0]!;
  expect(file.mimetype).toBe('application/pdf');

  const lastUser = lastUserMessage(call);
  const parts = lastUser?.content as Array<{ type: string; image_url?: { url: string } }>;
  const pdfPart = parts.find((p) => p.type === 'image_url');
  expect(pdfPart?.image_url?.url.startsWith('data:application/pdf;base64,')).toBe(true);
});

test('text upload: detected as text/plain, content inlined as text part', async () => {
  const threadTs = await createThreadFor(`e2e-attach-text-${Date.now()}`);

  const { event, call } = await uploadAndWait(threadTs, TEXT_BYTES, 'notes.txt', 'read this');

  const file = event.payload.files![0]!;
  expect(file.mimetype).toBe('text/plain');

  const lastUser = lastUserMessage(call);
  const parts = lastUser?.content as Array<{ type: string; text?: string }>;
  const inlinedFile = parts.find(
    (p) => p.type === 'text' && p.text?.includes('[attached file: notes.txt]'),
  );
  expect(inlinedFile?.text).toContain('hello from agenta e2e');
});

test('PNG bytes uploaded as .txt: mime detected from contents (image/png), overrides filename', async () => {
  const threadTs = await createThreadFor(`e2e-attach-lie-${Date.now()}`);

  const { event, call } = await uploadAndWait(
    threadTs,
    PNG_BYTES,
    'fake.txt',
    'extension lies, bytes are PNG',
  );

  const file = event.payload.files![0]!;
  // The agent must trust the bytes, not Slack's filename-derived mimetype
  expect(file.mimetype).toBe('image/png');

  const lastUser = lastUserMessage(call);
  const parts = lastUser?.content as Array<{ type: string; image_url?: { url: string } }>;
  const imagePart = parts.find((p) => p.type === 'image_url');
  expect(imagePart?.image_url?.url.startsWith('data:image/png;base64,')).toBe(true);
});

test('binary blob upload: detected as application/octet-stream, emits text placeholder', async () => {
  const threadTs = await createThreadFor(`e2e-attach-bin-${Date.now()}`);

  const { event, call } = await uploadAndWait(threadTs, BINARY_BYTES, 'blob.bin', 'random bytes');

  const file = event.payload.files![0]!;
  expect(file.mimetype).toBe('application/octet-stream');

  const lastUser = lastUserMessage(call);
  const parts = lastUser?.content as Array<{ type: string; text?: string }>;
  const placeholder = parts.find(
    (p) =>
      p.type === 'text' &&
      p.text?.includes('[attached:') &&
      p.text?.includes('application/octet-stream'),
  );
  expect(placeholder).toBeDefined();
});
