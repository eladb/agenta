#!/usr/bin/env bun
// Push slack-manifests/<name>.json to the live Slack app via
// apps.manifest.update.
//
//   bun scripts/update-manifest.ts <agent|tester>
//
// Config tokens are read from .slack-apps.json (cached from a prior run)
// or — on first use — from SLACK_CONFIG_ACCESS_TOKEN +
// SLACK_CONFIG_REFRESH_TOKEN env vars. The env-provided pair is persisted
// into the cache on first use, and rotated automatically when expired
// (Slack config tokens rotate every 12h).
//
// On success, Slack returns `permissions_updated: true` if new scopes
// were added — that means you must REINSTALL the app for the bot
// token to gain the new permissions. The bot token usually stays the
// same across reinstalls.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCache, slackApi, withTokenRefresh } from './slack-config-tokens';

const name = process.argv[2];
if (name !== 'agent' && name !== 'tester') {
  console.error('usage: bun scripts/update-manifest.ts <agent|tester>');
  process.exit(1);
}

const repoRoot = join(import.meta.dir, '..');
const manifest = JSON.parse(
  readFileSync(join(repoRoot, `slack-manifests/${name}.json`), 'utf8'),
);
const cache = loadCache();
const appId = cache[name]?.app_id;
if (typeof appId !== 'string') {
  console.error(`Could not find ${name}.app_id in .slack-apps.json`);
  process.exit(1);
}

type UpdateResp = {
  ok: true;
  permissions_updated?: boolean;
};

const body = await withTokenRefresh(cache, (access) =>
  slackApi<UpdateResp>('apps.manifest.update', access, { app_id: appId, manifest }, 'json'),
);

console.log(`manifest updated for ${name} (app_id ${appId})`);
if (body.permissions_updated) {
  console.log('permissions changed — reinstall the app to grant new scopes');
  console.log('install URL:', cache[name]?.install_url);
}
