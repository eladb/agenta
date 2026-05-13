import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import type { CallModel, Message } from '../../src/model/gateway';
import { makeEventHandler } from '../../src/runtime/handler';
import { threadKey as makeThreadKey } from '../../src/runtime/thread';
import { removeContainer } from '../../src/sandbox';
import { connect } from '../../src/slack/connect';
import { listen } from '../../src/slack/events';

export const STUB_REPLY_PREFIX = 'stub: ';

// Recording stub: captures every call so tests can assert on the messages
// array (incl. multipart content for attachments). Reset via resetStubCalls().
export const stubCalls: Message[][] = [];

export function resetStubCalls(): void {
  stubCalls.length = 0;
}

export function lastStubCall(): Message[] | undefined {
  return stubCalls[stubCalls.length - 1];
}

export const stubCallModel: CallModel = async (messages) => {
  stubCalls.push(messages);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    if (typeof m.content === 'string') {
      return { role: 'assistant', content: `${STUB_REPLY_PREFIX}${m.content}` };
    }
    const textPart = m.content.find((p) => p.type === 'text');
    const text = textPart && textPart.type === 'text' ? textPart.text : '(multipart)';
    return { role: 'assistant', content: `${STUB_REPLY_PREFIX}${text}` };
  }
  return { role: 'assistant', content: `${STUB_REPLY_PREFIX}(no user message)` };
};

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

export type Agent = {
  socket: SocketModeClient;
  web: WebClient;
  botUserId: string;
};

export type Tester = {
  socket: SocketModeClient;
  web: WebClient;
  botUserId: string;
};

let dataDir: string | undefined;

export function setupTempDataDir(): string {
  dataDir = mkdtempSync(join(tmpdir(), 'agenta-e2e-'));
  process.env.AGENTA_DATA_DIR = dataDir;
  return dataDir;
}

export function cleanupTempDataDir(): void {
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
  delete process.env.AGENTA_DATA_DIR;
}

export function getDataDir(): string {
  if (!dataDir) throw new Error('data dir not set; call setupTempDataDir first');
  return dataDir;
}

export async function startAgent(callModel: CallModel = stubCallModel): Promise<Agent> {
  const appToken = requireEnv('SLACK_APP_TOKEN');
  const botToken = requireEnv('SLACK_BOT_TOKEN');
  const agent = await connect(appToken, botToken);
  listen(
    agent.socket,
    agent.botUserId,
    makeEventHandler(agent.web, botToken, agent.botUserId, callModel),
  );
  return agent;
}

export async function startTester(): Promise<Tester> {
  const web = new WebClient(requireEnv('TEST_BOT_TOKEN'));
  const auth = await web.auth.test();
  if (!auth.user_id) throw new Error('tester auth.test returned no user_id');
  const socket = new SocketModeClient({ appToken: requireEnv('TEST_APP_TOKEN') });
  await socket.start();
  return { web, socket, botUserId: auth.user_id };
}

export async function mention(
  tester: Tester,
  agentUserId: string,
  channel: string,
  threadTs: string | undefined,
  text: string,
): Promise<string> {
  const res = await tester.web.chat.postMessage({
    channel,
    text: `<@${agentUserId}> ${text}`,
    thread_ts: threadTs,
  });
  if (!res.ts) throw new Error('tester postMessage returned no ts');
  return res.ts;
}

// Upload a file via the tester bot into an existing thread, with a mention of
// the agent. Returns the file_id (use it to locate the file in the thread's
// JSONL after ingest).
export async function uploadFile(
  tester: Tester,
  agentUserId: string,
  channel: string,
  threadTs: string,
  fileBytes: Buffer | Uint8Array,
  filename: string,
  comment: string,
): Promise<string> {
  const res = await tester.web.files.uploadV2({
    channel_id: channel,
    thread_ts: threadTs,
    filename,
    file: Buffer.from(fileBytes),
    initial_comment: `<@${agentUserId}> ${comment}`,
  });
  const top = res.files?.[0] as { id?: string; files?: Array<{ id?: string }> } | undefined;
  const fileId = top?.files?.[0]?.id ?? top?.id;
  if (!fileId) throw new Error('files.uploadV2 returned no file id');
  return fileId;
}

export async function waitForReply(
  tester: Tester,
  channel: string,
  threadTs: string,
  byUserId: string,
  predicate: (text: string) => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 20000;
  const intervalMs = opts.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await tester.web.conversations.replies({ channel, ts: threadTs });
      const msgs = res.messages ?? [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m && m.user === byUserId && typeof m.text === 'string' && predicate(m.text)) {
          return m.text;
        }
      }
    } catch (err) {
      // Slack hasn't materialized the thread yet (parent has no replies).
      // Keep polling — the bot's reply will create it.
      if (!String((err as Error).message).includes('thread_not_found')) throw err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitForReply timed out after ${timeoutMs}ms`);
}

export async function deleteThread(
  tester: Tester,
  agent: Agent,
  channel: string,
  threadTs: string,
): Promise<void> {
  try {
    const res = await tester.web.conversations.replies({ channel, ts: threadTs });
    const msgs = res.messages ?? [];
    for (const m of msgs) {
      if (!m.ts) continue;
      const client = m.user === agent.botUserId ? agent.web : tester.web;
      await client.chat.delete({ channel, ts: m.ts }).catch(() => {});
    }
  } catch {
    // ignore
  }
  // Also remove the sandbox container created on first mention (best-effort —
  // a no-op if docker isn't running or the container was never created).
  await removeContainer(makeThreadKey(channel, threadTs)).catch(() => {});
}

export async function shutdown(agent: Agent, tester: Tester): Promise<void> {
  await Promise.allSettled([agent.socket.disconnect(), tester.socket.disconnect()]);
}

export async function waitFor(
  check: () => boolean,
  opts: { timeoutMs?: number; intervalMs?: number; what?: string } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 20000;
  const intervalMs = opts.intervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out${opts.what ? `: ${opts.what}` : ''}`);
}
