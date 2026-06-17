import { deleteSession } from '@anthropic-ai/claude-agent-sdk';
import type { WebClient } from '@slack/web-api';
import { log } from '../../shared/log';
import { refFor, teardownSession } from '../git/bootstrap';
import { deleteAttachmentsForSlackTs, downloadFiles } from '../persistence/attachments';
import { backfillIfNew } from '../persistence/backfill';
import { newEventId, nowIso, record } from '../persistence/events';
import { deleteThreadData } from '../persistence/store';
import { buildSystemPrompt } from '../prompt';
import { kickoffEnsureContainer, removeContainer } from '../sandbox';
import type { DeleteMessage, EditMessage, IncomingEvent, NormalMessage } from '../slack/events';
import { postInThread } from '../slack/post';
import { resolveByThreadText } from './asks';
import { parseCommand } from './commands';
import { dedupeKey } from './dedupe';
import { isDuplicate } from './dedupe-store';
import {
  type DisplayConfig,
  type HomeConfig,
  type ModelTriplet,
  resolveTransport,
} from './home-config';
import { refreshHomeMirror } from './home-refresh';
import { clearThinking, markThinking, signalStop, startOrQueue } from './session';
import { readSession, setDisplay, setGit, setHome, setModel } from './session-store';
import { threadKey } from './thread';

// The bot dispatches each event with a resolved home spec (#253). The tenant
// validates it against its own env at the HTTP boundary (`http.ts` calls
// `resolveHomeFromEnvelope`) and forwards the resulting `HomeConfig` here.
// It is frozen per-thread on first mention, same as before.
export type EnvelopeContext = {
  home: HomeConfig;
  // Env-derived model triplet (MODEL_NAME selects the model; the SDK learns its
  // backend from env — CLAUDE_CODE_USE_BEDROCK + AWS creds, or ANTHROPIC_*).
  // Required for production. Frozen per-thread on first mention.
  fallbackModel: ModelTriplet | undefined;
  // Optional UX style override (defaults to 'verbose'). Until a per-deploy
  // env knob exists this is left undefined; the legacy default is preserved.
  display?: DisplayConfig;
  // The Slack team/workspace id (envelope.workspace_id). Required by the
  // `task_update` streaming display style: `chat.startStream` rejects a
  // channel-thread stream without `recipient_team_id` (#285 spike). Carried
  // here so the turn can mint the recipient pair without re-reading the
  // envelope. Optional so unit tests that don't exercise streaming can omit it.
  workspaceId?: string;
};

// `web` + `botToken` (the request-scoped xoxb) come from the envelope. The
// tenant builds a fresh WebClient per /events POST so a rotation in the bot's
// installation store takes effect on the next event without a tenant restart.
export function makeEventHandler(
  web: WebClient,
  botToken: string,
  botUserId: string,
  ctx: EnvelopeContext,
): (e: IncomingEvent) => Promise<void> {
  return async (e) => {
    if (e.kind === 'message') {
      return handleMessage(web, botToken, botUserId, ctx, e);
    }
    if (e.kind === 'edit') return handleEdit(e);
    if (e.kind === 'delete') return handleDelete(e);
  };
}

