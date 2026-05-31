import { describe, expect, test } from 'bun:test';
import { startWatchdog } from './watchdog';

type AuthCall = () => Promise<unknown>;

function makeWeb(impl: AuthCall) {
  return { auth: { test: impl } } as Parameters<typeof startWatchdog>[0]['web'];
}

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Parameters<typeof startWatchdog>[0]['log'];

// Small helper: yield to the microtask queue enough times that every chained
// promise inside the watchdog tick has settled before we observe state.
async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

// Wait until predicate is true or timeout. Each iteration sleeps 5ms so the
// interval callback has a chance to fire under real (not fake) timers.
async function waitFor(pred: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timeout');
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('startWatchdog', () => {
  test('successive successes never trigger', async () => {
    let calls = 0;
    let triggered = 0;
    const stop = startWatchdog({
      web: makeWeb(async () => {
        calls += 1;
        return { ok: true };
      }),
      log: silentLog,
      intervalMs: 5,
      failureThreshold: 3,
      onTrigger: () => {
        triggered += 1;
      },
    });
    await waitFor(() => calls >= 5);
    stop();
    expect(triggered).toBe(0);
  });

  test('3 consecutive failures fire onTrigger exactly once', async () => {
    let triggered = 0;
    const stop = startWatchdog({
      web: makeWeb(async () => {
        throw new Error('nope');
      }),
      log: silentLog,
      intervalMs: 5,
      failureThreshold: 3,
      onTrigger: () => {
        triggered += 1;
      },
    });
    await waitFor(() => triggered >= 1);
    // Let several more intervals tick to confirm we don't re-trigger.
    await new Promise((r) => setTimeout(r, 50));
    stop();
    expect(triggered).toBe(1);
  });

  test('a success in the middle resets the counter', async () => {
    let calls = 0;
    let triggered = 0;
    const stop = startWatchdog({
      web: makeWeb(async () => {
        calls += 1;
        // Pattern: fail, fail, success, fail, fail, fail, ... only the last
        // run of 3 should fire. Total calls until trigger: 6.
        if (calls === 3) return { ok: true };
        if (calls >= 1 && calls <= 5) throw new Error('boom');
        // After 6th call (3rd consecutive fail since reset), trigger fires.
        // Keep failing in case the interval ticks again before stop().
        throw new Error('boom');
      }),
      log: silentLog,
      intervalMs: 5,
      failureThreshold: 3,
      onTrigger: () => {
        triggered += 1;
      },
    });
    await waitFor(() => triggered >= 1);
    stop();
    expect(triggered).toBe(1);
    // Need at least 6 calls: 2 failures + 1 success (reset) + 3 failures.
    expect(calls).toBeGreaterThanOrEqual(6);
  });

  test('stop() halts pings', async () => {
    let calls = 0;
    const stop = startWatchdog({
      web: makeWeb(async () => {
        calls += 1;
        return { ok: true };
      }),
      log: silentLog,
      intervalMs: 5,
      failureThreshold: 3,
      onTrigger: () => {},
    });
    await waitFor(() => calls >= 2);
    stop();
    const after = calls;
    await new Promise((r) => setTimeout(r, 50));
    await flush();
    // Allow at most one in-flight tick that started before stop().
    expect(calls - after).toBeLessThanOrEqual(1);
  });
});
