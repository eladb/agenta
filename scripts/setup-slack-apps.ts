#!/usr/bin/env bun
// Interactive setup for the agent + tester Slack apps.
// Uses Slack configuration tokens to create apps from manifest, then
// prompts you to install each app and paste back the resulting tokens.
//
// By default, creates the production `agenta` app (cached under key
// `agent` for backwards compatibility) and writes credentials to `.env`.
//
// Pass `--app-name <name>` (e.g. `--app-name agenta-dev`) to create a
// variant of the agent app from the same manifest. Variants are cached
// under their own key and write credentials to `.env.dev`. The tester
// app is always shared — when running in a variant flow, tester
// credentials are still requested (so .env.dev is self-contained) but
// no new tester app is created.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  type AppCacheEntry,
  type Cache,
  loadCache,
  saveCache,
  slackApi,
  withTokenRefresh,
} from './slack-config-tokens';

const ROOT = join(import.meta.dir, '..');
const AGENT_MANIFEST = join(ROOT, 'slack-manifests/agent.json');
const TESTER_MANIFEST = join(ROOT, 'slack-manifests/tester.json');

// The default agent app name (used both as the Slack app name in the
// manifest patch and as the cache key for backwards compatibility).
const DEFAULT_AGENT_APP_NAME = 'agenta';

// Backwards-compat: the original cache stored the default agent entry
// under the key `agent`. Keep using that key when --app-name is left at
// the default. Variants (e.g. agenta-dev) use their own name as the key.
function agentCacheKey(appName: string): string {
  return appName === DEFAULT_AGENT_APP_NAME ? 'agent' : appName;
}

function envPathFor(appName: string): string {
  return join(ROOT, appName === DEFAULT_AGENT_APP_NAME ? '.env' : '.env.dev');
}

type ManifestCreateResp = {
  ok: true;
  app_id: string;
  credentials: { client_id: string; client_secret: string; signing_secret: string };
  oauth_authorize_url: string;
};

type ManifestJson = {
  display_information?: { name?: string };
  features?: { bot_user?: { display_name?: string } } & Record<string, unknown>;
} & Record<string, unknown>;

function readManifest(path: string, overrideName?: string): string {
  const raw = readFileSync(path, 'utf8');
  if (!overrideName) return raw;
  const parsed = JSON.parse(raw) as ManifestJson;
  // Patch BOTH the app name and the bot user's display name so the bot user
  // shows up as `<overrideName>` in Slack instead of `agenta` (with Slack
  // auto-suffixing to disambiguate a duplicate in the workspace). Observed
  // on the first agenta-dev bootstrap — bot landed as `agenta2`.
  parsed.display_information = { ...(parsed.display_information ?? {}), name: overrideName };
  parsed.features = {
    ...(parsed.features ?? {}),
    bot_user: { ...(parsed.features?.bot_user ?? {}), display_name: overrideName },
  };
  return JSON.stringify(parsed);
}

async function createApp(
  access: string,
  manifestPath: string,
  appName?: string,
): Promise<ManifestCreateResp> {
  const manifest = readManifest(manifestPath, appName);
  return slackApi<ManifestCreateResp>('apps.manifest.create', access, { manifest });
}

async function deleteApp(access: string, appId: string): Promise<void> {
  await slackApi('apps.manifest.delete', access, { app_id: appId });
}

async function ensureAgent(cache: Cache, appName: string): Promise<AppCacheEntry> {
  const key = agentCacheKey(appName);
  const existing = cache[key];
  if (existing && typeof existing !== 'string') {
    console.log(`[${appName}] already created: ${existing.app_id}`);
    return existing;
  }
  console.log(`[${appName}] creating app from ${AGENT_MANIFEST}...`);
  const resp = await withTokenRefresh(cache, (access) =>
    createApp(access, AGENT_MANIFEST, appName === DEFAULT_AGENT_APP_NAME ? undefined : appName),
  );
  const entry: AppCacheEntry = { app_id: resp.app_id, install_url: resp.oauth_authorize_url };
  cache[key] = entry;
  saveCache(cache);
  console.log(`[${appName}] created: ${resp.app_id}`);
  return entry;
}

