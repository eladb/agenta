import type { WebClient } from '@slack/web-api';
import { mdToMrkdwn } from './mrkdwn';

// biome-ignore lint/suspicious/noExplicitAny: slack web-api types blocks as `any`
type Blocks = any;

export async function postInThread(
  web: WebClient,
  channel: string,
  threadTs: string,
  text: string,
): Promise<string> {
  const res = await web.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: mdToMrkdwn(text),
  });
  if (!res.ts) throw new Error('chat.postMessage returned no ts');
  return res.ts;
}

export async function addReaction(
  web: WebClient,
  channel: string,
  ts: string,
  name: string,
): Promise<void> {
  // Slack returns 'already_reacted' if the bot already added this emoji
  // to this message; that's harmless. We swallow all errors — reactions
  // are best-effort UX, never block a turn. Wrap in try/catch (not just
  // promise .catch) so we also tolerate stub webs that lack the API.
  try {
    await web.reactions.add({ channel, timestamp: ts, name });
  } catch {
    // best-effort
  }
}

export async function removeReaction(
  web: WebClient,
  channel: string,
  ts: string,
  name: string,
): Promise<void> {
  try {
    await web.reactions.remove({ channel, timestamp: ts, name });
  } catch {
    // best-effort
  }
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
