import type { WebClient } from '@slack/web-api';
import { log } from '../../shared/log';
import { downloadFiles, type SlackFile } from './attachments';
import { newEventId, nowIso, record, type SlackMessageEvent } from './events';
import { threadExists } from './store';

type SlackReplyMessage = {
  ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  files?: SlackFile[];
  subtype?: string;
};

// On first mention in a thread: fetch the full thread via conversations.replies
// and write each message as a slack-source message event. No-op if the thread
// directory already exists locally. excludeSlackTs lets the caller skip the
// triggering message (which it will record itself, in arrival order).
export async function backfillIfNew(
  web: WebClient,
  botToken: string,
  channel: string,
  threadTs: string,
  threadKey: string,
  botUserId: string,
  excludeSlackTs: string,
): Promise<void> {
  if (threadExists(threadKey)) return;

  log.info('backfill', `[${threadKey}] backfilling thread`);
  let cursor: string | undefined;
  const all: SlackReplyMessage[] = [];
  do {
    const res = await web.conversations.replies({ channel, ts: threadTs, cursor, limit: 200 });
    const msgs = (res.messages ?? []) as SlackReplyMessage[];
    all.push(...msgs);
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  let written = 0;
  for (const m of all) {
    if (!m.ts) continue;
    if (m.ts === excludeSlackTs) continue;
    if (m.subtype === 'bot_message') continue;
    if (m.user === botUserId) continue;
    const files =
      m.files && m.files.length > 0 ? await downloadFiles(threadKey, botToken, m.files) : undefined;
    const ev: SlackMessageEvent = {
      event_id: newEventId(),
      thread_key: threadKey,
      source: 'slack',
      type: 'message',
      ts: new Date(Number.parseFloat(m.ts) * 1000).toISOString(),
      ingested_at: nowIso(),
      payload: {
        slack_ts: m.ts,
        user: m.user ?? 'unknown',
        text: m.text ?? '',
        ...(files && files.length > 0 ? { files } : {}),
      },
    };
    await record(ev);
    written++;
  }
  log.info('backfill', `[${threadKey}] wrote ${written} backfilled events`);
}
