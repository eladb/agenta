import type { WebClient } from '@slack/web-api';
import { log } from '../../shared/log';
import { addReaction, postInThread, removeReaction } from '../slack/post';
import type { DisplayStyle, ModelTriplet } from './home-config';
import { runSdkTurn } from './sdk-turn';
import { clearSession, preservedFields, updateSession } from './session-store';

// Per-turn Slack routing handed to runSdkTurn. The recipient pair is required
// by the `task_update` streaming display style (#285) — `chat.startStream`
// rejects a channel-thread stream without `recipient_team_id`; carried
// (unused) for verbose/pretty too. Optional so unit tests can omit them.
export type TurnInput = {
  channel: string;
  threadTs: string;
  threadKey: string;
  recipientUserId?: string;
  recipientTeamId?: string;
};

type Status = 'idle' | 'running' | 'stopping';

// The 🤔 "thinking" reaction is the bot's first "I got your message, I'm
// working on it" signal. The handler fires it (via markThinking) the instant
// a mention is committed to a turn — long before the model/home resolve — so
// it lands near-instantly. Ownership is session-level (not per-turn): a burst
// of mentions coalesces into one session, and all of their reactions are
// cleared together when the thread returns to idle (#283).
const REACTION_THINKING = 'thinking_face';

type Session = {
  status: Status;
  abort?: AbortController;
  // True when a mention arrived during a running/stopping turn — drives
  // batching: after the current turn finishes we run one more turn that
  // picks up everything queued (the JSONL already has the new messages).
  pending: boolean;
  // Thinking (🤔) reactions added for this session's in-flight mentions.
  // Removed in bulk when the thread goes idle (startOrQueue's finally) or
  // when kickoffTurn throws before startOrQueue runs (clearThinking).
  thinking: Array<{ channel: string; ts: string }>;
};

const sessions = new Map<string, Session>();

function getSession(tk: string): Session {
  let s = sessions.get(tk);
  if (!s) {
    s = { status: 'idle', pending: false, thinking: [] };
    sessions.set(tk, s);
  }
  return s;
}

export function getStatus(tk: string): Status {
  return sessions.get(tk)?.status ?? 'idle';
}

// Record + fire a 🤔 reaction on a mention the handler just committed to a
// turn. Best-effort: addReaction swallows errors, and we don't await it from
// the handler — the point is instant feedback, not blocking the turn kickoff.
// The {channel, ts} is tracked on the session so the batch cleanup
// (startOrQueue's finally) removes every one when the thread goes idle.
export function markThinking(web: WebClient, tk: string, channel: string, ts: string): void {
  const s = getSession(tk);
  s.thinking.push({ channel, ts });
  void addReaction(web, channel, ts, REACTION_THINKING);
}

// Remove every 🤔 reaction recorded for this session and clear the list.
// Called once per batch when the thread returns to idle, and by the handler
// if kickoffTurn throws before startOrQueue ever runs (no-orphan guarantee).
export async function clearThinking(web: WebClient, tk: string): Promise<void> {
  const s = sessions.get(tk);
  if (!s || s.thinking.length === 0) return;
  const pending = s.thinking;
  s.thinking = [];
  await Promise.all(pending.map((r) => removeReaction(web, r.channel, r.ts, REACTION_THINKING)));
}

// For tests.
export function resetSessions(): void {
  sessions.clear();
}

export async function startOrQueue(
  web: WebClient,
  systemPrompt: string,
  input: TurnInput,
  model: ModelTriplet,
  displayStyle: DisplayStyle = 'verbose',
): Promise<void> {
  const s = getSession(input.threadKey);
  if (s.status !== 'idle') {
    s.pending = true;
    log.info('session', `[${input.threadKey}] queued (status=${s.status})`);
    return;
  }
  s.status = 'running';
  s.pending = false;
  // Preserve the persisted sandbox routing record across the status flip so
  // we don't drop it on idle → running. The provider may write a fresh
  // record back during this turn (or not at all, if no sandbox-touching
  // tool runs).
  await updateSession(input.threadKey, (prior) => ({
    status: 'running',
    updated_at: '',
    ...preservedFields(prior),
  }));
  try {
    while (true) {
      s.abort = new AbortController();
      await runSdkTurn(web, systemPrompt, input, s.abort.signal, displayStyle, model);
      if (!s.pending) break;
      s.pending = false;
      // If /stop fired during the turn we are now in 'stopping'; flip back
      // to 'running' since the user has since sent a new mention.
      s.status = 'running';
      await updateSession(input.threadKey, (carry) => ({
        status: 'running',
        updated_at: '',
        ...preservedFields(carry),
      }));
    }
  } finally {
    s.status = 'idle';
    s.abort = undefined;
    s.pending = false;
    // Once-per-batch cleanup: remove every 🤔 the handler added for the
    // mentions that coalesced into this session. Best-effort.
    await clearThinking(web, input.threadKey);
    await clearSession(input.threadKey);
  }
}

export async function signalStop(
  web: WebClient,
  channel: string,
  threadTs: string,
  tk: string,
): Promise<void> {
  const s = getSession(tk);
  if (s.status === 'running' && s.abort) {
    s.status = 'stopping';
    s.pending = false;
    // Persist BEFORE firing abort: otherwise the abort cascade lets the
    // turn's `finally { clearSession }` race ahead of our write and leave a
    // stale `stopping` file behind. updateSession serializes both writes on
    // the same per-thread lock, so awaiting it here guarantees the ordering.
    await updateSession(tk, (carry) => ({
      status: 'stopping',
      updated_at: '',
      ...preservedFields(carry),
    }));
    s.abort.abort();
    log.info('session', `[${tk}] stop signaled`);
    return;
  }
  await postInThread(web, channel, threadTs, 'stopped').catch(() => {});
}
