import type { WebClient } from '@slack/web-api';
import { log } from '../log';
import type { CallModel } from '../model/gateway';
import type { AgentaEvent } from '../persistence/events';
import { readEvents } from '../persistence/store';
import { postInThread } from '../slack/post';
import { kickoffTurn } from './handler';
import type { ModelTriplet } from './home-config';
import { clearSession, listSessions } from './session-store';
import { decodeThreadKey } from './thread';

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
// 'stopping' when the previous process died. Post a notice in the thread so
// the user knows what happened. If the JSONL shows a pending mention that
// arrived after the last assistant message (i.e. a mention the previous
// process never got to answer), auto-resume by kicking off a fresh turn —
// the model context replay via JSONL picks the mention up the same way it
// would for a regular mid-turn queued message (#44).
//
// Otherwise just clear the runtime entry so the thread starts fresh on the
// next mention.
export async function recoverInterruptedSessions(deps: RecoveryDeps): Promise<void> {
  const { web, botUserId, fallbackModel, callModelOverride } = deps;
  // Idle entries exist for any thread that has ever been mentioned (the
  // frozen routing lives there). Filter to non-idle so we only
  // announce real interruptions.
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
    const text = `agent restarted — previous turn was interrupted (was ${state.status})`;
    try {
      await postInThread(web, decoded.channel, decoded.threadTs, text);
    } catch (err) {
      // Slack channel might be archived, message deleted, etc. Don't block
      // the rest of recovery on a single bad thread.
      log.warn('recovery', `[${threadKey}] postInThread failed: ${(err as Error).message}`);
    }

    // Did the previous process die with a pending mention? Scan JSONL.
    let pending: { user: string } | undefined;
    try {
      pending = await findPendingMention(threadKey, botUserId);
    } catch (err) {
      log.warn(
        'recovery',
        `[${threadKey}] JSONL scan failed: ${(err as Error).message}; clearing without resume`,
      );
    }

    if (pending) {
      // Reset to idle BEFORE kicking off so startOrQueue's idempotent
      // running-flip writes against a clean state. kickoffTurn does its
      // own writeSession.
      await clearSession(threadKey);
      try {
        await kickoffTurn(
          web,
          threadKey,
          decoded.channel,
          decoded.threadTs,
          pending.user,
          fallbackModel,
          callModelOverride,
        );
        log.info('recovery', `[${threadKey}] auto-resumed pending mention`);
      } catch (err) {
        log.warn('recovery', `[${threadKey}] kickoffTurn failed: ${(err as Error).message}`);
      }
      continue;
    }

    await clearSession(threadKey);
  }
}

// Returns the user id of the latest unanswered mention in this thread,
// or undefined if none. A mention is "unanswered" when it sits after the
// last assistant `message` event (= the boundary that marks "previous turn
// completed and posted to Slack"). If there's no assistant message at all,
// every mention since file start counts.
async function findPendingMention(
  threadKey: string,
  botUserId: string,
): Promise<{ user: string } | undefined> {
  const events = await readEvents<AgentaEvent>(threadKey);
  let boundary = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev && ev.source === 'assistant' && ev.type === 'message') {
      boundary = i;
      break;
    }
  }
  const needle = `<@${botUserId}>`;
  for (let i = events.length - 1; i > boundary; i--) {
    const ev = events[i];
    if (!ev) continue;
    if (ev.source !== 'slack' || ev.type !== 'message') continue;
    const text = ev.payload?.text ?? '';
    if (text.includes(needle)) {
      return { user: ev.payload.user };
    }
  }
  return undefined;
}
