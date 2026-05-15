// One-shot Mac setup for the Fly reverse-tunnel transport (Phase 23).
//
// What this does (idempotent across repeated runs):
//   1. Verify `flyctl` is on PATH.
//   2. Verify `flyctl auth whoami` succeeds.
//   3. Generate (if missing) the Mac-side ed25519 keypair the bot will use
//      to dial into per-sandbox dropbear servers — `~/.ssh/agenta_tunnel_id_ed25519`.
//      The bot reads this path at runtime; the public key gets dropped into
//      each sandbox's /root/.ssh/authorized_keys during ensureRepoBootstrap.
//   4. Create (if missing) the Fly WireGuard peer for this Mac via
//      `flyctl wireguard create`. Output is `./agenta-mac.conf`.
//   5. Print instructions for the user to import the .conf into the macOS
//      WireGuard app and activate it. This script does NOT — and cannot —
//      activate the tunnel itself; the GUI step is unavoidable for the
//      built-in WireGuard.app on macOS.
//
// Re-running the script when everything is already in place prints all
// status lines as no-ops so the user always gets a complete picture.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function step(n: number, total: number, msg: string): void {
  console.log(`\n[step ${n}/${total}] ${msg}`);
}

function ok(msg: string): void {
  console.log(`  OK  ${msg}`);
}

function note(msg: string): void {
  console.log(`  --  ${msg}`);
}

function fail(msg: string): never {
  console.error(`  FAIL ${msg}`);
  process.exit(1);
}

const TOTAL = 5;

// Step 1 — flyctl on PATH.
step(1, TOTAL, 'check flyctl is installed');
{
  const r = spawnSync('flyctl', ['version'], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) {
    fail(
      'flyctl not found on PATH.\n' +
        '       Install via `brew install flyctl` (or see https://fly.io/docs/flyctl/install/).',
    );
  }
  ok(`flyctl ${r.stdout.toString('utf8').trim().split('\n')[0]}`);
}

// Step 2 — flyctl auth.
step(2, TOTAL, 'check flyctl auth status');
{
  const r = spawnSync('flyctl', ['auth', 'whoami'], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) {
    fail(
      'flyctl is not authenticated.\n' +
        '       Run `flyctl auth login` (will open a browser), then re-run this script.',
    );
  }
  ok(`logged in as ${r.stdout.toString('utf8').trim()}`);
}

// Step 3 — Mac-side tunnel keypair.
const keyPath = join(homedir(), '.ssh', 'agenta_tunnel_id_ed25519');
const pubPath = `${keyPath}.pub`;
step(3, TOTAL, `ensure Mac tunnel keypair at ${keyPath}`);
if (existsSync(keyPath)) {
  note('keypair already present — skipping ssh-keygen');
  ok(`public key: ${pubPath}`);
} else {
  const r = spawnSync(
    'ssh-keygen',
    ['-t', 'ed25519', '-N', '', '-f', keyPath, '-C', 'agenta-tunnel-mac'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (r.status !== 0) {
    fail(`ssh-keygen failed: ${r.stderr.toString('utf8').trim()}`);
  }
  ok(`generated ${keyPath}`);
  ok(`public key: ${pubPath}`);
}

// Step 4 — Fly WireGuard peer for this Mac.
const hostnameRes = spawnSync('hostname', ['-s'], { stdio: ['ignore', 'pipe', 'pipe'] });
const hostShort = hostnameRes.stdout.toString('utf8').trim() || 'unknown';
const peerName = `agenta-mac-${hostShort}`;
const region = process.env.FLY_REGION || 'lhr';
const confPath = './agenta-mac.conf';

step(4, TOTAL, `ensure Fly WireGuard peer ${peerName}`);
{
  const list = spawnSync('flyctl', ['wireguard', 'list'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const listOut = list.stdout.toString('utf8');
  if (list.status === 0 && listOut.includes(peerName)) {
    note(`peer ${peerName} already exists`);
    if (existsSync(confPath)) {
      ok(`existing config at ${confPath}`);
    } else {
      note(`no local ${confPath} found — if you've lost it, remove the peer via`);
      note(`  flyctl wireguard remove personal ${peerName}`);
      note('  and re-run this script to regenerate.');
    }
  } else {
    const r = spawnSync('flyctl', ['wireguard', 'create', 'personal', region, peerName, confPath], {
      stdio: 'inherit',
    });
    if (r.status !== 0) {
      fail(`flyctl wireguard create failed (status ${r.status})`);
    }
    ok(`created peer ${peerName} → ${confPath}`);
  }
}

// Step 5 — instructions.
step(5, TOTAL, 'next steps (manual)');
console.log(`
  1. Open the macOS WireGuard app (https://apps.apple.com/us/app/wireguard/id1451685025).
  2. File → Import Tunnel(s) from File…  → select ${confPath}.
  3. Activate the imported tunnel.
  4. Verify connectivity:
       ping6 -c 1 fdaa::1
     (Fly's gateway address — should respond.)
  5. With the WireGuard tunnel active, sandbox provisioning will spawn the
     reverse-SSH tunnel automatically. Set SANDBOX_PROVIDER=fly in your .env
     and the bot will reach per-thread Fly sandboxes over their fdaa::*
     IPv6 addresses.

  Public key the bot installs into each sandbox's authorized_keys:
    ${pubPath}
`);
