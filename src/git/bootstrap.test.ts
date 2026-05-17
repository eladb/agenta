// Targeted bootstrap tests for the WS-tunnel transport (phase 24). We stub
// the sandbox HTTP layer (every /exec etc. call) and substitute the
// provider's `getEndpoint` so no real container or Fly machine is required.
// `startGitServer` and `startTunnel` are not mocked at module-link time
// (they're imported as concrete functions); instead we exercise the
// bootstrap end-to-end against a real loopback Bun.serve + a fake sandbox
// WS server. The tests assert:
//   - AGENT_HOME unset -> throws clearly.
//   - First-run path: starts a git server + a tunnel, probes the in-
//     sandbox port, persists `session.git.ref`, and exec's the clone +
//     branch setup commands.
//   - Second-run path: when ~/.git already exists in the sandbox, the
//     bootstrap short-circuits to the probe alone (no second clone).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSession } from '../runtime/session-store';
import { _resetImageReadyCache, dockerProvider } from '../sandbox/docker';
import { _resetFlyState, flyProvider } from '../sandbox/fly';
import { _resetForTests, ensureRepoBootstrap, teardownAllSessions } from './bootstrap';
import { stopAllTunnels } from './ws-tunnel';

const hasGit = Bun.which('git') !== null;

const ORIG_FETCH = globalThis.fetch;
type GetEndpointFn = typeof dockerProvider.getEndpoint;
const origDocker: GetEndpointFn = dockerProvider.getEndpoint;
const origFly: GetEndpointFn = flyProvider.getEndpoint;

let dataDir: string;
let repoPath: string;
// The "sandbox" — a fake Bun.serve standing in for the in-container HTTP
// server. We only need /tunnel (WS upgrade) and /exec (SSE) to exercise
// the bootstrap.
type SandboxFake = {
  port: number;
  // Queue of /exec replies in order.
  execQueue: Array<{ exitCode: number; stdout?: string; stderr?: string }>;
  execBodies: string[];
  // Tracks whether a WS upgrade succeeded.
  upgraded: boolean;
  ws?: import('bun').ServerWebSocket<unknown>;
  // The TCP listener we'd normally bind on 6000 inside the container —
  // here we just record that bootstrap probed for it via /exec. To make
  // the "probe" succeed we let the test inject exit 0 in the queue.
  stop: () => Promise<void>;
};
let sandbox: SandboxFake;

const FAKE_TOKEN = 'fake-sandbox-token';

async function startSandboxFake(): Promise<SandboxFake> {
  const execQueue: Array<{ exitCode: number; stdout?: string; stderr?: string }> = [];
  const execBodies: string[] = [];
  const state = {
    port: 0,
    execQueue,
    execBodies,
    upgraded: false,
    ws: undefined as import('bun').ServerWebSocket<unknown> | undefined,
    stop: async () => {},
  };
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req, srv): Promise<Response | undefined> {
      const url = new URL(req.url);
      if (url.pathname === '/tunnel') {
        if (srv.upgrade(req)) {
          state.upgraded = true;
          return undefined;
        }
        return new Response('upgrade-failed', { status: 400 });
      }
      if (url.pathname === '/exec') {
        const body = (await req.json()) as { command?: string };
        execBodies.push(body.command ?? '');
        const reply = execQueue.shift() ?? { exitCode: 0 };
        const frames: string[] = [];
        if (reply.stdout)
          frames.push(`data: ${JSON.stringify({ kind: 'stdout', chunk: reply.stdout })}\n\n`);
        if (reply.stderr)
          frames.push(`data: ${JSON.stringify({ kind: 'stderr', chunk: reply.stderr })}\n\n`);
        frames.push(`data: ${JSON.stringify({ kind: 'exit', exitCode: reply.exitCode })}\n\n`);
        return new Response(frames.join(''), {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }
      return new Response('unexpected', { status: 500 });
    },
    websocket: {
      open(ws) {
        state.ws = ws;
      },
      message() {
        // Ignore in this stub — bootstrap.cloneAndCheckout doesn't actually
        // trigger a real git clone (the /exec for the clone returns exit 0
        // before any TCP traffic flows through the tunnel).
      },
      close() {
        state.ws = undefined;
      },
    },
  });
  state.port = server.port;
  state.stop = async () => {
    await server.stop(true);
  };
  return state;
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'agenta-bootstrap-'));
  repoPath = join(dataDir, 'fake-repo');
  mkdirSync(repoPath);
  if (hasGit) {
    spawnSync('git', ['init', '--initial-branch=main', repoPath], { stdio: 'ignore' });
    spawnSync('git', ['-C', repoPath, 'config', 'user.email', 'b@agenta.test']);
    spawnSync('git', ['-C', repoPath, 'config', 'user.name', 'agenta-bs']);
    writeFileSync(join(repoPath, 'README.md'), 'hello\n');
    spawnSync('git', ['-C', repoPath, 'add', 'README.md'], { stdio: 'ignore' });
    spawnSync('git', ['-C', repoPath, 'commit', '-m', 'i'], { stdio: 'ignore' });
  }
  process.env.AGENTA_DATA_DIR = dataDir;
  _resetImageReadyCache();
  _resetFlyState();
  _resetForTests();
  sandbox = await startSandboxFake();

  const fakeEndpoint = async (): Promise<{
    baseUrl: string;
    headers: Record<string, string>;
  }> => ({
    baseUrl: `http://127.0.0.1:${sandbox.port}`,
    headers: { Authorization: `Bearer ${FAKE_TOKEN}` },
  });
  (dockerProvider as { getEndpoint: GetEndpointFn }).getEndpoint = fakeEndpoint;
  (flyProvider as { getEndpoint: GetEndpointFn }).getEndpoint = fakeEndpoint;
});

