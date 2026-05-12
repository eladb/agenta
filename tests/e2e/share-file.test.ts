import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AssistantMessage, CallModel, Message } from '../../src/model/gateway';
import { threadKey } from '../../src/runtime/thread';
import {
  type Agent,
  cleanupTempDataDir,
  deleteThread,
  getDataDir,
  mention,
  requireEnv,
  setupTempDataDir,
  shutdown,
  startAgent,
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

type Scripted = { kind: 'reply'; message: AssistantMessage };
const script: Scripted[] = [];
const calls: Message[][] = [];

const scriptedCallModel: CallModel = async (messages) => {
  calls.push(messages);
  const next = script.shift();
  if (!next) return { role: 'assistant', content: 'unscripted' };
  return next.message;
};

function scriptReply(message: AssistantMessage): void {
  script.push({ kind: 'reply', message });
}

beforeAll(async () => {
  if (!HAS_DOCKER) return;
  setupTempDataDir();
  channel = requireEnv('TEST_CHANNEL_ID');
  [agent, tester] = await Promise.all([startAgent(scriptedCallModel), startTester()]);
});

afterAll(async () => {
  if (!HAS_DOCKER) return;
  for (const ts of createdThreads) {
    await deleteThread(tester, agent, channel, ts);
  }
  await shutdown(agent, tester);
  cleanupTempDataDir();
});

test.if(HAS_DOCKER)(
  'share_file: writes a file in the sandbox, shares it to the thread, persists JSONL + local copy',
  async () => {
    script.length = 0;
    calls.length = 0;
    const content = `sandbox file payload ${Date.now()}`;

    // Turn 1: write a small file inside the sandbox.
    scriptReply({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_write',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: JSON.stringify({ path: 'note.txt', content }),
          },
        },
      ],
    });
    // Turn 2: share it.
    scriptReply({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_share',
          type: 'function',
          function: {
            name: 'share_file',
            arguments: JSON.stringify({ path: 'note.txt' }),
          },
        },
      ],
    });
    // Turn 3: confirm.
    scriptReply({ role: 'assistant', content: 'file shared' });

    const threadTs = await mention(
      tester,
      agent.botUserId,
      channel,
      undefined,
      `e2e-share-${Date.now()}`,
    );
    createdThreads.push(threadTs);

    await waitForReply(tester, channel, threadTs, agent.botUserId, (t) => t === 'file shared', {
      timeoutMs: 60_000,
    });
    await waitFor(() => calls.length === 3, { what: 'three model calls', timeoutMs: 60_000 });

    // share_file's tool_result should land in the third model call as "shared note.txt …".
    const third = calls[2];
    if (!third) throw new Error('expected third model call');
    const shareTool = third.find((m) => m.role === 'tool' && m.tool_call_id === 'call_share');
    if (shareTool?.role !== 'tool') throw new Error('expected share tool msg');
    expect(shareTool.content).toMatch(/^shared note\.txt/);
    expect(shareTool.content).toContain('file_id=');

    // The Slack thread now contains a message with an attached file.
    const replies = await tester.web.conversations.replies({ channel, ts: threadTs });
    const fileMsg = (replies.messages ?? []).find(
      (m) => Array.isArray((m as { files?: unknown[] }).files) && (m as { files: unknown[] }).files.length > 0,
    );
    expect(fileMsg).toBeDefined();
    const fileInfo = (fileMsg as { files: Array<{ name?: string; mimetype?: string }> }).files[0];
    expect(fileInfo?.name).toBe('note.txt');

    // JSONL has an assistant message event with the files payload, and a
    // local copy of the bytes lives under attachments/.
    const jsonlPath = join(getDataDir(), threadKey(channel, threadTs), 'messages.jsonl');
    const lines = readFileSync(jsonlPath, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as {
        source: string;
        type: string;
        payload: { text?: string; files?: Array<{ name: string; local_path: string }> };
      });
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
  120_000,
);
