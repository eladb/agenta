import type { SocketModeClient } from '@slack/socket-mode';
import { log } from '../log';
import type { SlackFile } from '../persistence/attachments';

export type NormalMessage = {
  kind: 'message';
  eventId?: string;
  channel: string;
  threadTs: string;
  ts: string;
  user: string;
  text: string;
  rawText: string;
  isMention: boolean;
  files?: SlackFile[];
};

export type EditMessage = {
  kind: 'edit';
  eventId?: string;
  channel: string;
  threadTs: string;
  editedTs: string;
  newText: string;
  previousText?: string;
  user: string;
};

export type DeleteMessage = {
  kind: 'delete';
  eventId?: string;
  channel: string;
  threadTs: string;
  deletedTs: string;
};

export type IncomingEvent = NormalMessage | EditMessage | DeleteMessage;

type RawEvent = {
  type?: string;
  subtype?: string;
  channel: string;
  thread_ts?: string;
  ts: string;
  user?: string;
  bot_id?: string;
  text?: string;
  files?: SlackFile[];
  message?: RawEvent;
  previous_message?: RawEvent;
  deleted_ts?: string;
};

type SocketArgs = {
  event: RawEvent;
  body?: { event_id?: string };
  ack: () => Promise<void>;
};

export function listen(
  socket: SocketModeClient,
  botUserId: string,
  onEvent: (e: IncomingEvent) => Promise<void>,
): void {
  socket.on('message', async (args: SocketArgs) => {
    await args.ack();
    try {
      const ev = normalize(args.event, args.body?.event_id, botUserId);
      if (ev) await onEvent(ev);
    } catch (err) {
      log.error('events', 'handler threw', err);
    }
  });
}

function normalize(
  event: RawEvent,
  eventId: string | undefined,
  botUserId: string,
): IncomingEvent | null {
  // Drop the agent's own messages/edits/deletes — we persist those explicitly.
  // Note: tester bot messages have bot_id too; we want to keep those.
  if (event.subtype === 'message_changed') {
    const msg = event.message;
    if (!msg?.ts) return null;
    if (msg.user === botUserId) return null;
    // Drop no-op edits where the text didn't actually change. Slack
    // re-emits message_changed for metadata-only updates (e.g. link
    // unfurl enrichment); we don't want those polluting the JSONL.
    const newText = msg.text ?? '';
    const prevText = event.previous_message?.text ?? '';
    if (newText === prevText) return null;
    return {
      kind: 'edit',
      eventId,
      channel: event.channel,
      threadTs: msg.thread_ts ?? msg.ts,
      editedTs: msg.ts,
      newText,
      previousText: event.previous_message?.text,
      user: msg.user ?? 'unknown',
    };
  }

  if (event.subtype === 'message_deleted') {
    if (!event.deleted_ts) return null;
    const prev = event.previous_message;
    if (prev?.user === botUserId) return null;
    return {
      kind: 'delete',
      eventId,
      channel: event.channel,
      threadTs: prev?.thread_ts ?? event.deleted_ts,
      deletedTs: event.deleted_ts,
    };
  }

  // Allow regular messages, file uploads, and broadcast-replies. Anything else
  // (joins/leaves/pins/topic-changes/channel meta) is noise we don't ingest.
  if (
    event.subtype !== undefined &&
    event.subtype !== 'file_share' &&
    event.subtype !== 'thread_broadcast'
  ) {
    return null;
  }
  if (event.user === botUserId) return null;
  if (!event.user) return null;

  const text = event.text ?? '';
  const isMention = text.includes(`<@${botUserId}>`);
  const hasThread = !!event.thread_ts;
  if (!hasThread && !isMention) return null;

  return {
    kind: 'message',
    eventId,
    channel: event.channel,
    threadTs: event.thread_ts ?? event.ts,
    ts: event.ts,
    user: event.user,
    text: stripMention(text, botUserId),
    rawText: text,
    isMention,
    files: event.files,
  };
}

function stripMention(text: string, botUserId: string): string {
  const re = new RegExp(`<@${botUserId}(\\|[^>]+)?>`, 'g');
  return text.replace(re, '').trim();
}