afterEach(async () => {
  await teardownAllSessions();
  await stopAllTunnels();
  globalThis.fetch = ORIG_FETCH;
  delete process.env.AGENTA_DATA_DIR;
  delete process.env.AGENT_HOME;
  delete process.env.SANDBOX_PROVIDER;
  await sandbox.stop();
  rmSync(dataDir, { recursive: true, force: true });
  _resetImageReadyCache();
  _resetFlyState();
  _resetForTests();
  (dockerProvider as { getEndpoint: GetEndpointFn }).getEndpoint = origDocker;
  (flyProvider as { getEndpoint: GetEndpointFn }).getEndpoint = origFly;
});

describe('ensureRepoBootstrap', () => {
  test('throws when AGENT_HOME is unset', async () => {
    delete process.env.AGENT_HOME;
    await expect(ensureRepoBootstrap('tk-x')).rejects.toThrow(/AGENT_HOME/);
  });

  test.skipIf(!hasGit)(
    'first-run path: starts tunnel, probes loopback:6000, exec sequence for clone + checkout',
    async () => {
      process.env.AGENT_HOME = repoPath;
      const tk = 'tk-first';

      // /exec sequence inside bootstrap (no pre-existing handle, no fast-path):
      //   1. waitForSandboxPort probe (`/dev/tcp/localhost/6000`) → exit 0
      //   2. clone-dance bash → exit 0
      //   3. `git -C ~ remote set-url origin …` → exit 0
      //   4. `git -C ~ config user.email …` → exit 0
      //   5. `git -C ~ config user.name …` → exit 0
      //   6. `git -C ~ symbolic-ref --quiet HEAD` → stdout: refs/heads/main (mismatch)
      //   7. `git -C ~ checkout -B agenta/sessions/<tk>` → exit 0
      sandbox.execQueue.push(
        { exitCode: 0 }, // probe
        { exitCode: 0 }, // clone
        { exitCode: 0 }, // remote set-url
        { exitCode: 0 }, // email
        { exitCode: 0 }, // name
        { exitCode: 0, stdout: 'refs/heads/main' }, // symbolic-ref
        { exitCode: 0 }, // checkout
      );

      await ensureRepoBootstrap(tk);

      const s = await readSession(tk);
      expect(s?.git?.ref).toBe(`refs/heads/agenta/sessions/${tk}`);
      // We don't write pubkey_fp any more.
      expect(s?.git?.pubkey_fp).toBeUndefined();
      // The sandbox saw the WS upgrade.
      expect(sandbox.upgraded).toBe(true);

      // Sandbox bash commands in order.
      const cmds = sandbox.execBodies;
      expect(cmds[0]).toMatch(/exec 3<>\/dev\/tcp\/localhost\/6000/);
      expect(cmds.some((c) => c.includes('git clone --depth 1'))).toBe(true);
      expect(cmds.some((c) => c.includes('http://localhost:6000/fake-repo.git'))).toBe(true);
      expect(cmds.some((c) => c.includes('remote set-url origin'))).toBe(true);
      expect(cmds.some((c) => c.includes('config user.email'))).toBe(true);
      expect(cmds.some((c) => c.includes('config user.name'))).toBe(true);
      expect(cmds.some((c) => c.includes('symbolic-ref'))).toBe(true);
      expect(cmds.some((c) => c.includes(`checkout -B 'agenta/sessions/${tk}'`))).toBe(true);
    },
  );

  test.skipIf(!hasGit)(
    'second call short-circuits to a single `~/.git` probe when handle + ref match',
    async () => {
      process.env.AGENT_HOME = repoPath;
      const tk = 'tk-second';

      // First call: same shape as the first-run test.
      sandbox.execQueue.push(
        { exitCode: 0 }, // probe localhost:6000
        { exitCode: 0 }, // clone
        { exitCode: 0 }, // remote set-url
        { exitCode: 0 }, // email
        { exitCode: 0 }, // name
        { exitCode: 0, stdout: `refs/heads/agenta/sessions/${tk}` }, // symbolic-ref already on
      );
      await ensureRepoBootstrap(tk);
      const firstCallCount = sandbox.execBodies.length;
      expect(firstCallCount).toBeGreaterThan(3);

      // Second call: fast-path. Only ~/.git probe should run.
      sandbox.execQueue.push({ exitCode: 0 }); // test -d ~/.git
      await ensureRepoBootstrap(tk);
      const secondCallCount = sandbox.execBodies.length - firstCallCount;
      expect(secondCallCount).toBe(1);
      expect(sandbox.execBodies[sandbox.execBodies.length - 1]).toMatch(/test -d ~\/\.git/);
    },
  );
});
