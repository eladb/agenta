import type { WebClient } from '@slack/web-api';
import { log } from '../log';
import { postInThread } from '../slack/post';
import { clearRuntime, listRuntimes } from './runtime-store';
import { decodeThreadKey } from './thread';

// On boot, find any thread whose runtime.json says it was 'running' or
// 'stopping' when the previous process died. Post a notice in the thread so
// the user knows what happened, then clear the runtime entry so the thread
// starts fresh on the next mention.
//
// We don't try to resume the interrupted turn — the model call is gone and
// any partial tool execution would be confusing to replay. The user can
// re-mention to start over.
export async function recoverInterruptedSessions(web: WebClient): Promise<void> {
  const interrupted = await listRuntimes();
  if (interrupted.length === 0) return;
  log.info('recovery', `found ${interrupted.length} interrupted session(s)`);
  for (const { threadKey, state } of interrupted) {
    const decoded = decodeThreadKey(threadKey);
    if (!decoded) {
      log.warn('recovery', `[${threadKey}] could not decode threadKey; clearing entry`);
      await clearRuntime(threadKey);
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
    await clearRuntime(threadKey);
  }
}
