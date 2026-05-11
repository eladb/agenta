import type { WebClient } from '@slack/web-api';
import { log } from '../log';
import type { CallModel } from '../model/gateway';
import { deleteAttachmentsForSlackTs, downloadFiles } from '../persistence/attachments';
import { backfillIfNew } from '../persistence/backfill';
import { newEventId, nowIso, record } from '../persistence/events';
import { deleteThreadData } from '../persistence/store';
import type { DeleteMessage, EditMessage, IncomingEvent, NormalMessage } from '../slack/events';
import { postInThread } from '../slack/post';
import { parseCommand } from './commands';
import { createDedupe, dedupeKey } from './dedupe';
import { signalStop, startOrQueue } from './session';
import { threadKey } from './thread';

const isDuplicate = createDedupe();

export function makeEventHandler(
  web: WebClient,
  botToken: string,
  botUserId: string,
  callModel: CallModel,
  systemPrompt: string,
): (e: IncomingEvent) => Promise<void> {
  return async (e) => {
    if (e.kind === 'message') {
      return handleMessage(web, botToken, botUserId, callModel, systemPrompt, e);
    }
    if (e.kind === 'edit') return handleEdit(e);
    if (e.kind === 'delete') return handleDelete(e);
  };
}

async function handleMessage(
  web: WebClient,
  botToken: string,
  botUserId: string,
  callModel: CallModel,
  systemPrompt: string,
  e: NormalMessage,
): Promise<void> {
  const key = dedupeKey({
    eventId: e.eventId,
    channel: e.channel,
    threadTs: e.threadTs,
    user: e.user,
    ts: e.ts,
    text: e.text,
  });
  if (isDuplicate(key)) {
    log.info('handler', `dropped duplicate ${key}`);
    return;
  }

  const tk = threadKey(e.channel, e.threadTs);

  if (e.isMention) {
    await backfillIfNew(web, botToken, e.channel, e.threadTs, tk, botUserId, e.ts);
  }

  const files =
    e.files && e.files.length > 0 ? await downloadFiles(tk, botToken, e.files) : undefined;

  await record({
    event_id: newEventId(),
    thread_key: tk,
    source: 'slack',
    type: 'message',
    ts: slackTsToIso(e.ts),
    ingested_at: nowIso(),
    payload: {
      slack_event_id: e.eventId,
      slack_ts: e.ts,
      user: e.user,
      text: e.text,
      ...(files && files.length > 0 ? { files } : {}),
    },
  });

  if (!e.isMention) return;

  const cmd = parseCommand(e.text);

  if (cmd === 'stop') {
    await signalStop(web, e.channel, e.threadTs, tk);
    return;
  }

  if (cmd === 'delete') {
    await postInThread(web, e.channel, e.threadTs, 'deleted (stub)').catch(() => {});
    await deleteThreadData(tk);
    log.info('handler', `[${tk}] /delete done`);
    return;
  }

  await startOrQueue(web, callModel, systemPrompt, {
    channel: e.channel,
    threadTs: e.threadTs,
    threadKey: tk,
  });
}

async function handleEdit(e: EditMessage): Promise<void> {
  if (e.eventId && isDuplicate(`id:${e.eventId}`)) return;
  const tk = threadKey(e.channel, e.threadTs);
  await record({
    event_id: newEventId(),
    thread_key: tk,
    source: 'slack',
    type: 'edit',
    ts: nowIso(),
    ingested_at: nowIso(),
    payload: {
      slack_ts: e.editedTs,
      new_text: e.newText,
      ...(e.previousText !== undefined ? { previous_text: e.previousText } : {}),
    },
  });
  log.info('handler', `[${tk}] edit recorded`);
}

async function handleDelete(e: DeleteMessage): Promise<void> {
  if (e.eventId && isDuplicate(`id:${e.eventId}`)) return;
  const tk = threadKey(e.channel, e.threadTs);
  await deleteAttachmentsForSlackTs(tk, e.deletedTs);
  await record({
    event_id: newEventId(),
    thread_key: tk,
    source: 'slack',
    type: 'delete',
    ts: nowIso(),
    ingested_at: nowIso(),
    payload: { slack_ts: e.deletedTs },
  });
  log.info('handler', `[${tk}] delete recorded`);
}

function slackTsToIso(slackTs: string): string {
  return new Date(Number.parseFloat(slackTs) * 1000).toISOString();
}
