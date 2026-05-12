import type { WebClient } from '@slack/web-api';

// biome-ignore lint/suspicious/noExplicitAny: slack web-api types blocks as `any`
type Blocks = any;

export async function postInThread(
  web: WebClient,
  channel: string,
  threadTs: string,
  text: string,
): Promise<string> {
  const res = await web.chat.postMessage({ channel, thread_ts: threadTs, text });
  if (!res.ts) throw new Error('chat.postMessage returned no ts');
  return res.ts;
}

export async function editMessage(
  web: WebClient,
  channel: string,
  ts: string,
  text: string,
): Promise<void> {
  // Always pass blocks: [] so a previous chat.update that set blocks (e.g.
  // ask_user rendering interactive elements on the checklist message) gets
  // cleared when we switch back to plain text. Without this, Slack keeps
  // the old blocks and the buttons stay visible after the ask resolved.
  await web.chat.update({ channel, ts, text, blocks: [] });
}

export async function postBlocksInThread(
  web: WebClient,
  channel: string,
  threadTs: string,
  text: string,
  blocks: Blocks,
): Promise<string> {
  // `text` is a fallback for notifications / accessibility — Slack requires it
  // even when blocks carry the visible content.
  const res = await web.chat.postMessage({ channel, thread_ts: threadTs, text, blocks });
  if (!res.ts) throw new Error('chat.postMessage returned no ts');
  return res.ts;
}

export async function editBlocksMessage(
  web: WebClient,
  channel: string,
  ts: string,
  text: string,
  blocks: Blocks,
): Promise<void> {
  await web.chat.update({ channel, ts, text, blocks });
}
