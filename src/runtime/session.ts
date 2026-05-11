import type { WebClient } from '@slack/web-api';
import { log } from '../log';
import type { CallModel } from '../model/gateway';
import { postInThread } from '../slack/post';
import { runTurn, type TurnInput } from './turn';

type Status = 'idle' | 'running' | 'stopping';

type Session = {
  status: Status;
  abort?: AbortController;
  // True when a mention arrived during a running/stopping turn — drives
  // batching: after the current turn finishes we run one more turn that
  // picks up everything queued (the JSONL already has the new messages).
  pending: boolean;
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
  if (s.status !== 'idle') {
    s.pending = true;
    log.info('session', `[${input.threadKey}] queued (status=${s.status})`);
    return;
  }
  s.status = 'running';
  s.pending = false;
  try {
    while (true) {
      s.abort = new AbortController();
      await runTurn(web, callModel, systemPrompt, input, s.abort.signal);
      if (!s.pending) break;
      s.pending = false;
      // If /stop fired during the turn we are now in 'stopping'; flip back
      // to 'running' since the user has since sent a new mention.
      s.status = 'running';
    }
  } finally {
    s.status = 'idle';
    s.abort = undefined;
    s.pending = false;
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
    s.abort.abort();
    log.info('session', `[${tk}] stop signaled`);
    return;
  }
  await postInThread(web, channel, threadTs, 'stopped').catch(() => {});
}
