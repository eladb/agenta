import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _resetCacheForTests,
  loadHomesConfig,
  resolveHome,
  resolveModel,
  resolveTransport,
} from './home-config';

let tmp: string;
let configPath: string;
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

function writeConfig(value: unknown): void {
  writeFileSync(configPath, JSON.stringify(value));
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'agenta-homes-cfg-'));
  configPath = join(tmp, 'homes.json');
  snapEnv(
    'AGENT_HOMES_CONFIG',
    'AGENT_HOMES_ROOT',
    'GITHUB_TOKEN',
    'TEST_TOKEN_X',
    'TEST_MODEL_KEY',
    'TEST_MODEL_KEY_2',
  );
  process.env.AGENT_HOMES_CONFIG = configPath;
  delete process.env.AGENT_HOMES_ROOT;
  _resetCacheForTests();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  restoreEnv();
  _resetCacheForTests();
});

describe('loadHomesConfig', () => {
  test('reads a valid config with default file:// (no auth_env required)', () => {
    writeConfig({
      default: { remote: 'file:///some/path' },
      channels: {},
    });
    const f = loadHomesConfig();
    expect(f.default.remote).toBe('file:///some/path');
    expect(f.default.auth_env).toBeUndefined();
  });

  test('throws when the config file is missing', () => {
    process.env.AGENT_HOMES_CONFIG = join(tmp, 'does-not-exist.json');
    expect(() => loadHomesConfig()).toThrow(/homes config not found/);
  });

  test('throws on unparseable JSON', () => {
    writeFileSync(configPath, 'not json at all');
    expect(() => loadHomesConfig()).toThrow(/failed to parse/);
  });

  test('throws when "default" entry is missing', () => {
    writeConfig({ channels: {} });
    expect(() => loadHomesConfig()).toThrow(/missing required "default"/);
  });

  test('throws when https:// entry has no auth_env', () => {
    writeConfig({
      default: { remote: 'https://github.com/o/r' },
      channels: {},
    });
    expect(() => loadHomesConfig()).toThrow(/auth_env required for https/);
  });

  test('throws when https:// entry auth_env points at an unset env var', () => {
    delete process.env.TEST_TOKEN_X;
    writeConfig({
      default: { remote: 'https://github.com/o/r', auth_env: 'TEST_TOKEN_X' },
      channels: {},
    });
    expect(() => loadHomesConfig()).toThrow(/TEST_TOKEN_X is not set/);
  });

  test('accepts https:// entry when the referenced env var is set', () => {
    process.env.TEST_TOKEN_X = 'pat-value';
    writeConfig({
      default: { remote: 'https://github.com/o/r', auth_env: 'TEST_TOKEN_X' },
      channels: {},
    });
    const f = loadHomesConfig();
    expect(f.default.remote).toBe('https://github.com/o/r');
    expect(f.default.auth_env).toBe('TEST_TOKEN_X');
  });

  test('throws when file:// entry has auth_env set', () => {
    writeConfig({
      default: { remote: 'file:///x', auth_env: 'GITHUB_TOKEN' },
      channels: {},
    });
    expect(() => loadHomesConfig()).toThrow(/auth_env must be absent for file/);
  });

  test('accepts ssh-style remote when auth_env is set', () => {
    process.env.TEST_TOKEN_X = 'pem-bytes';
    writeConfig({
      default: { remote: 'git@github.com:owner/repo.git', auth_env: 'TEST_TOKEN_X' },
      channels: {},
    });
    const f = loadHomesConfig();
    expect(f.default.remote).toBe('git@github.com:owner/repo.git');
    expect(f.default.auth_env).toBe('TEST_TOKEN_X');
  });

  test('accepts ssh:// remote when auth_env is set', () => {
    process.env.TEST_TOKEN_X = 'pem-bytes';
    writeConfig({
      default: { remote: 'ssh://git@github.com/owner/repo', auth_env: 'TEST_TOKEN_X' },
      channels: {},
    });
    const f = loadHomesConfig();
    expect(f.default.remote).toBe('ssh://git@github.com/owner/repo');
  });

  test('rejects ssh-style remote when auth_env is missing', () => {
    writeConfig({
      default: { remote: 'git@github.com:owner/repo.git' },
      channels: {},
    });
    expect(() => loadHomesConfig()).toThrow(/auth_env required for ssh/);
  });

  test('rejects ssh-style remote when auth_env points at unset env var', () => {
    delete process.env.TEST_TOKEN_X;
    writeConfig({
      default: { remote: 'git@github.com:owner/repo.git', auth_env: 'TEST_TOKEN_X' },
      channels: {},
    });
    expect(() => loadHomesConfig()).toThrow(/TEST_TOKEN_X is not set/);
  });

  test('rejects unsupported URL scheme', () => {
    writeConfig({
      default: { remote: 'ftp://x.invalid/foo', auth_env: 'GITHUB_TOKEN' },
      channels: {},
    });
    expect(() => loadHomesConfig()).toThrow(/unsupported URL scheme/);
  });

  test('validates every channel entry, not just default', () => {
    process.env.TEST_TOKEN_X = 'present';
    writeConfig({
      default: { remote: 'https://github.com/o/r', auth_env: 'TEST_TOKEN_X' },
      channels: {
        C123: { remote: 'ftp://nope', auth_env: 'TEST_TOKEN_X' },
      },
    });
    expect(() => loadHomesConfig()).toThrow(/\[C123\].*unsupported URL scheme/);
  });
});

