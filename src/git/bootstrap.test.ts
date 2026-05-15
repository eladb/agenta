// Targeted bootstrap tests. The full clone-and-config path against a real
// sshd lives in `tests/e2e/git-botspace.test.ts`. Here we stub the sandbox
// HTTP layer + the host's `~/.ssh` interactions and assert:
//   - AGENTA_REPO_PATH unset -> throws clearly.
//   - Already-bootstrapped session (live session.git + matching
//     authorized_keys + a sandbox ~/.git) early-returns with a single probe.
//   - First-run path: generates a keypair, writes the authorized_keys line,
//     persists git fingerprint into session.json, drops {id_ed25519, .pub,
//     config, known_hosts} into the sandbox, and exec's the clone + branch
//     setup commands.
//   - Second-run path: idempotent — no new keypair, no extra authorized_keys
//     entries, the loop falls into the fast-path probe.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSession, writeSession } from '../runtime/session-store';
import { _resetImageReadyCache, dockerProvider } from '../sandbox/docker';
import { _resetFlyState, flyProvider } from '../sandbox/fly';
import { addEntry, listEntries, _resetForTests as resetAuthKeys } from './authorized-keys';
import { ensureRepoBootstrap } from './bootstrap';

const hasSshKeygen = Bun.which('ssh-keygen') !== null;

const ORIG_FETCH = globalThis.fetch;
const FAKE_BASE_URL = 'http://127.0.0.1:55555';
const FAKE_TOKEN = 'fake-bearer-token';

type GetEndpointFn = typeof dockerProvider.getEndpoint;
const origDocker: GetEndpointFn = dockerProvider.getEndpoint;
const origFly: GetEndpointFn = flyProvider.getEndpoint;

let dataDir: string;
let authKeysPath: string;
let repoPath: string;

// Pre-populate the known_hosts cache so the bootstrap doesn't try to
// `ssh-keyscan localhost` (which requires sshd reachability).
function seedKnownHostsCache(): void {
  const dir = join(dataDir, 'host-keys');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'known_hosts'), 'localhost ssh-ed25519 AAAAfakefakefake\n');
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'agenta-bootstrap-'));
  authKeysPath = join(dataDir, 'authorized_keys');
  repoPath = join(dataDir, 'fake-repo');
  mkdirSync(repoPath);
  process.env.AGENTA_DATA_DIR = dataDir;
  process.env.AGENTA_AUTHORIZED_KEYS_PATH = authKeysPath;
  _resetImageReadyCache();
  _resetFlyState();
  await resetAuthKeys();
  const fakeEndpoint = async (): Promise<{
    baseUrl: string;
    headers: Record<string, string>;
  }> => ({
    baseUrl: FAKE_BASE_URL,
    headers: { Authorization: `Bearer ${FAKE_TOKEN}` },
  });
  (dockerProvider as { getEndpoint: GetEndpointFn }).getEndpoint = fakeEndpoint;
  (flyProvider as { getEndpoint: GetEndpointFn }).getEndpoint = fakeEndpoint;
});

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
  delete process.env.AGENTA_DATA_DIR;
  delete process.env.AGENTA_AUTHORIZED_KEYS_PATH;
  delete process.env.AGENTA_REPO_PATH;
  rmSync(dataDir, { recursive: true, force: true });
  _resetImageReadyCache();
  _resetFlyState();
  (dockerProvider as { getEndpoint: GetEndpointFn }).getEndpoint = origDocker;
  (flyProvider as { getEndpoint: GetEndpointFn }).getEndpoint = origFly;
});

type RecordedCall = { url: string; method: string; body?: string };

