import type { WebClient } from '@slack/web-api';
import { removeEntry as removeAuthorizedKeysEntry } from '../git/authorized-keys';
import { log } from '../log';
import type { CallModel } from '../model/gateway';
import { deleteAttachmentsForSlackTs, downloadFiles } from '../persistence/attachments';
import { backfillIfNew } from '../persistence/backfill';
import { newEventId, nowIso, record } from '../persistence/events';
import { deleteThreadData } from '../persistence/store';
import { buildSystemPrompt } from '../prompt';
import { removeContainer } from '../sandbox';
import type { DeleteMessage, EditMessage, IncomingEvent, NormalMessage } from '../slack/events';
import { postInThread } from '../slack/post';
import { resolveByThreadText } from './asks';
import { parseCommand } from './commands';
import { createDedupe, dedupeKey } from './dedupe';
import { signalStop, startOrQueue } from './session';
import { readSession, writeSession } from './session-store';
import { threadKey } from './thread';

const isDuplicate = createDedupe();

export function makeEventHandler(
  web: WebClient,
  botToken: string,
  botUserId: string,
  callModel: CallModel,
): (e: IncomingEvent) => Promise<void> {
  return async (e) => {
    if (e.kind === 'message') {
      return handleMessage(web, botToken, botUserId, callModel, e);
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

  // Text-override: if a non-mention reply in this thread can resolve a
  // pending ask_user, do that first. The pending ask consumes the text as
  // its tool_result, so we don't also enqueue this as a new mention.
  if (!e.isMention && resolveByThreadText(tk, e.text)) {
    log.info('handler', `[${tk}] resolved pending ask via text reply`);
    return;
  }

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
    // Drop the host-side authorized_keys entry first — it's the only piece
    // of agenta state living outside the thread dir + sandbox. Best-effort:
    // a missing file or missing entry isn't an error. The model's work
    // product on the host repo (the agenta/sessions/<thread_key> branch) is
    // intentionally NOT deleted.
    await removeAuthorizedKeysEntry(tk).catch((err) => {
      log.warn('handler', `[${tk}] removeAuthorizedKeysEntry failed: ${(err as Error).message}`);
    });
    await Promise.all([deleteThreadData(tk), removeContainer(tk)]);
    log.info('handler', `[${tk}] /delete done`);
    return;
  }

  // Per-thread frozen system prompt: composed on the first mention and
  // persisted into session.json so every subsequent turn in this thread
  // sees the same prompt even if README.md / skills change in the meantime.
  // `clearSession` writes idle (preserving system_prompt) so the file is
  // there across turns; only `/delete` removes it.
  const prompt = await resolveSystemPrompt(tk);

  // Sandbox provisioning is deferred — see turn.ts. The first tool that
  // sets requiresSandbox triggers `ensureContainer` and surfaces a
  // "🛠️ provisioning workspace…" line in the checklist. Mentions that
  // never use a sandbox-touching tool (just chat, time, fetch_url, ask_user)
  // pay nothing.

  await startOrQueue(web, callModel, prompt, {
    channel: e.channel,
    threadTs: e.threadTs,
    threadKey: tk,
  });
}

async function resolveSystemPrompt(tk: string): Promise<string> {
  const existing = await readSession(tk);
  if (existing?.system_prompt !== undefined) return existing.system_prompt;
  const composed = await buildSystemPrompt();
  // Persist as idle so it survives this turn and any future ones. session.ts
  // will overwrite the file with running/stopping/idle as it transitions,
  // always carrying `system_prompt` forward.
  await writeSession(tk, {
    status: 'idle',
    updated_at: nowIso(),
    system_prompt: composed,
  });
  return composed;
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