describe('resolveHome', () => {
  test('returns channel-specific entry when listed', () => {
    process.env.TEST_TOKEN_X = 'present';
    writeConfig({
      default: { remote: 'file:///default/path' },
      channels: {
        C123: { remote: 'https://github.com/x/y', auth_env: 'TEST_TOKEN_X' },
      },
    });
    const r = resolveHome('C123');
    expect(r.remote).toBe('https://github.com/x/y');
    expect(r.auth_env).toBe('TEST_TOKEN_X');
  });

  test('falls back to default for unmapped channels', () => {
    writeConfig({
      default: { remote: 'file:///default/path' },
      channels: {},
    });
    const r = resolveHome('CXYZ-unknown');
    expect(r.remote).toBe('file:///default/path');
    expect(r.auth_env).toBeUndefined();
  });

  test('returns a fresh snapshot (mutations do not leak back into config)', () => {
    writeConfig({
      default: { remote: 'file:///x' },
      channels: {},
    });
    const a = resolveHome('CA');
    (a as { remote: string }).remote = 'mutated';
    const b = resolveHome('CB');
    expect(b.remote).toBe('file:///x');
  });
});

describe('model block (#128)', () => {
  test('valid model block on default loads', () => {
    process.env.TEST_MODEL_KEY = 'sk-test';
    writeConfig({
      default: {
        remote: 'file:///x',
        model: {
          name: 'claude-opus-4-7',
          base_url: 'https://api.anthropic.com/v1',
          api_key_env: 'TEST_MODEL_KEY',
        },
      },
      channels: {},
    });
    const f = loadHomesConfig();
    expect(f.default.model?.name).toBe('claude-opus-4-7');
    expect(f.default.model?.api_key_env).toBe('TEST_MODEL_KEY');
  });

  test('partial model block throws at boot', () => {
    process.env.TEST_MODEL_KEY = 'sk-test';
    writeConfig({
      default: {
        remote: 'file:///x',
        model: {
          name: 'claude-opus-4-7',
          api_key_env: 'TEST_MODEL_KEY',
          // base_url missing
        },
      },
      channels: {},
    });
    expect(() => loadHomesConfig()).toThrow(/model\.base_url required/);
  });

  test('model.api_key_env pointing at unset env var throws at boot', () => {
    delete process.env.TEST_MODEL_KEY;
    writeConfig({
      default: {
        remote: 'file:///x',
        model: {
          name: 'm',
          base_url: 'https://example.invalid/v1',
          api_key_env: 'TEST_MODEL_KEY',
        },
      },
      channels: {},
    });
    expect(() => loadHomesConfig()).toThrow(/TEST_MODEL_KEY is not set/);
  });

  test('non-object model block throws at boot', () => {
    writeConfig({
      default: { remote: 'file:///x', model: 'not-an-object' },
      channels: {},
    });
    expect(() => loadHomesConfig()).toThrow(/"model" must be an object/);
  });

  test('channel-level model block is validated too', () => {
    process.env.TEST_MODEL_KEY = 'sk-test';
    delete process.env.TEST_MODEL_KEY_2;
    writeConfig({
      default: {
        remote: 'file:///x',
        model: {
          name: 'm',
          base_url: 'https://example.invalid/v1',
          api_key_env: 'TEST_MODEL_KEY',
        },
      },
      channels: {
        C123: {
          remote: 'file:///y',
          model: {
            name: 'm2',
            base_url: 'https://example.invalid/v2',
            api_key_env: 'TEST_MODEL_KEY_2',
          },
        },
      },
    });
    expect(() => loadHomesConfig()).toThrow(/\[C123\].*TEST_MODEL_KEY_2 is not set/);
  });
});

