#!/usr/bin/env bun
// Push slack-manifests/agent.json to the live Slack app via
// apps.manifest.update.
//
//   SLACK_CONFIG_ACCESS_TOKEN=xoxe-... bun scripts/update-agent-manifest.ts
//
// Config tokens rotate every 12h; generate a fresh one from
// https://api.slack.com/authentication/config-tokens if needed.
//
// On success, Slack returns `permissions_updated: true` if new scopes
// were added — that means you must REINSTALL the app for the bot token
// to gain the new permissions. The bot token usually stays the same
// across reinstalls.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const accessToken = process.env.SLACK_CONFIG_ACCESS_TOKEN;
if (!accessToken) {
  console.error(
    'SLACK_CONFIG_ACCESS_TOKEN is required. Generate one at',
    'https://api.slack.com/authentication/config-tokens',
  );
  process.exit(1);
}

const repoRoot = join(import.meta.dir, '..');
const manifest = JSON.parse(readFileSync(join(repoRoot, 'slack-manifests/agent.json'), 'utf8'));
const cache = JSON.parse(readFileSync(join(repoRoot, '.slack-apps.json'), 'utf8'));
const appId = cache.agent?.app_id;
if (typeof appId !== 'string') {
  console.error('Could not find agent.app_id in .slack-apps.json');
  process.exit(1);
}

const res = await fetch('https://slack.com/api/apps.manifest.update', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json; charset=utf-8',
  },
  body: JSON.stringify({ app_id: appId, manifest }),
});

const body = (await res.json()) as {
  ok: boolean;
  error?: string;
  permissions_updated?: boolean;
};

if (!body.ok) {
  console.error('apps.manifest.update failed:', body.error);
  process.exit(1);
}

console.log('manifest updated for app_id', appId);
if (body.permissions_updated) {
  console.log('permissions changed — reinstall the app to grant new scopes');
  console.log('install URL:', cache.agent?.install_url);
}
