import type { WebClient } from '@slack/web-api';
import { log as defaultLog } from '../log';

// Socket Mode liveness watchdog (#41, addresses #27).
//
// Symptom we're guarding against: the WebSocket stays ESTABLISHED and the
// @slack/socket-mode library reports `connected`, but no events arrive at
// the handler. The library has no clean force-reconnect API and we don't
// trust it to shake out of the deaf state, so on sustained failure we
// just exit and let Fly restart us. `recoverInterruptedSessions` on boot
// re-announces any interrupted turns.
//
// Detection strategy: periodic `auth.test()` ping. A working Slack edge
// answers in milliseconds; if it doesn't, something is wrong with our
// connectivity to Slack (and Socket Mode events are likely affected too).
// After N consecutive failures we trigger.

export type WatchdogOptions = {
  web: Pick<WebClient, 'auth'>;
  log?: typeof defaultLog;
  intervalMs?: number;
  failureThreshold?: number;
  onTrigger?: () => void;
};

export function startWatchdog(opts: WatchdogOptions): () => void {
  const log = opts.log ?? defaultLog;
  const intervalMs = opts.intervalMs ?? 60_000;
  const failureThreshold = opts.failureThreshold ?? 3;
  const onTrigger =
    opts.onTrigger ??
    (() => {
      process.exit(1);
    });

  let consecutiveFailures = 0;
  let triggered = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped || triggered) return;
    try {
      await opts.web.auth.test();
      consecutiveFailures = 0;
    } catch (err) {
      if (stopped || triggered) return;
      consecutiveFailures += 1;
      const msg = (err as Error)?.message ?? String(err);
      log.warn(
        'watchdog',
        `auth.test failed (${consecutiveFailures}/${failureThreshold}): ${msg}`,
      );
      if (consecutiveFailures >= failureThreshold) {
        triggered = true;
        log.error(
          'watchdog',
          `socket mode liveness ping failed ${failureThreshold} times in a row — exiting so Fly restarts us`,
        );
        onTrigger();
      }
    }
  };

  const handle = setInterval(() => {
    void tick();
  }, intervalMs);
  // Don't keep the event loop alive just for the watchdog — if every other
  // listener has torn down, we want the process to exit cleanly.
  handle.unref?.();

  return function stop() {
    stopped = true;
    clearInterval(handle);
  };
}
