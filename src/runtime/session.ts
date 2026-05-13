import type { WebClient } from '@slack/web-api';
import { log } from '../log';
import type { CallModel } from '../model/gateway';
import { postInThread } from '../slack/post';
import { clearSession, readSession, writeSession } from './session-store';
import { runTurn, type TurnInput } from './turn';

function nowIso(): string {
  return new Date().toISOString();
}

type Status = 'idle' | 'running' | 'stopping';

type Session = {
  status: Status;
  abort?: AbortController;
  // True when a mention arrived during a running/stopping turn — drives
  // batching: after the current turn finishes we run one more turn that
  // picks up everything queued (the JSONL already has the new messages).
  pending: boolean;
  // Frozen system prompt for this thread. Threaded through every
  // writeSession call so the file always carries it forward.
  systemPrompt?: string;
};

const sessions = new Map<string, Session>();

function getSession(tk: string): Session {
  let s = sessions.get(tk);
  if (!s) {
    s = { status: 'idle', pending: false };
    sessions.set(tk, s);
  }
  return s;
}

export function getStatus(tk: string): Status {
  return sessions.get(tk)?.status ?? 'idle';
}

// For tests.
export function resetSessions(): void {
  sessions.clear();
}

export async function startOrQueue(
  web: WebClient,
  callModel: CallModel,
  systemPrompt: string,
  input: TurnInput,
): Promise<void> {
  const s = getSession(input.threadKey);
  // Track the frozen prompt for this thread on the in-memory session so all
  // subsequent runtime writes carry it forward.
  s.systemPrompt = systemPrompt;
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
  const prior = await readSession(input.threadKey);
  await writeSession(input.threadKey, {
    status: 'running',
    updated_at: nowIso(),
    system_prompt: systemPrompt,
    ...(prior?.sandbox !== undefined ? { sandbox: prior.sandbox } : {}),
  });
  try {
    while (true) {
      s.abort = new AbortController();
      await runTurn(web, callModel, systemPrompt, input, s.abort.signal);
      if (!s.pending) break;
      s.pending = false;
      // If /stop fired during the turn we are now in 'stopping'; flip back
      // to 'running' since the user has since sent a new mention.
      s.status = 'running';
      const carry = await readSession(input.threadKey);
      await writeSession(input.threadKey, {
        status: 'running',
        updated_at: nowIso(),
        system_prompt: systemPrompt,
        ...(carry?.sandbox !== undefined ? { sandbox: carry.sandbox } : {}),
      });
    }
  } finally {
    s.status = 'idle';
    s.abort = undefined;
    s.pending = false;
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
    // turn's `finally { clearSession }` race ahead of our writeSession and
    // leave a stale `stopping` file behind.
    const carry = await readSession(tk);
    await writeSession(tk, {
      status: 'stopping',
      updated_at: nowIso(),
      ...(s.systemPrompt !== undefined ? { system_prompt: s.systemPrompt } : {}),
      ...(carry?.sandbox !== undefined ? { sandbox: carry.sandbox } : {}),
    });
    s.abort.abort();
    log.info('session', `[${tk}] stop signaled`);
    return;
  }
  await postInThread(web, channel, threadTs, 'stopped').catch(() => {});
}
