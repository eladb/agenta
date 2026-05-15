// Per-sandbox reverse SSH tunnel over Fly's WireGuard mesh (Phase 23).
//
// On docker, the sandbox reaches the host's sshd directly through Docker
// Desktop's loopback alias (host.docker.internal:22). On Fly there's no
// such bridge — the sandbox lives on a Firecracker VM behind Fly's
// 6PN/WireGuard mesh and has no route to the Mac's local sshd.
//
// Solution: per sandbox, spawn one autossh on the Mac that dials the
// sandbox's dropbear server (port 2200) over the user's WireGuard tunnel
// and creates a reverse port-forward (-R 0.0.0.0:2222:localhost:22).
// Git inside the sandbox then does `ssh user@localhost -p 2222 …` and
// terminates at the Mac's sshd. agenta-git-shell + pre-receive (phase 22)
// run unchanged.
//
// One autossh process per active sandbox. Tracked in a module-level Map
// keyed by threadKey. Self-healing: ensureTunnel is called from
// ensureRepoBootstrap on every turn, and detects (a) missing handle,
// (b) dead pid, (c) flyIp drift from the in-memory record, respawning
// in any of those cases.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { log } from '../log';
import { dataRoot } from '../persistence/store';
import { runBash } from '../sandbox';

// Path to the Mac-side tunnel keypair created by `bun run setup-tunnel`. The
// public half is installed into each sandbox's /root/.ssh/authorized_keys
// from `bootstrap.ts`; the private half is what autossh uses to log in.
export function getTunnelKeyPath(): string {
  const path = join(homedir(), '.ssh', 'agenta_tunnel_id_ed25519');
  if (!existsSync(path)) {
    throw new Error(
      `tunnel keypair missing at ${path}. Run \`bun run setup-tunnel\` to generate it.`,
    );
  }
  return path;
}

export function getTunnelPublicKeyPath(): string {
  return `${getTunnelKeyPath()}.pub`;
}

// Per-thread known_hosts file. A re-provisioned sandbox gets a fresh
// dropbear host key, so we need an isolated known_hosts per thread —
// otherwise the second provision would trip "host key changed" on the
// stale entry.
function knownHostsPathFor(threadKey: string): string {
  return join(dataRoot(), 'tunnel-hosts', threadKey);
}

export type TunnelHandle = {
  pid: number;
  flyIp: string;
};

const tunnels = new Map<string, TunnelHandle>();

// Test seam — swappable to record spawn calls without forking real
// processes. The default uses node:child_process spawn (consistent with
// other modules in src/git/). Returns the spawned pid; the spawn
// implementation must detach the child so it survives this function
// returning.
export type SpawnFn = (args: string[]) => number;
let spawnImpl: SpawnFn = defaultSpawn;

export function _setSpawnImpl(fn: SpawnFn | undefined): void {
  spawnImpl = fn ?? defaultSpawn;
}

function defaultSpawn(args: string[]): number {
  // detached + unref so autossh keeps running independently of this
  // process's event loop / lifetime.
  const proc = spawn('autossh', args, {
    detached: true,
    stdio: 'ignore',
  });
  proc.unref();
  if (typeof proc.pid !== 'number') {
    throw new Error('autossh spawn returned no pid');
  }
  return proc.pid;
}

function isAlive(pid: number): boolean {
  try {
    // Signal 0 is a probe — no signal delivered, but the kernel still
    // does the permission/existence check. Throws ESRCH if the pid is
    // gone, EPERM if it exists but is owned by another user (which we
    // treat as "alive" — not ours but the pid is taken).
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    return false;
  }
}

// Wait until the sandbox can reach localhost:2222 (i.e. the reverse forward
// is up). Poll via `runBash` so we test the actual end-to-end path. Caps at
// 10s — autossh normally establishes in <2s on a healthy WireGuard mesh.
async function waitForReverseForward(threadKey: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // `bash -c "exec 3<>/dev/tcp/...` is a builtin so we don't depend on nc
  // being present in the image. Returns exit 0 iff the TCP handshake to
  // localhost:2222 succeeds.
  const probe = 'bash -c "exec 3<>/dev/tcp/localhost/2222" 2>/dev/null';
  while (Date.now() < deadline) {
    const res = await runBash(threadKey, probe);
    if (res.exitCode === 0) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `reverse tunnel for ${threadKey} not reachable on localhost:2222 within ${timeoutMs}ms`,
  );
}

