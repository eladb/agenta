import { describe, expect, test } from 'bun:test';
import { parseTenantsConfig, resolveRoute } from './routes';
import type { TenantsConfig } from './types';

// A minimal but valid base config to clone in resolver tests so each test
// only spells out the routes it exercises.
const TENANTS = {
  agentalabs: { url: 'https://tenant-a.internal/', auth_env: 'TENANT_A_SECRET' },
  acme: { url: 'https://tenant-b.internal/', auth_env: 'TENANT_B_SECRET' },
};

const HOME_DEFAULT = {
  remote: 'https://github.com/eladb/agenta-test-home',
  auth_env: 'GITHUB_TOKEN',
};
const HOME_ALT = {
  remote: 'git@github.com:eladb/agenta-test-home-alone.git',
  auth_env: 'AGENTA_TEST_HOME_ALONE_DEPLOY_KEY',
};

describe('parseTenantsConfig', () => {
  test('accepts a workspace-default route', () => {
    const cfg = parseTenantsConfig({
      tenants: TENANTS,
      routes: {
        T0B304AJPUZ: {
          default: { tenant: 'agentalabs', home: HOME_DEFAULT },
        },
      },
    });
    expect(cfg.tenants.agentalabs?.url).toBe('https://tenant-a.internal/');
    expect(cfg.routes.T0B304AJPUZ?.default?.tenant).toBe('agentalabs');
    expect(cfg.routes.T0B304AJPUZ?.default?.home.remote).toBe(HOME_DEFAULT.remote);
  });

  test('accepts a default + per-channel override', () => {
    const cfg = parseTenantsConfig({
      tenants: TENANTS,
      routes: {
        T0B304AJPUZ: {
          default: { tenant: 'agentalabs', home: HOME_DEFAULT },
          channels: {
            C0B4MU6GCFQ: { tenant: 'agentalabs', home: HOME_ALT },
          },
        },
      },
    });
    expect(cfg.routes.T0B304AJPUZ?.channels?.C0B4MU6GCFQ?.home.remote).toBe(HOME_ALT.remote);
  });

  test('accepts channels-only (no default) workspace entry', () => {
    const cfg = parseTenantsConfig({
      tenants: TENANTS,
      routes: {
        T_ONLY_CHAN: {
          channels: {
            C1: { tenant: 'acme', home: HOME_DEFAULT },
          },
        },
      },
    });
    expect(cfg.routes.T_ONLY_CHAN?.default).toBeUndefined();
    expect(cfg.routes.T_ONLY_CHAN?.channels?.C1?.tenant).toBe('acme');
  });

  test('home.auth_env is optional', () => {
    const cfg = parseTenantsConfig({
      tenants: TENANTS,
      routes: {
        T: {
          default: { tenant: 'agentalabs', home: { remote: 'file:///some/path' } },
        },
      },
    });
    expect(cfg.routes.T?.default?.home.auth_env).toBeUndefined();
  });

  test('rejects non-object top-level', () => {
    expect(() => parseTenantsConfig([])).toThrow(/must be a JSON object/);
    expect(() => parseTenantsConfig('hi')).toThrow(/must be a JSON object/);
  });

  test('rejects missing "tenants" block', () => {
    expect(() => parseTenantsConfig({ routes: {} })).toThrow(/"tenants"/);
  });

  test('rejects empty "tenants" block', () => {
    expect(() => parseTenantsConfig({ tenants: {}, routes: {} })).toThrow(/at least one tenant/);
  });

  test('rejects tenant entry missing url', () => {
    expect(() =>
      parseTenantsConfig({
        tenants: { x: { auth_env: 'X_SECRET' } },
        routes: {},
      }),
    ).toThrow(/tenants\.x.*url/);
  });

  test('rejects tenant entry missing auth_env', () => {
    expect(() =>
      parseTenantsConfig({
        tenants: { x: { url: 'https://x/' } },
        routes: {},
      }),
    ).toThrow(/tenants\.x.*auth_env/);
  });

  test('rejects missing "routes" block', () => {
    expect(() => parseTenantsConfig({ tenants: TENANTS })).toThrow(/"routes"/);
  });

  test('rejects workspace entry with neither default nor channels', () => {
    expect(() =>
      parseTenantsConfig({
        tenants: TENANTS,
        routes: { T: {} },
      }),
    ).toThrow(/must declare "default" or at least one channel/);
  });

  test('rejects route target naming an undeclared tenant', () => {
    expect(() =>
      parseTenantsConfig({
        tenants: TENANTS,
        routes: {
          T: { default: { tenant: 'ghost', home: HOME_DEFAULT } },
        },
      }),
    ).toThrow(/not declared in "tenants"/);
  });

  test('rejects route target missing home', () => {
    expect(() =>
      parseTenantsConfig({
        tenants: TENANTS,
        routes: {
          T: { default: { tenant: 'agentalabs' } },
        },
      }),
    ).toThrow(/home/);
  });

  test('rejects route target with empty home.remote', () => {
    expect(() =>
      parseTenantsConfig({
        tenants: TENANTS,
        routes: {
          T: { default: { tenant: 'agentalabs', home: { remote: '' } } },
        },
      }),
    ).toThrow(/home\.remote/);
  });
});

