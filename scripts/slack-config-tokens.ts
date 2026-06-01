// Shared Slack config-token management for the setup + update-manifest
// scripts. The tokens rotate every 12h; we cache the latest pair in
// .slack-apps.json next to the app-id cache so future invocations don't
// need env vars. Env vars still take precedence (one-time bootstrap when
// the cache is empty, or to override during testing).
//
// Public surface:
//   - loadCache / saveCache: read/write .slack-apps.json
//   - getConfigTokens(cache): resolve { access, refresh }; persists to
//     cache on first read from env so subsequent runs don't need env
//   - withTokenRefresh(cache, fn): runs `fn(access)` and auto-rotates +
//     retries once on token_expired / invalid_auth
//   - slackApi: small wrapper around Slack's HTTP API used by the above

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type AppCacheEntry = { app_id: string; install_url: string };

// Cache is a flat JSON object. Well-known top-level keys are listed here;
// in addition, any other string key maps to an AppCacheEntry — the
// setup-slack-apps.ts script keys each app it creates by name, so e.g.
// `agenta`, `agenta-dev`, etc. all live alongside `tester` here.
export type Cache = {
  agent?: AppCacheEntry;
  tester?: AppCacheEntry;
  config_access_token?: string;
  config_refresh_token?: string;
  [appName: string]: AppCacheEntry | string | undefined;
};

const ROOT = join(import.meta.dir, '..');
const CACHE_PATH = join(ROOT, '.slack-apps.json');

export function loadCache(): Cache {
  if (!existsSync(CACHE_PATH)) return {};
  return JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as Cache;
}

export function saveCache(c: Cache): void {
  writeFileSync(CACHE_PATH, `${JSON.stringify(c, null, 2)}\n`);
}

type SlackErr = { ok: false; error: string; errors?: unknown };

export async function slackApi<T>(
  method: string,
  token: string,
  params: Record<string, string> | object,
  encoding: 'form' | 'json' = 'form',
): Promise<T> {
  const init: RequestInit =
    encoding === 'form'
      ? {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams(params as Record<string, string>),
        }
      : {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify(params),
        };
  const res = await fetch(`https://slack.com/api/${method}`, init);
  const json = (await res.json()) as T | SlackErr;
  if (!(json as { ok?: boolean }).ok) {
    const err = json as SlackErr;
    throw new Error(`slack ${method} failed: ${err.error} ${JSON.stringify(err.errors ?? '')}`);
  }
  return json as T;
}

type RotateResp = { ok: true; token: string; refresh_token: string; expires_in: number };

async function rotate(refresh: string): Promise<RotateResp> {
  return slackApi<RotateResp>('tooling.tokens.rotate', '', { refresh_token: refresh });
}

// Resolve the token pair from env first, falling back to the cache file.
// On a successful env-based first read with an empty cache, persists the
// pair into the cache so future runs don't need env vars.
export function getConfigTokens(cache: Cache): { access: string; refresh: string } {
  const fromEnvAccess = process.env.SLACK_CONFIG_ACCESS_TOKEN;
  const fromEnvRefresh = process.env.SLACK_CONFIG_REFRESH_TOKEN;
  const access = fromEnvAccess ?? cache.config_access_token;
  const refresh = fromEnvRefresh ?? cache.config_refresh_token;
  if (!access || !refresh) {
    console.error(
      'Missing Slack config tokens.\n' +
        '1. Visit https://api.slack.com/authentication/config-tokens\n' +
        '2. Click "Generate Token" for your workspace.\n' +
        '3. Export them ONCE:\n' +
        '     export SLACK_CONFIG_ACCESS_TOKEN=xoxe.xoxp-...\n' +
        '     export SLACK_CONFIG_REFRESH_TOKEN=xoxe-...\n' +
        '4. Re-run this command. They will be cached in .slack-apps.json\n' +
        '   and auto-refreshed for ~the next 12h.\n',
    );
    process.exit(1);
  }
  // First-use persistence: if env supplied a value not yet in the cache,
  // save it. Subsequent invocations don't need env vars at all.
  if (
    (fromEnvAccess && cache.config_access_token !== fromEnvAccess) ||
    (fromEnvRefresh && cache.config_refresh_token !== fromEnvRefresh)
  ) {
    cache.config_access_token = access;
    cache.config_refresh_token = refresh;
    saveCache(cache);
  }
  return { access, refresh };
}

// Runs `fn(access)` once; on token_expired / invalid_auth, rotates the
// refresh token, persists the new pair, and retries once.
export async function withTokenRefresh<T>(
  cache: Cache,
  fn: (access: string) => Promise<T>,
): Promise<T> {
  const tokens = getConfigTokens(cache);
  try {
    return await fn(tokens.access);
  } catch (err) {
    const msg = (err as Error).message;
    if (!msg.includes('token_expired') && !msg.includes('invalid_auth')) throw err;
    console.log('config token expired, refreshing...');
    const rotated = await rotate(tokens.refresh);
    cache.config_access_token = rotated.token;
    cache.config_refresh_token = rotated.refresh_token;
    saveCache(cache);
    return fn(rotated.token);
  }
}