async function ensureTester(cache: Cache): Promise<AppCacheEntry> {
  const existing = cache.tester;
  if (existing) {
    console.log(`[tester] already created: ${existing.app_id}`);
    return existing;
  }
  console.log(`[tester] creating app from ${TESTER_MANIFEST}...`);
  const resp = await withTokenRefresh(cache, (access) => createApp(access, TESTER_MANIFEST));
  const entry: AppCacheEntry = { app_id: resp.app_id, install_url: resp.oauth_authorize_url };
  cache.tester = entry;
  saveCache(cache);
  console.log(`[tester] created: ${resp.app_id}`);
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

function writeEnv(path: string, values: Record<string, string>, force: boolean): void {
  if (existsSync(path) && !force) {
    console.log(
      `\n${path} already exists. Re-run with --force to overwrite, or paste these manually:`,
    );
    for (const [k, v] of Object.entries(values)) console.log(`${k}=${v}`);
    return;
  }
  const body = Object.entries(values)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  writeFileSync(path, `${body}\n`);
  console.log(`\nwrote ${path}`);
}

async function runCreate(opts: { force: boolean; appName: string }): Promise<void> {
  const { appName } = opts;
  const cache = loadCache();
  const agent = await ensureAgent(cache, appName);
  const tester = await ensureTester(cache);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('\n--- install apps ---');
    console.log(`${appName}: ${agent.install_url}`);
    console.log(`tester:  ${tester.install_url}`);
    console.log(`open each, click "Allow", then come back here.`);
    console.log(
      `(if the tester was already installed in a previous run, you can skip its install link)`,
    );
    await prompt(rl, 'press enter when both are installed: ');

    console.log('\n--- bot tokens ---');
    console.log("on each app's install confirmation, copy the Bot User OAuth Token (xoxb-...)");
    const agentBot = await promptToken(rl, `${appName.toUpperCase()} bot token`, 'xoxb-');
    const testerBot = await promptToken(rl, 'TESTER bot token', 'xoxb-');

    console.log('\n--- app-level tokens (Socket Mode) ---');
    console.log(
      `${appName}: ${basicInfoUrl(agent.app_id)} -> App-Level Tokens -> Generate Token and Scopes (scope: connections:write)`,
    );
    console.log(`tester: ${basicInfoUrl(tester.app_id)} -> same. Add scope: connections:write`);
    const agentApp = await promptToken(rl, `${appName.toUpperCase()} app-level token`, 'xapp-');
    const testerApp = await promptToken(rl, 'TESTER app-level token', 'xapp-');

    console.log('\n--- test channel ---');
    console.log(
      'pick a channel both bots are in. Right-click -> View channel details -> copy ID at bottom.',
    );
    const channelId = await prompt(rl, 'paste TEST_CHANNEL_ID (C...): ');

    writeEnv(
      envPathFor(appName),
      {
        SLACK_APP_TOKEN: agentApp,
        SLACK_BOT_TOKEN: agentBot,
        TEST_APP_TOKEN: testerApp,
        TEST_BOT_TOKEN: testerBot,
        TEST_CHANNEL_ID: channelId,
      },
      opts.force,
    );

    if (appName === DEFAULT_AGENT_APP_NAME) {
      console.log('\nnext: invite both bots to the channel, then `bun run e2e`');
    } else {
      console.log(`\nnext: invite ${appName} + tester to the channel, then \`bun run e2e:dev\``);
      console.log(`(or \`bun run dev\` to run the dev bot interactively)`);
    }
  } finally {
    rl.close();
  }
}

async function runDelete(appName: string): Promise<void> {
  const cache = loadCache();
  const targets: Array<{ label: string; key: string }> = [
    { label: appName, key: agentCacheKey(appName) },
  ];
  // Only nuke the (shared) tester when deleting the default agent setup.
  if (appName === DEFAULT_AGENT_APP_NAME) {
    targets.push({ label: 'tester', key: 'tester' });
  }
  for (const { label, key } of targets) {
    const entry = cache[key];
    if (!entry || typeof entry === 'string') {
      console.log(`[${label}] no cached app id; skipping`);
      continue;
    }
    console.log(`[${label}] deleting ${entry.app_id}...`);
    await withTokenRefresh(cache, (access) => deleteApp(access, entry.app_id));
    delete cache[key];
    saveCache(cache);
  }
  console.log('done. note: env files not touched.');
}

function parseArgs(argv: string[]): { force: boolean; del: boolean; appName: string } {
  let appName = DEFAULT_AGENT_APP_NAME;
  let force = false;
  let del = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') force = true;
    else if (a === '--delete') del = true;
    else if (a === '--app-name') {
      const next = argv[i + 1];
      if (!next) {
        console.error('--app-name requires a value');
        process.exit(2);
      }
      appName = next;
      i++;
    } else if (a.startsWith('--app-name=')) {
      appName = a.slice('--app-name='.length);
    } else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return { force, del, appName };
}

const { force, del, appName } = parseArgs(process.argv.slice(2));
if (del) {
  await runDelete(appName);
} else {
  await runCreate({ force, appName });
}
