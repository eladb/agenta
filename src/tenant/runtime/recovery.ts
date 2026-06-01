import { log } from '../../shared/log';
import { clearSession, listSessions } from './session-store';

// Silent recovery (#253).
//
// Under the bot↔tenant split there's no WebClient at boot — the xoxb is
// request-scoped and only arrives with `/events`. The accepted spec trade
// is "frozen partial message until next mention": we don't post an "agent
// restarted" notice and we don't auto-retry the interrupted turn. We just
// reconcile state by clearing any 'running'/'stopping' marker back to
// 'idle' so the next mention in an interrupted thread starts fresh
// instead of queueing behind a phantom turn.
//
// 'stopping' was always cleared without retry (the user explicitly issued
// /stop; retrying would violate that intent). 'running' now behaves the
// same way.
export async function recoverInterruptedSessions(): Promise<void> {
  const interrupted = (await listSessions()).filter(
    ({ state }) => state.status === 'running' || state.status === 'stopping',
  );
  if (interrupted.length === 0) return;
  log.info('recovery', `found ${interrupted.length} interrupted session(s)`);
  for (const { threadKey, state } of interrupted) {
    await clearSession(threadKey);
    log.info('recovery', `[${threadKey}] was ${state.status}; cleared to idle`);
  }
}
