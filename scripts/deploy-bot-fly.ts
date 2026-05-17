#!/usr/bin/env bun
// Provisions + (re)deploys the agenta bot to Fly.
//
//   bun scripts/deploy-bot-fly.ts
//
// Idempotent. Run once for initial setup, and again whenever you want to
// roll a new image. The bot runs as a single long-lived machine on app
// `agenta-bot` (separate from `agenta-sandbox`, which hosts the per-thread
// sandbox machines).
//
// Steps:
//   1. Verify flyctl is installed + authenticated.
//   2. Create the Fly app if it doesn't exist (no public IPs — Socket Mode
//      is outbound-only, no inbound surface needed).
//   3. Create the persistent volume `agenta_data` in iad if missing.
//   4. `fly deploy` from the repo root — builds Dockerfile remotely +
//      starts/updates the bot machine.
//   5. Print the `flyctl secrets set` commands the user needs to run.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');
const APP = process.env.FLY_BOT_APP_NAME ?? 'agenta-bot';
const REGION = process.env.FLY_REGION ?? 'iad';
const VOLUME = 'agenta_data';
const VOLUME_SIZE_GB = 1;

type Result = { ok: boolean; stdout: string; stderr: string };

function fly(args: string[], opts: { capture?: boolean; cwd?: string } = {}): Result {
  const r = spawnSync('flyctl', args, {
    encoding: 'utf8',
    stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
    cwd: opts.cwd,
  });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function die(msg: string): never {
  console.error(`\nERROR: ${msg}\n`);
  process.exit(1);
}

// 1. flyctl present?
const version = spawnSync('flyctl', ['version'], { stdio: 'ignore' });
if (version.status !== 0) {
  die('flyctl not found on PATH. Install: https://fly.io/docs/flyctl/install/');
}

// 2. Authenticated?
const who = fly(['auth', 'whoami'], { capture: true });
if (!who.ok) die('flyctl is not authenticated. Run: flyctl auth login');
console.log(`✓ flyctl authenticated as ${who.stdout.trim()}`);

// 3. App exists?
const list = fly(['apps', 'list', '--json'], { capture: true });
if (!list.ok) die(`flyctl apps list failed:\n${list.stderr}`);
let apps: Array<{ Name: string }>;
try {
  apps = JSON.parse(list.stdout);
} catch (err) {
  die(`could not parse flyctl apps list output: ${(err as Error).message}`);
}
if (!apps.some((a) => a.Name === APP)) {
  console.log(`creating Fly app: ${APP}`);
  const create = fly(['apps', 'create', APP]);
  if (!create.ok) die(`failed to create app ${APP}`);
} else {
  console.log(`✓ Fly app exists: ${APP}`);
}

// 4. Volume exists?
const vols = fly(['volumes', 'list', '-a', APP, '--json'], { capture: true });
if (!vols.ok) die(`flyctl volumes list failed:\n${vols.stderr}`);
let volList: Array<{ name?: string; Name?: string; region?: string; Region?: string }>;
try {
  volList = JSON.parse(vols.stdout);
} catch (err) {
  die(`could not parse flyctl volumes list output: ${(err as Error).message}`);
}
const volName = (v: (typeof volList)[number]): string => v.name ?? v.Name ?? '';
const volRegion = (v: (typeof volList)[number]): string => v.region ?? v.Region ?? '';
const existing = volList.find((v) => volName(v) === VOLUME);
if (!existing) {
  console.log(`creating volume ${VOLUME} (${VOLUME_SIZE_GB} GB) in ${REGION}`);
  const v = fly([
    'volumes',
    'create',
    VOLUME,
    '-a',
    APP,
    '--region',
    REGION,
    '--size',
    String(VOLUME_SIZE_GB),
    '--yes',
  ]);
  if (!v.ok) die('fly volumes create failed');
} else {
  console.log(`✓ volume ${VOLUME} exists in ${volRegion(existing) || '?'}`);
}

// 5. Deploy — full deploy this time, not --build-only. Builds Dockerfile
//    remotely and rolls the (single) machine to the new image.
console.log(`\ndeploying bot from ${REPO_ROOT}…`);
const deploy = fly(['deploy', '-a', APP], { cwd: REPO_ROOT });
if (!deploy.ok) die('fly deploy failed (see output above)');

console.log(`\n✓ bot deployed: ${APP}`);
console.log('');
console.log('Set the runtime secrets (one-time; persists across deploys):');
console.log('');
console.log(`  flyctl secrets set -a ${APP} \\`);
console.log('    SLACK_APP_TOKEN=xapp-... \\');
console.log('    SLACK_BOT_TOKEN=xoxb-... \\');
console.log('    MODEL_API_KEY=sk-ant-... \\');
console.log('    GITHUB_TOKEN=<fine-grained PAT, read+write to AGENT_HOME_REPO> \\');
console.log(`    FLY_API_TOKEN=<token from: flyctl tokens create deploy -a agenta-sandbox>`);
console.log('');
console.log(`Then tail logs:  flyctl logs -a ${APP}`);
