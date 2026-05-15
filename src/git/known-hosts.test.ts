import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureKnownHostsCache } from './known-hosts';

const hasSshKeyscan = Bun.which('ssh-keyscan') !== null;

// Best-effort check whether sshd is reachable on localhost:22. If it isn't,
// we skip the keyscan tests rather than fail — many CI environments don't
// run sshd, and that's fine.
async function sshdReachable(): Promise<boolean> {
  try {
    const socket = await Bun.connect({
      hostname: 'localhost',
      port: 22,
      socket: { open() {}, data() {}, close() {}, error() {} },
    });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

let cacheDir: string;
let canRun = false;

beforeEach(async () => {
  cacheDir = mkdtempSync(join(tmpdir(), 'agenta-knownhosts-'));
  canRun = hasSshKeyscan && (await sshdReachable());
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

describe('ensureKnownHostsCache', () => {
  test('writes a non-empty known_hosts file on first call; idempotent thereafter', async () => {
    if (!canRun) return; // skipped — see file comment
    const p1 = await ensureKnownHostsCache(cacheDir);
    expect(p1.endsWith('known_hosts')).toBe(true);
    const body1 = readFileSync(p1, 'utf8');
    expect(body1.length).toBeGreaterThan(0);
    const p2 = await ensureKnownHostsCache(cacheDir);
    expect(p2).toBe(p1);
    const body2 = readFileSync(p2, 'utf8');
    expect(body2).toBe(body1);
  });
});
