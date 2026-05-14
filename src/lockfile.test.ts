import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquire } from './lockfile';

// Each test uses a unique name to avoid colliding across runs.
let acquired: string[] = [];
function uniqueName(prefix: string): string {
  const name = `test-${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  acquired.push(name);
  return name;
}

afterEach(() => {
  for (const name of acquired) {
    const path = join(tmpdir(), `agenta-${name}.lock`);
    try {
      unlinkSync(path);
    } catch {}
  }
  acquired = [];
});

describe('lockfile', () => {
  test('acquire creates a lockfile', () => {
    const name = uniqueName('basic');
    const lock = acquire(name);
    expect(existsSync(join(tmpdir(), `agenta-${name}.lock`))).toBe(true);
    lock.release();
    expect(existsSync(join(tmpdir(), `agenta-${name}.lock`))).toBe(false);
  });

  test('second acquire with the same name throws while the first is held', () => {
    const name = uniqueName('conflict');
    const lock = acquire(name);
    try {
      expect(() => acquire(name)).toThrow(/held by pid/);
    } finally {
      lock.release();
    }
  });

  test('release is idempotent', () => {
    const name = uniqueName('idem');
    const lock = acquire(name);
    lock.release();
    lock.release();
    expect(existsSync(join(tmpdir(), `agenta-${name}.lock`))).toBe(false);
  });

  test('stale lockfile from a dead pid is stolen', async () => {
    const name = uniqueName('stale');
    const path = join(tmpdir(), `agenta-${name}.lock`);
    // Forge a stale lockfile owned by pid 1 (init) but pretend dead by
    // using a pid extremely unlikely to exist: 2^31 - 1.
    const fakeDeadPid = 2147483647;
    Bun.write(path, `${fakeDeadPid} 1970-01-01T00:00:00Z\n`);
    // Synchronous step needed; force it via fs
    const fs = await import('node:fs');
    fs.writeFileSync(path, `${fakeDeadPid} 1970-01-01T00:00:00Z\n`);
    expect(existsSync(path)).toBe(true);

    const lock = acquire(name);
    expect(existsSync(path)).toBe(true); // the new lock is in place
    lock.release();
  });
});