// Build a fetch stub that records each call and replies based on the URL.
// `execReplies` is consumed in order for each /exec call; if it runs short
// we keep returning `{exitCode: 0}` (the bootstrap probes ~/.git on a
// fast-path; without this, idempotency tests fail).
function makeFetchStub(opts: {
  execReplies?: Array<{ exitCode: number; stdout?: string; stderr?: string }>;
  defaultExec?: { exitCode: number; stdout?: string; stderr?: string };
  calls: RecordedCall[];
}): typeof fetch {
  const execQueue = [...(opts.execReplies ?? [])];
  const defaultExec = opts.defaultExec ?? { exitCode: 0 };
  return (async (input: string, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    let body: string | undefined;
    if (init?.body && typeof init.body === 'string') body = init.body;
    opts.calls.push({ url, method, body });
    if (url.endsWith('/exec')) {
      const reply = execQueue.shift() ?? defaultExec;
      const frames: string[] = [];
      if (reply.stdout && reply.stdout.length > 0) {
        frames.push(`data: ${JSON.stringify({ kind: 'stdout', chunk: reply.stdout })}\n\n`);
      }
      if (reply.stderr && reply.stderr.length > 0) {
        frames.push(`data: ${JSON.stringify({ kind: 'stderr', chunk: reply.stderr })}\n\n`);
      }
      frames.push(`data: ${JSON.stringify({ kind: 'exit', exitCode: reply.exitCode })}\n\n`);
      return new Response(frames.join(''), {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    if (url.endsWith('/write')) {
      return new Response(JSON.stringify({ stdout: '', stderr: '', exitCode: 0 }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('unexpected', { status: 500 });
  }) as unknown as typeof fetch;
}

describe('ensureRepoBootstrap', () => {
  test('throws when AGENTA_REPO_PATH is unset', async () => {
    delete process.env.AGENTA_REPO_PATH;
    await expect(ensureRepoBootstrap('tk-x')).rejects.toThrow(/AGENTA_REPO_PATH/);
  });

  test('fast-path returns after a single ~/.git probe (no key gen, no clone)', async () => {
    process.env.AGENTA_REPO_PATH = repoPath;
    seedKnownHostsCache();
    const tk = 'tk-fastpath';
    await writeSession(tk, {
      status: 'idle',
      updated_at: new Date().toISOString(),
      git: { pubkey_fp: 'SHA256:dummy', ref: `refs/heads/agenta/sessions/${tk}` },
    });
    await addEntry({
      threadKey: tk,
      publicKey: 'ssh-ed25519 AAAAplaceholder',
      command: 'placeholder',
    });

    const calls: RecordedCall[] = [];
    globalThis.fetch = makeFetchStub({
      calls,
      execReplies: [{ exitCode: 0 }], // `test -d ~/.git`
    });

    await ensureRepoBootstrap(tk);
    // Only the single probe call.
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toContain('/exec');
    expect(calls[0]?.body ?? '').toContain('test -d ~/.git');
  });

  test.skipIf(!hasSshKeygen)(
    'first-run path: generates keypair, writes authorized_keys, persists git record, exec sequence',
    async () => {
      process.env.AGENTA_REPO_PATH = repoPath;
      seedKnownHostsCache();
      const tk = 'tk-firstrun';

      // First-run flow (no existing session.git, no authorized_keys entry).
      // `needsKey` short-circuits at !pubkeyFp so the test-f probe never
      // fires. /exec sequence in bootstrap.ts order:
      //   1. mkdir -p ~/.ssh && chmod 700  -> exit 0
      //   2. chmod 600 ~/.ssh/...           -> exit 0
      //   3. clone-dance                    -> exit 0
      //   4. config user.email              -> exit 0
      //   5. config user.name               -> exit 0
      //   6. symbolic-ref HEAD              -> stdout 'refs/heads/main' (mismatch)
      //   7. checkout -B agenta/sessions/.. -> exit 0
      const execReplies = [
        { exitCode: 0 },
        { exitCode: 0 },
        { exitCode: 0 },
        { exitCode: 0 },
        { exitCode: 0 },
        { exitCode: 0, stdout: 'refs/heads/main' },
        { exitCode: 0 },
      ];

      const calls: RecordedCall[] = [];
      globalThis.fetch = makeFetchStub({ calls, execReplies });

      await ensureRepoBootstrap(tk);

      // session.json now carries a git record with a real fingerprint.
      const s = await readSession(tk);
      expect(s?.git?.pubkey_fp.startsWith('SHA256:')).toBe(true);
      expect(s?.git?.ref).toBe(`refs/heads/agenta/sessions/${tk}`);

      // authorized_keys has exactly one entry tagged for this thread.
      const entries = await listEntries();
      expect(entries).toEqual([tk]);

      // Sandbox writes: id_ed25519, id_ed25519.pub, config, known_hosts.
      const writePayloads = calls
        .filter((c) => c.url.endsWith('/write'))
        .map((c) => JSON.parse(c.body ?? '{}') as { path: string; content: string });
      const paths = writePayloads.map((w) => w.path);
      expect(paths).toContain('.ssh/id_ed25519');
      expect(paths).toContain('.ssh/id_ed25519.pub');
      expect(paths).toContain('.ssh/config');
      expect(paths).toContain('.ssh/known_hosts');
      // The private key write contains the OpenSSH PEM header.
      const priv = writePayloads.find((w) => w.path === '.ssh/id_ed25519');
      expect(priv?.content).toContain('BEGIN OPENSSH PRIVATE KEY');
      // The config write pins the agenta-repo alias.
      const cfg = writePayloads.find((w) => w.path === '.ssh/config');
      expect(cfg?.content).toContain('Host agenta-repo');
      expect(cfg?.content).toContain('IdentityFile ~/.ssh/id_ed25519');

      // Exec sequence in order: every bash command we expect to run.
      const execBodies = calls
        .filter((c) => c.url.endsWith('/exec'))
        .map((c) => JSON.parse(c.body ?? '{}') as { command: string });
      const cmds = execBodies.map((b) => b.command);
      // First-run: no test-f probe; .ssh setup comes first.
      expect(cmds[0]).toContain('mkdir -p ~/.ssh');
      // Then the rest of the .ssh setup + identity + checkout.
      expect(cmds.some((c) => c.includes('mkdir -p ~/.ssh'))).toBe(true);
      expect(cmds.some((c) => c.includes('chmod 600 ~/.ssh/id_ed25519'))).toBe(true);
      expect(cmds.some((c) => c.includes('git clone --depth 1 ssh://agenta-repo'))).toBe(true);
      expect(cmds.some((c) => c.includes('config user.email'))).toBe(true);
      expect(cmds.some((c) => c.includes('config user.name'))).toBe(true);
      expect(cmds.some((c) => c.includes('symbolic-ref'))).toBe(true);
      expect(cmds.some((c) => c.includes(`checkout -B agenta/sessions/${tk}`))).toBe(true);
    },
  );

  test.skipIf(!hasSshKeygen)(
    'idempotent: a second ensureRepoBootstrap call does not re-issue a keypair',
    async () => {
      process.env.AGENTA_REPO_PATH = repoPath;
      seedKnownHostsCache();
      const tk = 'tk-idem';

      // First call: same shape as the "first-run" test above. We don't
      // need to assert on each step here — the previous test covers that.
      const firstCalls: RecordedCall[] = [];
      globalThis.fetch = makeFetchStub({
        calls: firstCalls,
        execReplies: [
          { exitCode: 0 }, // mkdir
          { exitCode: 0 }, // chmod
          { exitCode: 0 }, // clone
          { exitCode: 0 }, // user.email
          { exitCode: 0 }, // user.name
          { exitCode: 0, stdout: `refs/heads/agenta/sessions/${tk}` }, // already on the ref
        ],
      });
      await ensureRepoBootstrap(tk);
      const fpBefore = (await readSession(tk))?.git?.pubkey_fp;
      expect(fpBefore?.startsWith('SHA256:')).toBe(true);

      // Second call: the fast-path probe should fire (~/.git exists in the
      // sandbox), and that's the ONLY HTTP call we expect.
      const secondCalls: RecordedCall[] = [];
      globalThis.fetch = makeFetchStub({
        calls: secondCalls,
        execReplies: [{ exitCode: 0 }], // test -d ~/.git
      });
      await ensureRepoBootstrap(tk);

      // Session fingerprint unchanged.
      const fpAfter = (await readSession(tk))?.git?.pubkey_fp;
      expect(fpAfter).toBe(fpBefore);

      // authorized_keys has exactly one entry — addEntry was not called
      // again (or if it was, it was a no-op replacement; either way the
      // count of agenta-<tk> lines must be 1).
      const entries = await listEntries();
      expect(entries.filter((e) => e === tk).length).toBe(1);

      // Only the single fast-path probe call hit the sandbox the second
      // time. Critically: no /write calls (no key bytes re-uploaded).
      expect(secondCalls.length).toBe(1);
      expect(secondCalls[0]?.url).toContain('/exec');
      const body = JSON.parse(secondCalls[0]?.body ?? '{}') as { command: string };
      expect(body.command).toContain('test -d ~/.git');
    },
  );
});
