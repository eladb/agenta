import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { parseDisplayStyleEnv, resolveHomeFromEnvelope, resolveTransport } from './home-config';

// Under #253 the home spec arrives in each `/events` envelope and is
// validated by `resolveHomeFromEnvelope` against the tenant's process
// env. These tests pin that contract plus the unchanged transport
// derivation.

const PRIOR_ENV: Record<string, string | undefined> = {};

function snapEnv(...names: string[]): void {
  for (const n of names) PRIOR_ENV[n] = process.env[n];
}

function restoreEnv(): void {
  for (const [n, v] of Object.entries(PRIOR_ENV)) {
    if (v === undefined) delete process.env[n];
    else process.env[n] = v;
  }
  for (const k of Object.keys(PRIOR_ENV)) delete PRIOR_ENV[k];
}

beforeEach(() => {
  snapEnv('AGENT_HOMES_ROOT', 'GITHUB_TOKEN', 'TEST_TOKEN_X');
  delete process.env.AGENT_HOMES_ROOT;
});

afterEach(() => {
  restoreEnv();
});

describe('resolveHomeFromEnvelope', () => {
  test('file:// without auth_env is accepted', () => {
    const r = resolveHomeFromEnvelope({ remote: 'file:///some/path' }, {});
    expect(r.remote).toBe('file:///some/path');
    expect(r.auth_env).toBeUndefined();
  });

  test('file:// with auth_env is rejected', () => {
    expect(() =>
      resolveHomeFromEnvelope(
        { remote: 'file:///x', auth_env: 'GITHUB_TOKEN' },
        { GITHUB_TOKEN: 'present' },
      ),
    ).toThrow(/auth_env must be absent for file/);
  });

  test('https:// requires auth_env', () => {
    expect(() => resolveHomeFromEnvelope({ remote: 'https://github.com/o/r' }, {})).toThrow(
      /auth_env required for https/,
    );
  });

  test('https:// auth_env pointing at an unset env var throws', () => {
    expect(() =>
      resolveHomeFromEnvelope({ remote: 'https://github.com/o/r', auth_env: 'TEST_TOKEN_X' }, {}),
    ).toThrow(/TEST_TOKEN_X is not set/);
  });

  test('https:// auth_env pointing at an empty env var throws', () => {
    expect(() =>
      resolveHomeFromEnvelope(
        { remote: 'https://github.com/o/r', auth_env: 'TEST_TOKEN_X' },
        { TEST_TOKEN_X: '' },
      ),
    ).toThrow(/TEST_TOKEN_X is not set/);
  });

  test('https:// auth_env resolves when env is set', () => {
    const r = resolveHomeFromEnvelope(
      { remote: 'https://github.com/o/r', auth_env: 'TEST_TOKEN_X' },
      { TEST_TOKEN_X: 'pat-value' },
    );
    expect(r.remote).toBe('https://github.com/o/r');
    expect(r.auth_env).toBe('TEST_TOKEN_X');
  });

  test('git@ scp-form requires auth_env', () => {
    expect(() => resolveHomeFromEnvelope({ remote: 'git@github.com:owner/repo.git' }, {})).toThrow(
      /auth_env required for ssh/,
    );
  });

  test('git@ scp-form auth_env pointing at unset env var throws', () => {
    expect(() =>
      resolveHomeFromEnvelope(
        { remote: 'git@github.com:owner/repo.git', auth_env: 'TEST_TOKEN_X' },
        {},
      ),
    ).toThrow(/TEST_TOKEN_X is not set/);
  });

  test('git@ scp-form resolves when env is set', () => {
    const r = resolveHomeFromEnvelope(
      { remote: 'git@github.com:owner/repo.git', auth_env: 'TEST_TOKEN_X' },
      { TEST_TOKEN_X: 'pem-bytes' },
    );
    expect(r.remote).toBe('git@github.com:owner/repo.git');
    expect(r.auth_env).toBe('TEST_TOKEN_X');
  });

  test('ssh:// resolves when env is set', () => {
    const r = resolveHomeFromEnvelope(
      { remote: 'ssh://git@github.com/owner/repo', auth_env: 'TEST_TOKEN_X' },
      { TEST_TOKEN_X: 'pem-bytes' },
    );
    expect(r.remote).toBe('ssh://git@github.com/owner/repo');
  });

  test('unsupported URL scheme throws', () => {
    expect(() =>
      resolveHomeFromEnvelope(
        { remote: 'ftp://x.invalid/foo', auth_env: 'TEST_TOKEN_X' },
        { TEST_TOKEN_X: 'present' },
      ),
    ).toThrow(/unsupported URL scheme/);
  });

  test('missing or empty remote throws', () => {
    expect(() => resolveHomeFromEnvelope({ remote: '' }, {})).toThrow(/remote required/);
  });

  test('returned snapshot is independent of the input', () => {
    const input = { remote: 'https://github.com/o/r', auth_env: 'TEST_TOKEN_X' };
    const out = resolveHomeFromEnvelope(input, { TEST_TOKEN_X: 'v' });
    (input as { remote: string }).remote = 'mutated';
    expect(out.remote).toBe('https://github.com/o/r');
  });
});