describe('resolveModel', () => {
  test('channel-specific model wins over default', () => {
    process.env.TEST_MODEL_KEY = 'sk-a';
    process.env.TEST_MODEL_KEY_2 = 'sk-b';
    writeConfig({
      default: {
        remote: 'file:///x',
        model: {
          name: 'default-model',
          base_url: 'https://example.invalid/default',
          api_key_env: 'TEST_MODEL_KEY',
        },
      },
      channels: {
        C123: {
          remote: 'file:///y',
          model: {
            name: 'channel-model',
            base_url: 'https://example.invalid/channel',
            api_key_env: 'TEST_MODEL_KEY_2',
          },
        },
      },
    });
    const m = resolveModel('C123', undefined);
    expect(m?.name).toBe('channel-model');
    expect(m?.api_key_env).toBe('TEST_MODEL_KEY_2');
  });

  test('channel without model falls back to default model', () => {
    process.env.TEST_MODEL_KEY = 'sk-a';
    writeConfig({
      default: {
        remote: 'file:///x',
        model: {
          name: 'default-model',
          base_url: 'https://example.invalid/default',
          api_key_env: 'TEST_MODEL_KEY',
        },
      },
      channels: {
        C123: { remote: 'file:///y' },
      },
    });
    const m = resolveModel('C123', undefined);
    expect(m?.name).toBe('default-model');
  });

  test('no model anywhere → env fallback wins (current behavior)', () => {
    writeConfig({
      default: { remote: 'file:///x' },
      channels: {},
    });
    const fallback = {
      name: 'env-model',
      base_url: 'https://env.invalid/v1',
      api_key_env: 'MODEL_API_KEY',
    };
    const m = resolveModel('C123', fallback);
    expect(m?.name).toBe('env-model');
    expect(m?.api_key_env).toBe('MODEL_API_KEY');
  });

  test('no model and no fallback → undefined (caller must surface)', () => {
    writeConfig({
      default: { remote: 'file:///x' },
      channels: {},
    });
    expect(resolveModel('C123', undefined)).toBeUndefined();
  });

  test('returns a fresh snapshot (mutations do not leak back)', () => {
    process.env.TEST_MODEL_KEY = 'sk-a';
    writeConfig({
      default: {
        remote: 'file:///x',
        model: {
          name: 'm',
          base_url: 'https://example.invalid/v1',
          api_key_env: 'TEST_MODEL_KEY',
        },
      },
      channels: {},
    });
    const a = resolveModel('CA', undefined);
    if (a) (a as { name: string }).name = 'mutated';
    const b = resolveModel('CB', undefined);
    expect(b?.name).toBe('m');
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
