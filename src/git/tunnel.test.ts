// Tunnel orchestration tests. We stub:
//   - the spawn impl (so no actual autossh forks)
//   - globalThis.fetch (so runBash inside waitForReverseForward gets a
//     synthetic "exit 0" without touching a real sandbox)
//   - process.kill (so probe-signal-0 + SIGTERM both behave as scripted)
//
// What we assert:
//   - first ensureTunnel call spawns autossh with the expected argv.
//   - second call with same (threadKey, flyIp) is a no-op (no re-spawn).
//   - call with a different flyIp tears down the old pid and spawns a new
//     one.
//   - stopTunnel kills the tracked pid and forgets the handle.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetImageReadyCache, dockerProvider } from '../sandbox/docker';
import { _resetFlyState, flyProvider } from '../sandbox/fly';
import {
  _getHandle,
  _resetForTests,
  _setSpawnImpl,
  ensureTunnel,
  type SpawnFn,
  stopAllTunnels,
  stopTunnel,
} from './tunnel';

const ORIG_FETCH = globalThis.fetch;
const ORIG_KILL = process.kill;
const FAKE_BASE_URL = 'http://127.0.0.1:55555';
const FAKE_TOKEN = 'fake-bearer-token';

type GetEndpointFn = typeof dockerProvider.getEndpoint;
const origDocker: GetEndpointFn = dockerProvider.getEndpoint;
const origFly: GetEndpointFn = flyProvider.getEndpoint;

let dataDir: string;
let tunnelKeyPath: string;
// Track every pid the test "spawned" so killStub can answer "alive" for them.
let livePids: Set<number>;

function fakeEndpoint(): Promise<{ baseUrl: string; headers: Record<string, string> }> {
  return Promise.resolve({
    baseUrl: FAKE_BASE_URL,
    headers: { Authorization: `Bearer ${FAKE_TOKEN}` },
  });
}

