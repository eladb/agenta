// Single-process locks for the bots. Two bots need to be solo on this
// machine: the agent (production `bun start` AND the in-process agent
// started by e2e tests, both use the same SLACK_BOT_TOKEN — they'd
// fight for Socket Mode delivery) and the tester (e2e tests share one
// TEST_BOT_TOKEN, so parallel `bun run e2e` sessions split-brain).
//
// Without a lock, the failure mode is silent: ~50% of Slack events go
// to the other process and `waitForReply` times out without any
// hint that two sockets are competing. With this lock, you get a
// clear error at acquire time pointing at the running pid.
//
// Implementation: O_CREAT|O_EXCL lockfile under tmpdir with the
// owning pid + acquire timestamp. Stale lockfiles (pid no longer
// alive) are stolen automatically. Released on `process.on('exit')`
// and on SIGINT/SIGTERM.

import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type Lock = {
  release: () => void;
};

function lockPath(name: string): string {
  return join(tmpdir(), `agenta-${name}.lock`);
}

function pidAlive(pid: number): boolean {
  try {
    // Signal 0 doesn't actually send anything — it just checks whether
    // the pid is alive and we have permission to signal it.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tryOpenExclusive(path: string): number | null {
  try {
    return openSync(path, 'wx');
  } catch {
    return null;
  }
}

function readOwner(path: string): { pid: number; ts: string } | null {
  try {
    const raw = readFileSync(path, 'utf8').trim();
    const [pidStr, ts] = raw.split(/\s+/, 2);
    const pid = Number(pidStr);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return { pid, ts: ts ?? '' };
  } catch {
    return null;
  }
}

export function acquire(name: string): Lock {
  const path = lockPath(name);

  let fd = tryOpenExclusive(path);
  if (fd === null) {
    // File exists — figure out if it's a stale lock (process died) or
    // a real conflict (process still alive).
    const owner = readOwner(path);
    if (owner && pidAlive(owner.pid)) {
      throw new Error(
        `agenta lock '${name}' held by pid ${owner.pid} (acquired ${owner.ts}). ` +
          `Stop that process first, or delete ${path} if you know it's stale.`,
      );
    }
    // Stale or unreadable. Steal it.
    try {
      unlinkSync(path);
    } catch {
      // someone else may have unlinked already — that's fine
    }
    fd = tryOpenExclusive(path);
    if (fd === null) {
      throw new Error(
        `agenta lock '${name}': raced another acquirer while stealing stale lock at ${path}. Retry.`,
      );
    }
  }

  writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
  closeSync(fd);

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      unlinkSync(path);
    } catch {
      // best-effort; another process may have stolen the stale file
    }
  };

  // Clean up on normal exit.
  process.on('exit', release);

  // Catch signals so we don't leave a stale lock if the user Ctrl-C's.
  // Other handlers in the same process are not affected (we don't call
  // process.exit ourselves — release happens via the 'exit' listener
  // once the default signal handler triggers process termination).
  const signalRelease = (signal: NodeJS.Signals): void => {
    release();
    // Re-raise so the default behavior (exit) takes over.
    process.removeListener(signal, signalRelease);
    process.kill(process.pid, signal);
  };
  process.on('SIGINT', signalRelease);
  process.on('SIGTERM', signalRelease);

  return { release };
}
