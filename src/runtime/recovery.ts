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
// 'stopping' when the previous process died. Auto-retry the interrupted
// turn transparently: the JSONL has the full conversation so buildMessages
// reconstructs the same context the model was processing when it got
// killed. The user sees a brief gap then gets their answer — no
// "agent restarted" notice cluttering the thread.
//
// 'stopping' sessions are NOT retried (the user explicitly issued /stop;
// retrying would violate that intent). They're just cleared silently.
export async function recoverInterruptedSessions(deps: RecoveryDeps): Promise<void> {
  const { web, botUserId, fallbackModel, callModelOverride } = deps;
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

    // 'running' = turn was actively in flight. Find the user who triggered
    // it (needed for kickoffTurn's creator resolution). Fall back to the
    // bot's own id if we can't determine the originator — the turn will
    // still fire, just with a generic git identity.
    const originator = await findLastMentionUser(threadKey, botUserId);

    // Reset to idle BEFORE kicking off so startOrQueue's idempotent
    // running-flip writes against a clean state.
    await clearSession(threadKey);
    try {
      await kickoffTurn(
        web,
        threadKey,
        decoded.channel,
        decoded.threadTs,
        originator,
        fallbackModel,
        callModelOverride,
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