function fetchStubAlwaysExitZero(): typeof fetch {
  // Every /exec returns exit 0 so waitForReverseForward succeeds on the
  // first poll iteration. Other endpoints aren't exercised here.
  return (async (input: string) => {
    const url = String(input);
    if (url.endsWith('/exec')) {
      const frame = `data: ${JSON.stringify({ kind: 'exit', exitCode: 0 })}\n\n`;
      return new Response(frame, { headers: { 'Content-Type': 'text/event-stream' } });
    }
    return new Response('unexpected', { status: 500 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'agenta-tunnel-'));
  process.env.AGENTA_DATA_DIR = dataDir;

  // The module checks the keypair on disk via getTunnelKeyPath(). The path
  // is fixed at ~/.ssh/agenta_tunnel_id_ed25519; we can't redirect it
  // without an env knob. So we create it (or assert it's missing for the
  // negative case) — best effort with cleanup.
  tunnelKeyPath = join(homedir(), '.ssh', 'agenta_tunnel_id_ed25519');
  if (!existsSync(tunnelKeyPath)) {
    const dir = join(homedir(), '.ssh');
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      // dir likely already exists
    }
    writeFileSync(tunnelKeyPath, 'TEST-ONLY-PLACEHOLDER\n', { mode: 0o600 });
    writeFileSync(`${tunnelKeyPath}.pub`, 'ssh-ed25519 AAAAtest agenta-tunnel-mac\n', {
      mode: 0o644,
    });
    process.env.AGENTA_TUNNEL_KEY_CLEANUP = '1';
  }

  _resetImageReadyCache();
  _resetFlyState();
  _resetForTests();
  livePids = new Set();

  (dockerProvider as { getEndpoint: GetEndpointFn }).getEndpoint = fakeEndpoint;
  (flyProvider as { getEndpoint: GetEndpointFn }).getEndpoint = fakeEndpoint;
  globalThis.fetch = fetchStubAlwaysExitZero();

  // process.kill stub: probe (signal 0) is alive iff we recorded the pid;
  // SIGTERM / SIGKILL remove it from the live set.
  (process as { kill: typeof process.kill }).kill = ((pid: number, sig?: NodeJS.Signals | 0) => {
    if (sig === 0 || sig === undefined) {
      if (!livePids.has(pid)) {
        const err = new Error(`ESRCH: no such pid ${pid}`) as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
      return true;
    }
    livePids.delete(pid);
    return true;
  }) as typeof process.kill;
});

afterEach(async () => {
  await stopAllTunnels();
  globalThis.fetch = ORIG_FETCH;
  (process as { kill: typeof process.kill }).kill = ORIG_KILL;
  (dockerProvider as { getEndpoint: GetEndpointFn }).getEndpoint = origDocker;
  (flyProvider as { getEndpoint: GetEndpointFn }).getEndpoint = origFly;
  _resetForTests();
  _resetImageReadyCache();
  _resetFlyState();
  if (process.env.AGENTA_TUNNEL_KEY_CLEANUP === '1') {
    try {
      rmSync(tunnelKeyPath, { force: true });
      rmSync(`${tunnelKeyPath}.pub`, { force: true });
    } catch {
      // best-effort
    }
    delete process.env.AGENTA_TUNNEL_KEY_CLEANUP;
  }
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.AGENTA_DATA_DIR;
});

// Build a spawn-impl stub that records each invocation and returns a
// monotonic synthetic pid. The pid is recorded as "alive" via livePids
// so the next ensureTunnel call's isAlive() check returns true.
function makeSpawnStub(): { calls: string[][]; spawned: number[]; impl: SpawnFn } {
  const calls: string[][] = [];
  const spawned: number[] = [];
  let nextPid = 90_000;
  const impl: SpawnFn = (args) => {
    calls.push(args);
    const pid = nextPid++;
    spawned.push(pid);
    livePids.add(pid);
    return pid;
  };
  return { calls, spawned, impl };
}

describe('ensureTunnel', () => {
  test('first call spawns autossh with the expected argv', async () => {
    const { calls, spawned, impl } = makeSpawnStub();
    _setSpawnImpl(impl);

    await ensureTunnel('tk1', 'fdaa::1');

    expect(calls.length).toBe(1);
    const args = calls[0] ?? [];
    expect(args).toContain('-M');
    expect(args).toContain('0');
    expect(args).toContain('-N');
    expect(args).toContain('-R');
    expect(args).toContain('0.0.0.0:2222:localhost:22');
    expect(args).toContain('-p');
    expect(args).toContain('2200');
    expect(args).toContain('-i');
    expect(args).toContain(tunnelKeyPath);
    expect(args).toContain('ExitOnForwardFailure=yes');
    expect(args).toContain('ServerAliveInterval=15');
    expect(args[args.length - 1]).toBe('root@fdaa::1');

    const handle = _getHandle('tk1');
    expect(handle?.pid).toBe(spawned[0]);
    expect(handle?.flyIp).toBe('fdaa::1');
  });

  test('second call with same args is a no-op', async () => {
    const { calls, impl } = makeSpawnStub();
    _setSpawnImpl(impl);

    await ensureTunnel('tk2', 'fdaa::2');
    await ensureTunnel('tk2', 'fdaa::2');

    expect(calls.length).toBe(1);
  });

  test('call with a different flyIp kills the old pid and spawns a new one', async () => {
    const { calls, spawned, impl } = makeSpawnStub();
    _setSpawnImpl(impl);

    await ensureTunnel('tk3', 'fdaa::3a');
    const firstPid = spawned[0] ?? -1;
    expect(livePids.has(firstPid)).toBe(true);

    await ensureTunnel('tk3', 'fdaa::3b');

    // Two spawns total.
    expect(calls.length).toBe(2);
    // The first pid was killed (livePids set is updated by the process.kill
    // stub on SIGTERM).
    expect(livePids.has(firstPid)).toBe(false);
    // The new handle points at the second pid.
    const handle = _getHandle('tk3');
    expect(handle?.pid).toBe(spawned[1]);
    expect(handle?.flyIp).toBe('fdaa::3b');
  });

  test('stopTunnel kills the tracked pid and drops the handle', async () => {
    const { spawned, impl } = makeSpawnStub();
    _setSpawnImpl(impl);

    await ensureTunnel('tk4', 'fdaa::4');
    const pid = spawned[0] ?? -1;
    expect(livePids.has(pid)).toBe(true);

    await stopTunnel('tk4');

    expect(_getHandle('tk4')).toBeUndefined();
    expect(livePids.has(pid)).toBe(false);
  });

  test('stopTunnel on an unknown threadKey is a no-op', async () => {
    await stopTunnel('never-existed');
    // no throw, no handle in the map — implicitly verified by reaching here
  });

  test('respawn after pid death', async () => {
    const { calls, spawned, impl } = makeSpawnStub();
    _setSpawnImpl(impl);

    await ensureTunnel('tk5', 'fdaa::5');
    const firstPid = spawned[0] ?? -1;
    // Simulate autossh dying out-of-band (e.g. WireGuard hiccup).
    livePids.delete(firstPid);

    await ensureTunnel('tk5', 'fdaa::5');

    // The stale handle was respawned even though flyIp matches.
    expect(calls.length).toBe(2);
    expect(_getHandle('tk5')?.pid).toBe(spawned[1]);
  });
});
