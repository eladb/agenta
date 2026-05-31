import type { WebClient } from '@slack/web-api';
import { log } from '../../shared/log';
import type { CallModel } from '../model/gateway';
import type { AgentaEvent } from '../persistence/events';
import { readEvents } from '../persistence/store';
import { kickoffTurn } from './handler';
import type { ModelTriplet } from './home-config';
import { clearSession, listSessions } from './session-store';
import { decodeThreadKey } from './thread';

// Optional Slack-side dependencies for recovery (#253).
//
// In the legacy single-process design (Socket Mode at boot), recovery had a
// live WebClient + botUserId and could auto-retry the interrupted turn:
// re-run `kickoffTurn` so the user got their answer without seeing a
// restart notice. Under the bot↔tenant split there's no WebClient at boot —
// the xoxb is request-scoped and only arrives with `/events`. So `deps` is
// optional: when present (legacy / tests) recovery retries; when absent
// (HTTP-driven tenant boot) recovery just clears running/stopping → idle,
// silently. The frozen home in `session.json` lets us still resolve the
// model + prompt for a future retry path; for this phase the silent clear
// is the only behavior.
export type RecoveryDeps = {
  web: WebClient;
  botUserId: string;
  fallbackModel: ModelTriplet | undefined;
  // Test seam: e2e + unit tests inject a stub callModel so the recovery
  // path doesn't try to reach the real model gateway. Production passes
  // undefined; handler.kickoffTurn builds the real callModel from the
  // frozen per-thread triplet.
  callModelOverride?: CallModel;
};

// On boot, find any thread whose session.json says it was 'running' or
// 'stopping' when the previous process died.
//
//   - With Slack deps (legacy / test seam): auto-retry the interrupted turn
//     transparently. The JSONL has the full conversation so buildMessages
//     reconstructs the same context the model was processing when it got
//     killed. The user sees a brief gap then gets their answer — no
//     "agent restarted" notice cluttering the thread.
//   - Without Slack deps (HTTP-driven boot, #253): silently clear all
//     running/stopping sessions back to idle. The user's interrupted turn
//     freezes mid-message until their next mention; the spec accepts that
//     trade explicitly.
//
// 'stopping' sessions are NEVER retried (the user explicitly issued /stop;
// retrying would violate that intent). They're just cleared silently.
export async function recoverInterruptedSessions(deps?: RecoveryDeps): Promise<void> {
  const interrupted = (await listSessions()).filter(
    ({ state }) => state.status === 'running' || state.status === 'stopping',
  );
  if (interrupted.length === 0) return;
  log.info('recovery', `found ${interrupted.length} interrupted session(s)`);
  for (const { threadKey, state } of interrupted) {
    const decoded = decodeThreadKey(threadKey);
    if (!decoded) {
      log.warn('recovery', `[${threadKey}] could not decode threadKey; clearing entry`);
      await clearSession(threadKey);
      continue;
    }

    // 'stopping' = user issued /stop before the crash. Don't retry — just
    // clear and let the thread sit idle until the next mention.
    if (state.status === 'stopping') {
      await clearSession(threadKey);
      log.info('recovery', `[${threadKey}] was stopping; cleared without retry`);
      continue;
    }

    // 'running' = turn was actively in flight. Without Slack deps we can't
    // resume — the spec's accepted trade is a frozen partial message until
    // the next mention. Just clear so the next mention starts fresh.
    if (!deps) {
      await clearSession(threadKey);
      log.info('recovery', `[${threadKey}] was running; cleared (no Slack deps for retry)`);
      continue;
    }

    // Recovery with Slack deps falls back to the home frozen in session.json.
    // Without that we have nowhere to clone from on this turn — clear and
    // let the next mention re-resolve from the envelope.
    const frozenHome = state.home;
    if (!frozenHome) {
      await clearSession(threadKey);
      log.warn('recovery', `[${threadKey}] no frozen home; cleared without retry`);
      continue;
    }

    // Find the user who triggered the in-flight turn (needed for
    // kickoffTurn's creator resolution). Fall back to the bot's own id if we
    // can't determine the originator — the turn will still fire, just with a
    // generic git identity.
    const originator = await findLastMentionUser(threadKey, deps.botUserId);

    // Reset to idle BEFORE kicking off so startOrQueue's idempotent
    // running-flip writes against a clean state.
    await clearSession(threadKey);
    try {
      await kickoffTurn(
        deps.web,
        threadKey,
        decoded.channel,
        decoded.threadTs,
        originator,
        { home: frozenHome, fallbackModel: deps.fallbackModel },
        deps.callModelOverride,
      );
      log.info('recovery', `[${threadKey}] auto-retried interrupted turn`);
    } catch (err) {
      log.warn('recovery', `[${threadKey}] kickoffTurn failed: ${(err as Error).message}`);
    }
  }
}

// Returns the user id of the most recent mention in this thread's JSONL.
// Used by recovery to pass a userId to kickoffTurn (needed for git
// identity resolution). Falls back to botUserId when no mention is found
// (shouldn't happen in practice — a 'running' session means at least one
// mention was recorded).
async function findLastMentionUser(threadKey: string, botUserId: string): Promise<string> {
  try {
    const events = await readEvents<AgentaEvent>(threadKey);
    const needle = `<@${botUserId}>`;
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (!ev) continue;
      if (ev.source !== 'slack' || ev.type !== 'message') continue;
      const text = ev.payload?.text ?? '';
      if (text.includes(needle)) {
        return ev.payload.user;
      }
    }
  } catch (err) {
    log.warn('recovery', `[${threadKey}] JSONL scan failed: ${(err as Error).message}`);
  }
  return botUserId;
}
