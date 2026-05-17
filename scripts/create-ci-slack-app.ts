#!/usr/bin/env bun
// One-shot: create the dedicated CI Slack app (`agenta-ci`) from
// `slack-manifests/ci.json`. Idempotent — if `.slack-apps.json` already
// records the `ci` app id, this prints the cached install_url and exits.
//
//   bun scripts/create-ci-slack-app.ts
//
// After this script prints the install URL, the rest is manual (no API
// for it):
//   1. Open the URL, click "Allow" to install in the workspace.
//   2. https://api.slack.com/apps/<app_id>/general — App-Level Tokens
//      → "Generate Token and Scopes" → add `connections:write`.
//   3. Copy the xoxb- bot token and the xapp- app token.
//
// Then set the GitHub Actions secrets used by .github/workflows/e2e-prod.yml:
//   gh secret set CI_SLACK_BOT_TOKEN -R eladb/agenta --body "xoxb-..."
//   gh secret set CI_SLACK_APP_TOKEN -R eladb/agenta --body "xapp-..."

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Cache, loadCache, saveCache, slackApi, withTokenRefresh } from './slack-config-tokens';

const ROOT = join(import.meta.dir, '..');
const MANIFEST = join(ROOT, 'slack-manifests/ci.json');
const KEY = 'ci' as const;

type ManifestCreateResp = {
  ok: true;
  app_id: string;
  credentials: { client_id: string; client_secret: string; signing_secret: string };
  oauth_authorize_url: string;
};

// Cache is typed for { agent, tester } in slack-config-tokens.ts but
// stored as a plain JSON object — adding a `ci` entry works at runtime
// and round-trips through load/save. Cast at the boundary.
type CacheWithCi = Cache & { ci?: { app_id: string; install_url: string } };

const cache = loadCache() as CacheWithCi;
if (cache.ci) {
  console.log(`[ci] already created: ${cache.ci.app_id}`);
  console.log(`install_url: ${cache.ci.install_url}`);
  process.exit(0);
}

const manifest = readFileSync(MANIFEST, 'utf8');
const resp = await withTokenRefresh(cache, (access) =>
  slackApi<ManifestCreateResp>('apps.manifest.create', access, { manifest }),
);

cache.ci = { app_id: resp.app_id, install_url: resp.oauth_authorize_url };
saveCache(cache);

console.log(`\n[ci] created: ${resp.app_id}`);
console.log(`\nNext steps:`);
console.log(`  1. Install:  ${resp.oauth_authorize_url}`);
console.log(`  2. App-Level token: https://api.slack.com/apps/${resp.app_id}/general`);
console.log(`     → "App-Level Tokens" → Generate, add 'connections:write' scope`);
console.log(`  3. Copy xoxb- (Bot User OAuth Token) and xapp- (App-Level Token), then:`);
console.log(`     gh secret set CI_SLACK_BOT_TOKEN -R eladb/agenta --body "xoxb-..."`);
console.log(`     gh secret set CI_SLACK_APP_TOKEN -R eladb/agenta --body "xapp-..."`);
