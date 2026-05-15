import type { WebClient } from '@slack/web-api';
import { refFor, teardownSession } from '../git/bootstrap';
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
    // Tear down the per-thread WS tunnel + bot-side git HTTP server
    // BEFORE removing the sandbox: closing the tunnel cleanly stops the
    // sandbox-side TCP listener and the git server exits without active
    // requests in flight. The model's work product on the host repo (the
    // agenta/sessions/<thread_key> branch) is intentionally NOT deleted.
    await teardownSession(tk).catch((err) => {
      log.warn('handler', `[${tk}] teardownSession failed: ${(err as Error).message}`);
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
  const prompt = await resolveSystemPrompt(web, tk, e.user);

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

async function resolveSystemPrompt(
  web: WebClient,
  tk: string,
  userId: string,
): Promise<string> {
  const existing = await readSession(tk);
  if (existing?.system_prompt !== undefined) return existing.system_prompt;
  const composed = await buildSystemPrompt();
  // First-mention resolution: look up the originating Slack user once and
  // cache their email + name into session.json. bootstrap.ts reads these
  // back to configure git user.email / user.name inside the sandbox so
  // commits land under the human's identity, not under the static
  // "agenta@localhost".
  const creator = await resolveCreator(web, userId);
  // Persist as idle so it survives this turn and any future ones. session.ts
  // will overwrite the file with running/stopping/idle as it transitions,
  // always carrying `system_prompt` (and `git`) forward.
  await writeSession(tk, {
    status: 'idle',
    updated_at: nowIso(),
    system_prompt: composed,
    git: creator ? { ref: refFor(tk), creator } : undefined,
  });
  return composed;
}

async function resolveCreator(
  web: WebClient,
  userId: string,
): Promise<{ email: string; name: string } | undefined> {
  try {
    const info = await web.users.info({ user: userId });
    if (!info.ok || !info.user) return undefined;
    const u = info.user;
    // Prefer real_name; fall back to display_name; last resort the user id
    // so we always have *something* non-empty.
    const name =
      u.real_name ??
      u.profile?.display_name ??
      u.profile?.real_name ??
      u.name ??
      userId;
    // Email may be hidden (guest accounts, missing scope, etc.). Synthesize
    // a stable non-routable address so each Slack user still maps to a
    // unique git author.
    const email = u.profile?.email ?? `${userId}@agenta.slack`;
    return { email, name };
  } catch (err) {
    log.warn(
      'handler',
      `users.info failed for ${userId}: ${(err as Error).message} — falling back to default git author`,
    );
    return undefined;
  }
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