function makeConfig(routes: TenantsConfig['routes']): TenantsConfig {
  return { tenants: TENANTS, routes };
}

describe('resolveRoute', () => {
  test('channel match beats workspace default', () => {
    const cfg = makeConfig({
      T: {
        default: { tenant: 'agentalabs', home: HOME_DEFAULT },
        channels: {
          C_SPECIAL: { tenant: 'acme', home: HOME_ALT },
        },
      },
    });
    const r = resolveRoute(cfg, 'T', 'C_SPECIAL');
    expect(r?.tenant).toBe('acme');
    expect(r?.home.remote).toBe(HOME_ALT.remote);
  });

  test('workspace default applies when channel id is unknown', () => {
    const cfg = makeConfig({
      T: {
        default: { tenant: 'agentalabs', home: HOME_DEFAULT },
        channels: {
          C_SPECIAL: { tenant: 'acme', home: HOME_ALT },
        },
      },
    });
    const r = resolveRoute(cfg, 'T', 'C_OTHER');
    expect(r?.tenant).toBe('agentalabs');
    expect(r?.home.remote).toBe(HOME_DEFAULT.remote);
  });

  test('workspace default applies when channelId is omitted', () => {
    const cfg = makeConfig({
      T: { default: { tenant: 'agentalabs', home: HOME_DEFAULT } },
    });
    expect(resolveRoute(cfg, 'T')?.tenant).toBe('agentalabs');
  });

  test('default-only entry returns default for any channel', () => {
    const cfg = makeConfig({
      T: { default: { tenant: 'agentalabs', home: HOME_DEFAULT } },
    });
    expect(resolveRoute(cfg, 'T', 'C_ANYTHING')?.tenant).toBe('agentalabs');
  });

  test('channels-only entry returns null when no channel matches', () => {
    const cfg = makeConfig({
      T: {
        channels: {
          C1: { tenant: 'acme', home: HOME_DEFAULT },
        },
      },
    });
    expect(resolveRoute(cfg, 'T', 'C_MISS')).toBeNull();
    expect(resolveRoute(cfg, 'T')).toBeNull();
  });

  test('channels-only entry returns the channel hit', () => {
    const cfg = makeConfig({
      T: {
        channels: {
          C1: { tenant: 'acme', home: HOME_ALT },
        },
      },
    });
    const r = resolveRoute(cfg, 'T', 'C1');
    expect(r?.tenant).toBe('acme');
    expect(r?.home.remote).toBe(HOME_ALT.remote);
  });

  test('unrouted workspace returns null', () => {
    const cfg = makeConfig({
      T_KNOWN: { default: { tenant: 'agentalabs', home: HOME_DEFAULT } },
    });
    expect(resolveRoute(cfg, 'T_UNKNOWN', 'C1')).toBeNull();
    expect(resolveRoute(cfg, 'T_UNKNOWN')).toBeNull();
  });
});