async function handleMessage(
  web: WebClient,
  botToken: string,
  botUserId: string,
  ctx: EnvelopeContext,
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
  if (await isDuplicate(key)) {
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

  if (cmd === 'verbose' || cmd === 'pretty' || cmd === 'task_update') {
    await setDisplay(tk, { style: cmd });
    await postInThread(web, e.channel, e.threadTs, `switched to ${cmd} mode`).catch(() => {});
    log.info('handler', `[${tk}] /${cmd}`);
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
    // Best-effort: drop the SDK session if this thread ran on the SDK harness
    // (#303). Read the id BEFORE deleteThreadData removes session.json. No-op
    // for bespoke-harness threads (no sdk_session_id) and tolerant of SDK
    // errors so /delete never fails on the SDK side.
    const sdkSessionId = (await readSession(tk))?.sdk_session_id;
    if (sdkSessionId) {
      await deleteSession(sdkSessionId).catch((err) => {
        log.warn('handler', `[${tk}] SDK deleteSession failed: ${(err as Error).message}`);
      });
    }
    await Promise.all([deleteThreadData(tk), removeContainer(tk)]);
    log.info('handler', `[${tk}] /delete done`);
    return;
  }

  // Fire the 🤔 reaction at the earliest point — right before we commit to a
  // turn, fire-and-forget on the triggering message — so the user gets
  // near-instant acknowledgement instead of waiting on the model/home resolve
  // chain inside kickoffTurn (#283). Ownership is session-level: the reaction
  // is removed in bulk when the thread goes idle (startOrQueue's finally).
  markThinking(web, tk, e.channel, e.ts);
  try {
    await kickoffTurn(web, tk, e.channel, e.threadTs, e.user, ctx);
  } catch (err) {
    // kickoffTurn threw before startOrQueue's finally could run (e.g. model/
    // home resolution failed) — clear the 🤔 so we don't orphan it, then
    // rethrow so the HTTP boundary still surfaces the error.
    await clearThinking(web, tk).catch(() => {});
    throw err;
  }
}

// Shared seam: handler.handleMessage uses this after recording a mention;
// recovery.ts uses it to re-fire a turn for a thread that died with a
// queued mention. Splits out the prompt/model resolve + sandbox warmup +
// startOrQueue from the Slack-event-specific preamble (dedupe, file
// download, JSONL append). Caller must have already recorded the
// triggering mention(s) into JSONL.
export async function kickoffTurn(
  web: WebClient,
  tk: string,
  channel: string,
  threadTs: string,
  userId: string,
  ctx: EnvelopeContext,
): Promise<void> {
  // Per-thread frozen system prompt + home (from the envelope): composed on
  // the first mention and persisted into session.json so every subsequent
  // turn in this thread sees the same prompt + home even if the bot's
  // tenants.json swaps the channel's home in the meantime. README.md /
  // skills / UNIVERSAL_PROMPT_SUFFIX edits DO propagate (the prompt is
  // rebuilt every turn from disk — see `buildSystemPrompt`). `clearSession`
  // writes idle (preserving these) so the file is there across turns; only
  // `/delete` removes it.
  const { prompt, model, display } = await resolveSystemPromptAndModel(web, tk, userId, ctx);

  // Sandbox warmup: kick off provisioning in the background as soon as a
  // turn is committed. The SDK tool loop (mcp-tools.ts) awaits the same
  // in-flight promise via ensureContainer() (the per-thread dedup lives in
  // src/sandbox/index.ts), so if the sandbox is ready by the time a
  // requiresSandbox tool fires, no UI line is shown. If it's still
  // provisioning, the user sees a single "_waiting for workspace to become
  // available…_" line until it lands. Idempotent + cheap when already up.
  // Mentions that never exercise a sandbox-touching tool (pure chat, time,
  // fetch_url, ask_user) still trigger the warmup — that's a deliberate
  // trade: a small amount of wasted provisioning for zero first-tool latency
  // on the common case.
  kickoffEnsureContainer(tk);

  await startOrQueue(
    web,
    prompt,
    {
      channel,
      threadTs,
      threadKey: tk,
      // Recipient pair for the `task_update` streaming style (#285).
      // `chat.startStream` requires both on a channel-thread stream; the
      // user id is the mentioning user, the team id rides in on the
      // envelope. Harmlessly carried for verbose/pretty too (unused there).
      recipientUserId: userId,
      recipientTeamId: ctx.workspaceId,
    },
    model,
    display.style,
  );
}

async function resolveSystemPromptAndModel(
  web: WebClient,
  tk: string,
  userId: string,
  ctx: EnvelopeContext,
): Promise<{ prompt: string; model: ModelTriplet; display: DisplayConfig }> {
  const existing = await readSession(tk);

  // Home / model / display stay frozen per thread — mid-thread swaps would
  // be surprising. Backfill any missing field from the current envelope/env
  // (handles sessions written before each field was added; same shape as the
  // historical migrations). For new threads, the envelope's home wins; for
  // existing ones, the snapshot frozen at first mention is preserved.
  let home = existing?.home;
  if (home === undefined) {
    home = { ...ctx.home };
    await setHome(tk, home);
  }
  let model = existing?.model;
  if (model === undefined) {
    if (!ctx.fallbackModel) {
      throw new Error(
        `[${tk}] cannot resolve model: no env fallback (set MODEL_API_KEY + MODEL_BASE_URL + MODEL_NAME)`,
      );
    }
    model = { ...ctx.fallbackModel };
    await setModel(tk, model);
  }
  let display = existing?.display;
  if (display === undefined) {
    display = ctx.display ? { ...ctx.display } : { style: 'verbose' };
    await setDisplay(tk, display);
  }

  // First-mention only: resolve + cache the originating Slack user's
  // identity into session.json. bootstrap.ts reads it back so commits
  // inside the sandbox land under the human's name/email.
  if (existing?.git?.creator === undefined) {
    const creator = await resolveCreator(web, userId);
    if (creator) {
      await setGit(tk, { ref: refFor(tk), creator });
    }
  }

  // The system prompt is rebuilt from disk on every mention so edits to
  // the universal suffix (prompt.ts) and the home repo's README.md /
  // skills/ propagate to existing threads on their next mention.
  // Refresh the host-side mirror first so upstream commits land before
  // the prompt is composed. Non-fatal: errors are logged and we fall
  // through to whatever is on disk. Skipped for the AGENT_HOME_DIR test
  // override so unit/e2e tests don't try to fetch from a tmpdir.
  if (!process.env.AGENT_HOME_DIR) {
    await refreshHomeMirror(home);
  }
  const agentHomeDir = resolveAgentHomeForPrompt(home);
  const composed = await buildSystemPrompt(agentHomeDir);
  return { prompt: composed, model, display };
}

// Test override hatch: `AGENT_HOME_DIR` short-circuits the configured
// remote and points the prompt builder at the test's tmpdir. Production
// never sets it.
function resolveAgentHomeForPrompt(home: HomeConfig): string {
  const override = process.env.AGENT_HOME_DIR;
  if (override && override.length > 0) return override;
  return resolveTransport(home).localPath;
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
    const name = u.real_name ?? u.profile?.display_name ?? u.profile?.real_name ?? u.name ?? userId;
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
  if (e.eventId && (await isDuplicate(`id:${e.eventId}`))) return;
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
  if (e.eventId && (await isDuplicate(`id:${e.eventId}`))) return;
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