export async function ensureTunnel(threadKey: string, flyIp: string): Promise<void> {
  const existing = tunnels.get(threadKey);
  if (existing && existing.flyIp === flyIp && isAlive(existing.pid)) return;

  if (existing) {
    // Stale (pid dead or flyIp drift). Tear down before spawning anew so we
    // don't leak.
    log.info(
      'tunnel',
      `[${threadKey}] respawning autossh (was pid ${existing.pid}, flyIp ${existing.flyIp} → ${flyIp})`,
    );
    await stopTunnel(threadKey);
  }

  const keyPath = getTunnelKeyPath();
  const knownHostsPath = knownHostsPathFor(threadKey);
  await mkdir(dirname(knownHostsPath), { recursive: true });

  // autossh argv:
  //   -M 0     no monitoring port; rely on ServerAliveInterval for liveness
  //   -N       no remote command, just port-forward
  //   -R …     reverse forward: bind 0.0.0.0:2222 inside the sandbox to
  //            localhost:22 on this Mac. The sandbox-side port stays open
  //            for git/ssh clients running inside the sandbox.
  //   -p 2200  dropbear listens on 2200 (high port, no CAP_NET_BIND_SERVICE
  //            needed)
  //   -i …     the Mac-side ed25519 key generated by setup-tunnel.ts
  //   StrictHostKeyChecking=accept-new persists the dropbear host key on
  //     first connect; subsequent connects verify against it. Combined with
  //     a per-thread UserKnownHostsFile this stays safe across sandbox
  //     re-provisioning (each thread gets a fresh dropbear key + fresh
  //     known_hosts file).
  //   ExitOnForwardFailure=yes — if the reverse forward can't be set up
  //     (port already bound or sandbox refused), exit instead of silently
  //     running with no tunnel. autossh's restart logic re-runs us.
  //   ServerAliveInterval=15 — heartbeat so we notice dead tunnels and
  //     autossh kicks a reconnect.
  const args = [
    '-M',
    '0',
    '-N',
    '-R',
    '0.0.0.0:2222:localhost:22',
    '-p',
    '2200',
    '-i',
    keyPath,
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    `UserKnownHostsFile=${knownHostsPath}`,
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=15',
    `root@${flyIp}`,
  ];

  const pid = spawnImpl(args);
  tunnels.set(threadKey, { pid, flyIp });
  log.info('tunnel', `[${threadKey}] spawned autossh pid=${pid} → root@${flyIp}`);

  // Block until the sandbox actually sees the reverse-forward port. Without
  // this, the very next `git clone` could race the tunnel setup and fail.
  // If it never comes up we leave the autossh running (it'll keep retrying
  // and the next ensureTunnel call will adopt it on success) but throw so
  // the caller knows bootstrap can't proceed.
  await waitForReverseForward(threadKey);
}

export async function stopTunnel(threadKey: string): Promise<void> {
  const handle = tunnels.get(threadKey);
  if (!handle) return;
  tunnels.delete(threadKey);
  try {
    process.kill(handle.pid, 'SIGTERM');
  } catch {
    // Already gone; nothing to do.
    return;
  }
  // Give it up to 2s to exit cleanly, then SIGKILL.
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!isAlive(handle.pid)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    process.kill(handle.pid, 'SIGKILL');
  } catch {
    // Best-effort.
  }
}

export async function stopAllTunnels(): Promise<void> {
  const keys = [...tunnels.keys()];
  await Promise.all(keys.map((k) => stopTunnel(k)));
}

// For tests.
export function _resetForTests(): void {
  tunnels.clear();
  spawnImpl = defaultSpawn;
}

export function _getHandle(threadKey: string): TunnelHandle | undefined {
  return tunnels.get(threadKey);
}
