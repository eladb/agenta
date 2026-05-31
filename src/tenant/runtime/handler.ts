import type { WebClient } from '@slack/web-api';
import { refFor, teardownSession } from '../git/bootstrap';
import { log } from '../../shared/log';
import { type CallModel, createCallModel } from '../model/gateway';
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
  resolveDisplay,
  resolveHome,
  resolveModel,
  resolveTransport,
} from './home-config';
import { refreshHomeMirror } from './home-refresh';
import { signalStop, startOrQueue } from './session';
import { readSession, setDisplay, setGit, setHome, setModel } from './session-store';
import { threadKey } from './thread';

// `fallbackModel` is the env-derived triplet (MODEL_NAME / MODEL_BASE_URL /
// MODEL_API_KEY) — used when neither the channel's nor the default home's
// `model` block is present. Existing single-model deploys carry this fallback
// only; per-channel overrides are additive (#128).
export function makeEventHandler(
  web: WebClient,
  botToken: string,
  botUserId: string,
  fallbackModel: ModelTriplet | undefined,
  // Test seam: e2e + unit tests inject a stubbed callModel directly so the
  // triplet→fetch path is bypassed. Production never passes this; the handler
  // builds the real callModel from the per-thread frozen triplet.
  callModelOverride?: CallModel,
): (e: IncomingEvent) => Promise<void> {
  return async (e) => {
    if (e.kind === 'message') {
      return handleMessage(web, botToken, botUserId, fallbackModel, callModelOverride, e);
    }
    if (e.kind === 'edit') return handleEdit(e);
    if (e.kind === 'delete') return handleDelete(e);
  };
}

async function handleMessage(
  web: WebClient,
  botToken: string,
  botUserId: string,
  fallbackModel: ModelTriplet | undefined,
  callModelOverride: CallModel | undefined,
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

  if (cmd === 'verbose' || cmd === 'pretty') {
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
    await Promise.all([deleteThreadData(tk), removeContainer(tk)]);
    log.info('handler', `[${tk}] /delete done`);
    return;
  }

  await kickoffTurn(web, tk, e.channel, e.threadTs, e.user, fallbackModel, callModelOverride);
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
  fallbackModel: ModelTriplet | undefined,
  callModelOverride: CallModel | undefined,
): Promise<void> {
  // Per-thread frozen system prompt + per-channel home: composed on the
  // first mention and persisted into session.json so every subsequent turn
  // in this thread sees the same prompt + home even if README.md / skills /
  // config/homes.json change in the meantime. `clearSession` writes idle
  // (preserving these) so the file is there across turns; only `/delete`
  // removes it.
  const { prompt, model, display } = await resolveSystemPromptAndModel(
    web,
    tk,
    channel,
    userId,
    fallbackModel,
  );
  // Build the per-thread callModel from the frozen triplet (env-name only —
  // the secret value is read at every call inside createCallModel). Tests
  // pass `callModelOverride` to bypass this and inject a stub.
  const callModel: CallModel =
    callModelOverride ??
    createCallModel({
      apiKeyEnv: model.api_key_env,
      baseUrl: model.base_url,
      model: model.name,
    });

  // Sandbox warmup: kick off provisioning in the background as soon as a
  // turn is committed. The foreground tool loop in turn.ts awaits the same
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
    callModel,
    prompt,
    {
      channel,
      threadTs,
      threadKey: tk,
    },
    display.style,
  );
}

async function resolveSystemPromptAndModel(
  web: WebClient,
  tk: string,
  channelId: string,
  userId: string,
  fallbackModel: ModelTriplet | undefined,
): Promise<{ prompt: string; model: ModelTriplet; display: DisplayConfig }> {
  const existing = await readSession(tk);

  // Home / model / display stay frozen per thread — mid-thread swaps would
  // be surprising. Backfill any missing field from current config (handles
  // sessions written before each field was added; same shape as the
  // historical migrations).
  let home = existing?.home;
  if (home === undefined) {
    home = resolveHome(channelId);
    await setHome(tk, home);
  }
  let model = existing?.model;
  if (model === undefined) {
    const resolved = resolveModel(channelId, fallbackModel);
    if (!resolved) {
      throw new Error(
        `[${tk}] cannot resolve model: no per-channel/default in homes.json and no env fallback (set MODEL_API_KEY + MODEL_BASE_URL + MODEL_NAME, or add a model block to homes.json)`,
      );
    }
    model = resolved;
    await setModel(tk, model);
  }
  let display = existing?.display;
  if (display === undefined) {
    display = resolveDisplay(channelId);
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
