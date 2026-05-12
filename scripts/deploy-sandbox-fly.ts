#!/usr/bin/env bun
// Provisions + (re)deploys the sandbox image to Fly.
//
//   bun scripts/deploy-sandbox-fly.ts
//
// Idempotent. Run it once for initial setup, and again whenever the
// Dockerfile or sandbox-server changes — the bot picks up the new image
// the next time it creates a machine (existing machines keep the old
// image until destroyed via /delete).
//
// Steps:
//   1. Verify flyctl is installed and authenticated.
//   2. Create the Fly app if it doesn't exist.
//   3. `fly deploy --build-only --push` from the sandbox/ directory.
//      Builds the Dockerfile remotely on Fly's builder and pushes to the
//      registry — no machine is started. The bot creates machines on
//      demand via the Machines API.
//   4. Print the env vars to put in .env.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SANDBOX_DIR = join(SCRIPT_DIR, '..', 'sandbox');
const APP = process.env.FLY_APP_NAME ?? 'agenta-sandbox';

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
if (!who.ok) {
  die('flyctl is not authenticated. Run: flyctl auth login');
}
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
const exists = apps.some((a) => a.Name === APP);
if (!exists) {
  console.log(`creating Fly app: ${APP}`);
  const create = fly(['apps', 'create', APP]);
  if (!create.ok) die(`failed to create app ${APP}`);
} else {
  console.log(`✓ Fly app exists: ${APP}`);
}

// 4. Build + push the image. --build-only --push: builds the Dockerfile on
//    Fly's remote builder and pushes to registry.fly.io/<app>:latest. Does
//    NOT create any machines.
console.log(`\ndeploying image from ${SANDBOX_DIR}…`);
// --image-label latest pins the registry tag to `latest` so the bot can
// reference registry.fly.io/<app>:latest unambiguously. Default would be
// deployment-<timestamp>, which we'd then have to track.
const deploy = fly(['deploy', '-a', APP, '--build-only', '--push', '--image-label', 'latest'], {
  cwd: SANDBOX_DIR,
});
if (!deploy.ok) die('fly deploy failed (see output above)');

console.log(`\n✓ image pushed: registry.fly.io/${APP}:latest`);

// 5. Allocate public IPs so the app's <app>.fly.dev hostname actually
//    resolves. Fly apps don't get IPs by default; without these the bot
//    can't reach the per-thread machines we'll create. Shared IPv4 is free
//    and good enough for our HTTPS-only traffic.
const ips = fly(['ips', 'list', '-a', APP, '--json'], { capture: true });
let hasV4 = false;
let hasV6 = false;
if (ips.ok) {
  try {
    const list = JSON.parse(ips.stdout) as Array<{ Type?: string }>;
    hasV4 = list.some((ip) => ip.Type === 'shared_v4' || ip.Type === 'v4');
    hasV6 = list.some((ip) => ip.Type === 'v6' || ip.Type === 'private_v6');
  } catch {
    // ignore parse errors, just (re-)allocate
  }
}
if (!hasV4) {
  console.log('\nallocating shared IPv4 for the app…');
  const v4 = fly(['ips', 'allocate-v4', '-a', APP, '--shared', '-y']);
  if (!v4.ok) die('fly ips allocate-v4 failed');
} else {
  console.log(`✓ shared IPv4 already allocated`);
}
if (!hasV6) {
  console.log('allocating IPv6 for the app…');
  const v6 = fly(['ips', 'allocate-v6', '-a', APP]);
  if (!v6.ok) die('fly ips allocate-v6 failed');
} else {
  console.log(`✓ IPv6 already allocated`);
}
console.log('');
console.log('Next steps:');
console.log(`  1. Generate an API token (one-time):`);
console.log(`     flyctl tokens create deploy -a ${APP}`);
console.log('');
console.log(`  2. Add to .env:`);
console.log(`     SANDBOX_PROVIDER=fly`);
console.log(`     FLY_APP_NAME=${APP}`);
console.log(`     FLY_API_TOKEN=<token from step 1>`);
console.log('');
console.log('Then `bun start` will create per-thread Fly machines for sandboxes.');
