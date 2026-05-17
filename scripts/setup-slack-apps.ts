#!/usr/bin/env bun
// Interactive setup for the two Slack apps (agent + tester).
// Uses Slack configuration tokens to create apps from manifest, then prompts
// you to install each app and paste back the resulting tokens.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  type Cache,
  loadCache,
  saveCache,
  slackApi,
  withTokenRefresh,
} from './slack-config-tokens';

const ROOT = join(import.meta.dir, '..');
const MANIFESTS = {
  agent: join(ROOT, 'slack-manifests/agent.json'),
  tester: join(ROOT, 'slack-manifests/tester.json'),
  staging: join(ROOT, 'slack-manifests/staging.json'),
};
const ENV_PATH = join(ROOT, '.env');

type AppKey = 'agent' | 'tester' | 'staging';

type ManifestCreateResp = {
  ok: true;
  app_id: string;
  credentials: { client_id: string; client_secret: string; signing_secret: string };
  oauth_authorize_url: string;
};

async function createApp(access: string, manifestPath: string): Promise<ManifestCreateResp> {
  const manifest = readFileSync(manifestPath, 'utf8');
  return slackApi<ManifestCreateResp>('apps.manifest.create', access, { manifest });
}

async function deleteApp(access: string, appId: string): Promise<void> {
  await slackApi('apps.manifest.delete', access, { app_id: appId });
}

async function ensureCreated(
  cache: Cache,
  key: AppKey,
): Promise<{ app_id: string; install_url: string }> {
  const existing = cache[key];
  if (existing) {
    console.log(`[${key}] already created: ${existing.app_id}`);
    return existing;
  }
  console.log(`[${key}] creating app from ${MANIFESTS[key]}...`);
  const resp = await withTokenRefresh(cache, (access) => createApp(access, MANIFESTS[key]));
  const entry = { app_id: resp.app_id, install_url: resp.oauth_authorize_url };
  cache[key] = entry;
  saveCache(cache);
  console.log(`[${key}] created: ${resp.app_id}`);
  return entry;
}

function basicInfoUrl(appId: string): string {
  return `https://api.slack.com/apps/${appId}/general`;
}

async function prompt(rl: ReturnType<typeof createInterface>, q: string): Promise<string> {
  return (await rl.question(q)).trim();
}

async function promptToken(
  rl: ReturnType<typeof createInterface>,
  label: string,
  prefix: string,
): Promise<string> {
  while (true) {
    const v = await prompt(rl, `paste ${label} (${prefix}...): `);
    if (v.startsWith(prefix)) return v;
    console.log(`  expected to start with "${prefix}", try again`);
  }
}

function writeEnv(values: Record<string, string>, force: boolean): void {
  if (existsSync(ENV_PATH) && !force) {
    console.log(
      `\n.env already exists. Re-run with --force to overwrite, or paste these manually:`,
    );
    for (const [k, v] of Object.entries(values)) console.log(`${k}=${v}`);
    return;
  }
  const body = Object.entries(values)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  writeFileSync(ENV_PATH, `${body}\n`);
  console.log(`\nwrote ${ENV_PATH}`);
}

async function runCreate(opts: { force: boolean }): Promise<void> {
  const cache = loadCache();
  const agent = await ensureCreated(cache, 'agent');
  const tester = await ensureCreated(cache, 'tester');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('\n--- install both apps ---');
    console.log(`agent:  ${agent.install_url}`);
    console.log(`tester: ${tester.install_url}`);
    console.log(`open each, click "Allow", then come back here.`);
    await prompt(rl, 'press enter when both are installed: ');

    console.log('\n--- bot tokens ---');
    console.log("on each app's install confirmation, copy the Bot User OAuth Token (xoxb-...)");
    const agentBot = await promptToken(rl, 'AGENT bot token', 'xoxb-');
    const testerBot = await promptToken(rl, 'TESTER bot token', 'xoxb-');

    console.log('\n--- app-level tokens (Socket Mode) ---');
    console.log(
      `agent:  ${basicInfoUrl(agent.app_id)} -> App-Level Tokens -> Generate Token and Scopes`,
    );
    console.log(`tester: ${basicInfoUrl(tester.app_id)} -> same. Add scope: connections:write`);
    const agentApp = await promptToken(rl, 'AGENT app-level token', 'xapp-');
    const testerApp = await promptToken(rl, 'TESTER app-level token', 'xapp-');

    console.log('\n--- test channel ---');
    console.log(
      'pick a channel both bots are in. Right-click -> View channel details -> copy ID at bottom.',
    );
    const channelId = await prompt(rl, 'paste TEST_CHANNEL_ID (C...): ');

    writeEnv(
      {
        SLACK_APP_TOKEN: agentApp,
        SLACK_BOT_TOKEN: agentBot,
        TEST_APP_TOKEN: testerApp,
        TEST_BOT_TOKEN: testerBot,
        TEST_CHANNEL_ID: channelId,
      },
      opts.force,
    );

    console.log('\nnext: invite both bots to the channel, then `bun run e2e`');
  } finally {
    rl.close();
  }
}

async function runDelete(): Promise<void> {
  const cache = loadCache();
  for (const key of ['agent', 'tester'] as const) {
    const id = cache[key]?.app_id;
    if (!id) {
      console.log(`[${key}] no cached app id; skipping`);
      continue;
    }
    console.log(`[${key}] deleting ${id}...`);
    await withTokenRefresh(cache, (access) => deleteApp(access, id));
    delete cache[key];
    saveCache(cache);
  }
  console.log('done. note: .env not touched.');
}

// Provision the staging Slack app used by the CD pipeline. Separate from
// runCreate so it doesn't disturb agent/tester credentials in .env — the
// resulting tokens are meant for GitHub Actions secrets, not local .env.
async function runStaging(): Promise<void> {
  const cache = loadCache();
  const staging = await ensureCreated(cache, 'staging');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('\n--- install the staging app ---');
    console.log(`install: ${staging.install_url}`);
    console.log('open the URL, click "Allow", then come back here.');
    await prompt(rl, 'press enter once installed: ');

    console.log('\n--- bot token ---');
    console.log('copy the Bot User OAuth Token (xoxb-...) from the install confirmation.');
    const bot = await promptToken(rl, 'STAGING bot token', 'xoxb-');

    console.log('\n--- app-level token (Socket Mode) ---');
    console.log(
      `${basicInfoUrl(staging.app_id)} -> App-Level Tokens -> Generate Token and Scopes`,
    );
    console.log('add scope: connections:write');
    const app = await promptToken(rl, 'STAGING app-level token', 'xapp-');

    console.log('\n--- add these as GitHub Actions repository secrets ---');
    console.log(`STAGING_BOT_TOKEN=${bot}`);
    console.log(`STAGING_APP_TOKEN=${app}`);
    console.log('\nthe CD workflow (.github/workflows/cd.yml) reads these.');
    console.log(
      'also: /invite the staging bot to a channel? not required — run-e2e.ts creates a fresh channel per run via the tester.',
    );
  } finally {
    rl.close();
  }
}

const args = process.argv.slice(2);
const force = args.includes('--force');
if (args.includes('--delete')) {
  await runDelete();
} else if (args.includes('--staging')) {
  await runStaging();
} else {
  await runCreate({ force });
}