describe('resolveTransport', () => {
  test('file:// → tunneled-file, local + mirror paths are the pathname', () => {
    const r = resolveTransport({ remote: 'file:///Users/elad/home' });
    expect(r.transport).toBe('tunneled-file');
    expect(r.localPath).toBe('/Users/elad/home');
    expect(r.mirrorPath).toBe('/Users/elad/home');
    expect(r.slug).toBe('users-elad-home');
  });

  test('https:// → tunneled-mirror, slug includes host, mirror dir under AGENT_HOMES_ROOT', () => {
    process.env.AGENT_HOMES_ROOT = '/data/homes';
    const r = resolveTransport({
      remote: 'https://github.com/eladb/agenta-test-home',
      auth_env: 'GITHUB_TOKEN',
    });
    expect(r.transport).toBe('tunneled-mirror');
    expect(r.slug).toBe('github.com-eladb-agenta-test-home');
    expect(r.mirrorPath).toBe('/data/homes/github.com-eladb-agenta-test-home');
    expect(r.localPath).toBe(r.mirrorPath);
  });

  test('slug derivation is stable and lowercased', () => {
    const r = resolveTransport({
      remote: 'https://GitHub.COM/EladB/Agenta-Test-Home',
      auth_env: 'GITHUB_TOKEN',
    });
    expect(r.slug).toBe('github.com-eladb-agenta-test-home');
  });

  test('git@ scp-form → direct transport, slug from host + path', () => {
    process.env.AGENT_HOMES_ROOT = '/data/homes';
    const r = resolveTransport({
      remote: 'git@github.com:owner/repo.git',
      auth_env: 'TEST_TOKEN_X',
    });
    expect(r.transport).toBe('direct');
    expect(r.slug).toBe('github.com-owner-repo-git');
    expect(r.mirrorPath).toBe('/data/homes/github.com-owner-repo-git');
    expect(r.localPath).toBe(r.mirrorPath);
  });

  test('ssh:// → direct transport, user info stripped from slug', () => {
    process.env.AGENT_HOMES_ROOT = '/data/homes';
    const r = resolveTransport({
      remote: 'ssh://git@github.com/owner/repo',
      auth_env: 'TEST_TOKEN_X',
    });
    expect(r.transport).toBe('direct');
    expect(r.slug).toBe('github.com-owner-repo');
  });

  test('unparseable remote URL throws with the offending value', () => {
    expect(() => resolveTransport({ remote: 'not even close' })).toThrow(/unparseable remote/);
  });
});

// Per-deploy default display style (#287). The helper is pure (takes the raw
// env value as an arg) so we test it without booting the server. Precedence
// over a per-thread command is enforced in handler.ts, not here — this only
// covers parse + validate.
describe('parseDisplayStyleEnv', () => {
  test('valid styles → { style }', () => {
    expect(parseDisplayStyleEnv('verbose')).toEqual({ style: 'verbose' });
    expect(parseDisplayStyleEnv('pretty')).toEqual({ style: 'pretty' });
    expect(parseDisplayStyleEnv('task_update')).toEqual({ style: 'task_update' });
  });

  test('surrounding whitespace is tolerated', () => {
    expect(parseDisplayStyleEnv('  task_update  ')).toEqual({ style: 'task_update' });
  });

  test('unset → undefined (preserves verbose default)', () => {
    expect(parseDisplayStyleEnv(undefined)).toBeUndefined();
  });

  test('empty / whitespace-only → undefined', () => {
    expect(parseDisplayStyleEnv('')).toBeUndefined();
    expect(parseDisplayStyleEnv('   ')).toBeUndefined();
  });

  test('invalid value → undefined, does not throw', () => {
    expect(() => parseDisplayStyleEnv('fancy')).not.toThrow();
    expect(parseDisplayStyleEnv('fancy')).toBeUndefined();
    // Case-sensitive: the union is lowercase.
    expect(parseDisplayStyleEnv('VERBOSE')).toBeUndefined();
  });
});
