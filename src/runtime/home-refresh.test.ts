import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refreshHomeMirror, type RunResult, type Runner } from './home-refresh';

// Each test stubs the runner so no real git invocations happen. We just
// assert the commands + env the helper would run per transport.

type Call = { cmd: string[]; env?: Record<string, string> };

function makeRunner(result: RunResult = { code: 0, stdout: '', stderr: '' }): {
  runner: Runner;
  calls: Call[];
} {
  const calls: Call[] = [];
  const runner: Runner = async (cmd, env) => {
    calls.push({ cmd, env });
    return result;
  };
  return { runner, calls };
}

let tmpRoot: string;
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agenta-home-refresh-test-'));
  process.env.AGENT_HOMES_ROOT = tmpRoot;
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  // Restore env exactly — tests may have set/unset auth_env vars.
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIGINAL_ENV)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    process.env[k] = v;
  }
});

describe('refreshHomeMirror', () => {
  test('file:// is a no-op (no commands run)', async () => {
    const fileDir = mkdtempSync(join(tmpdir(), 'agenta-home-file-'));
    try {
      const { runner, calls } = makeRunner();
      await refreshHomeMirror({ remote: `file://${fileDir}` }, runner);
      expect(calls.length).toBe(0);
    } finally {
      rmSync(fileDir, { recursive: true, force: true });
    }
  });

  test('https:// runs fetch + reset --hard FETCH_HEAD with token-spliced URL', async () => {
    // Slug for https://github.com/owner/repo → github.com-owner-repo.
    const mirror = join(tmpRoot, 'github.com-owner-repo');
    mkdirSync(join(mirror, '.git'), { recursive: true });

    process.env.HOME_REFRESH_TEST_PAT = 'tok-abc';
    const { runner, calls } = makeRunner();
    await refreshHomeMirror(
      { remote: 'https://github.com/owner/repo', auth_env: 'HOME_REFRESH_TEST_PAT' },
      runner,
    );

    expect(calls.length).toBe(2);
    expect(calls[0]?.cmd).toEqual([
      'git',
      '-C',
      mirror,
      'fetch',
      'https://x-access-token:tok-abc@github.com/owner/repo',
      'main',
      '--quiet',
    ]);
    expect(calls[1]?.cmd).toEqual([
      'git',
      '-C',
      mirror,
      'reset',
      '--hard',
      'FETCH_HEAD',
      '--quiet',
    ]);
  });

  test('https:// skips with a warning when the mirror has no .git', async () => {
    process.env.HOME_REFRESH_TEST_PAT = 'tok-abc';
    const { runner, calls } = makeRunner();
    await refreshHomeMirror(
      { remote: 'https://github.com/owner/missing', auth_env: 'HOME_REFRESH_TEST_PAT' },
      runner,
    );
    expect(calls.length).toBe(0);
  });

  test('ssh:// runs fetch + reset --hard origin/HEAD with GIT_SSH_COMMAND', async () => {
    const remote = 'git@github.com:owner/repo.git';
    const mirror = join(tmpRoot, 'github.com-owner-repo-git');
    mkdirSync(join(mirror, '.git'), { recursive: true });

    process.env.HOME_REFRESH_TEST_PEM = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----';
    const { runner, calls } = makeRunner();
    await refreshHomeMirror(
      { remote, auth_env: 'HOME_REFRESH_TEST_PEM' },
      runner,
    );

    expect(calls.length).toBe(2);
    expect(calls[0]?.cmd).toEqual(['git', '-C', mirror, 'fetch', '--quiet']);
    expect(calls[0]?.env?.GIT_SSH_COMMAND).toBeTruthy();
    expect(calls[0]?.env?.GIT_SSH_COMMAND).toContain('-o IdentitiesOnly=yes');
    expect(calls[0]?.env?.GIT_SSH_COMMAND).toContain('-o StrictHostKeyChecking=yes');
    expect(calls[0]?.env?.GIT_SSH_COMMAND).toContain('UserKnownHostsFile=');
    expect(calls[1]?.cmd).toEqual([
      'git',
      '-C',
      mirror,
      'reset',
      '--hard',
      'origin/HEAD',
      '--quiet',
    ]);
  });

  test('failed fetch is non-fatal and skips reset', async () => {
    const mirror = join(tmpRoot, 'github.com-owner-repo');
    mkdirSync(join(mirror, '.git'), { recursive: true });
    process.env.HOME_REFRESH_TEST_PAT = 'tok-abc';
    const { runner, calls } = makeRunner({ code: 1, stdout: '', stderr: 'boom' });
    await refreshHomeMirror(
      { remote: 'https://github.com/owner/repo', auth_env: 'HOME_REFRESH_TEST_PAT' },
      runner,
    );
    // Only the fetch attempt — reset shouldn't run.
    expect(calls.length).toBe(1);
    expect(calls[0]?.cmd[3]).toBe('fetch');
  });

  test('https:// with missing auth_env env var skips without throwing', async () => {
    const mirror = join(tmpRoot, 'github.com-owner-repo');
    mkdirSync(join(mirror, '.git'), { recursive: true });
    delete process.env.HOME_REFRESH_TEST_PAT;
    const { runner, calls } = makeRunner();
    await refreshHomeMirror(
      { remote: 'https://github.com/owner/repo', auth_env: 'HOME_REFRESH_TEST_PAT' },
      runner,
    );
    expect(calls.length).toBe(0);
  });
});
