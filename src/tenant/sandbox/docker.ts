import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { log } from '../../shared/log';
import { clearSandbox, loadSandbox, saveSandbox, sweepAllSandboxes } from './persistence';
import type { SandboxEndpoint, SandboxProvider } from './provider';

export const SANDBOX_IMAGE = 'agenta-sandbox:latest';
export const SANDBOX_NETWORK = 'agenta-sandbox-net';
const SANDBOX_PORT = 9000;
const CONTAINER_PREFIX = 'agenta-';
const VOLUME_PREFIX = 'agenta-vol-';

const DOCKERFILE_DIR = join(import.meta.dir, '..', '..', 'sandbox');

export function containerName(threadKey: string): string {
  return `${CONTAINER_PREFIX}${threadKey}`;
}

export function volumeName(threadKey: string): string {
  return `${VOLUME_PREFIX}${threadKey}`;
}

type DockerCmdResult = { stdout: string; stderr: string; exitCode: number };
type DockerSpawnOpts = { signal?: AbortSignal; stdin?: string };

function dockerSpawn(args: string[], opts: DockerSpawnOpts = {}): Promise<DockerCmdResult> {
  return new Promise((resolve, reject) => {
    const stdinSpec = opts.stdin !== undefined ? 'pipe' : 'ignore';
    const proc = spawn('docker', args, { stdio: [stdinSpec, 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
    if (opts.signal) {
      const sig = opts.signal;
      const onAbort = (): void => {
        proc.kill('SIGTERM');
      };
      sig.addEventListener('abort', onAbort);
      proc.on('close', () => sig.removeEventListener('abort', onAbort));
    }
    if (opts.stdin !== undefined && proc.stdin) {
      proc.stdin.end(opts.stdin);
    }
  });
}

let imageReady: Promise<void> | undefined;
let networkReady: Promise<void> | undefined;

export async function ensureImage(): Promise<void> {
  if (imageReady) return imageReady;
  const p = (async (): Promise<void> => {
    const inspect = await dockerSpawn(['image', 'inspect', SANDBOX_IMAGE]);
    if (inspect.exitCode === 0) return;
    log.info('sandbox', `building image ${SANDBOX_IMAGE}…`);
    const build = await dockerSpawn(['build', '-t', SANDBOX_IMAGE, DOCKERFILE_DIR]);
    if (build.exitCode !== 0) {
      throw new Error(`docker build failed: ${build.stderr || build.stdout}`);
    }
    log.info('sandbox', `image ${SANDBOX_IMAGE} ready`);
  })();
  p.catch(() => {
    if (imageReady === p) imageReady = undefined;
  });
  imageReady = p;
  return p;
}

export async function ensureNetwork(): Promise<void> {
  if (networkReady) return networkReady;
  const p = (async (): Promise<void> => {
    const inspect = await dockerSpawn(['network', 'inspect', SANDBOX_NETWORK]);
    if (inspect.exitCode === 0) return;
    log.info('sandbox', `creating bridge network ${SANDBOX_NETWORK}…`);
    // TODO(egress-block): in-container iptables OUTPUT rules cover egress; a
    // host-side DOCKER-USER rule tied to container IPs would be the proper
    // defense-in-depth fix. Deferred.
    const create = await dockerSpawn(['network', 'create', '--driver', 'bridge', SANDBOX_NETWORK]);
    if (create.exitCode !== 0) {
      throw new Error(`docker network create failed: ${create.stderr || create.stdout}`);
    }
    log.info('sandbox', `network ${SANDBOX_NETWORK} ready`);
  })();
  p.catch(() => {
    if (networkReady === p) networkReady = undefined;
  });
  networkReady = p;
  return p;
}

// Bearer token per thread. Set by ensure() at create time. The host port is
// NOT cached — Docker Desktop auto-restarts containers behind us and
// reassigns a new random host port on each restart. So we look up the live
// port via `docker port` on every getEndpoint call (~50ms).
const tokens = new Map<string, string>();

function randomToken(): string {
  return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
}

async function waitForHealth(hostPort: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${hostPort}/health`);
      if (res.status === 200) return;
      lastErr = `status ${res.status}`;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`sandbox-server not healthy after ${timeoutMs}ms: ${String(lastErr)}`);
}

async function readHostPort(name: string): Promise<number> {
  const res = await dockerSpawn(['port', name, `${SANDBOX_PORT}/tcp`]);
  if (res.exitCode !== 0) {
    throw new Error(`docker port ${name} failed: ${res.stderr || res.stdout}`);
  }
  const lines = res.stdout.trim().split('\n');
  const preferred = lines.find((l) => l.startsWith('127.0.0.1:')) ?? lines[0];
  if (!preferred) throw new Error(`docker port ${name} returned no mapping`);
  const port = Number(preferred.split(':').pop());
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`docker port ${name} parse error: ${preferred}`);
  }
  return port;
}

// Liveness check for a previously-persisted record. ~3s timeout via
// AbortSignal so a hung daemon can't block a turn. Returns true iff the
// container exists AND State.Running is true.
async function verifyAlive(name: string): Promise<boolean> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 3_000);
  try {
    const inspect = await dockerSpawn(['inspect', '--format', '{{.State.Running}}', name], {
      signal: ac.signal,
    });
    if (inspect.exitCode !== 0) return false;
    return inspect.stdout.trim() === 'true';
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function volumeExists(name: string): Promise<boolean> {
  const res = await dockerSpawn(['volume', 'inspect', name]);
  return res.exitCode === 0;
}

async function ensureVolume(name: string): Promise<void> {
  if (await volumeExists(name)) return;
  const res = await dockerSpawn(['volume', 'create', name]);
  if (res.exitCode !== 0) {
    throw new Error(`docker volume create ${name} failed: ${res.stderr || res.stdout}`);
  }
}

// Best-effort: a volume removal can fail if some other container still holds
// a reference (shouldn't happen in normal flow since we remove the container
// first, but worth tolerating).
async function removeVolume(name: string): Promise<void> {
  const res = await dockerSpawn(['volume', 'rm', name]);
  if (res.exitCode !== 0 && !/no such volume/i.test(res.stderr)) {
    log.warn('sandbox', `docker volume rm ${name}: ${res.stderr.trim()}`);
  }
}

// docker run flags shared between fresh provisioning and re-provisioning
// against an existing volume. Splitting this out keeps the two ensure-paths
// (cold start + dead-container/live-volume reattach) honestly identical
// modulo the in-memory bookkeeping.
function runArgs(name: string, vol: string, token: string): string[] {
  return [
    'run',
    '-d',
    '--name',
    name,
    '--network',
    SANDBOX_NETWORK,
    '-p',
    `127.0.0.1::${SANDBOX_PORT}`,
    '-e',
    `SANDBOX_TOKEN=${token}`,
    ...(process.env.SANDBOX_EXEC_TIMEOUT_MS
      ? ['-e', `SANDBOX_EXEC_TIMEOUT_MS=${process.env.SANDBOX_EXEC_TIMEOUT_MS}`]
      : []),
    ...(process.env.SANDBOX_EGRESS ? ['-e', `SANDBOX_EGRESS=${process.env.SANDBOX_EGRESS}`] : []),
    '-w',
    '/home/sandbox',
    '-v',
    `${vol}:/home/sandbox`,
    // entrypoint.sh wants NET_ADMIN for iptables, plus SETUID/SETGID/SETPCAP
    // for the setpriv-to-sandbox-user drop. All four are dropped from the
    // bounding set after setpriv runs, so the unprivileged process can
    // never reach them.
    '--cap-drop',
    'ALL',
    '--cap-add',
    'NET_ADMIN',
    '--cap-add',
    'SETUID',
    '--cap-add',
    'SETGID',
    '--cap-add',
    'SETPCAP',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '256',
    '--memory',
    '1g',
    '--cpus',
    '1.0',
    SANDBOX_IMAGE,
  ];
}

async function ensureContainer(threadKey: string): Promise<void> {
  await Promise.all([ensureImage(), ensureNetwork()]);
  const name = containerName(threadKey);
  const vol = volumeName(threadKey);

  if (tokens.has(threadKey)) {
    const inspect = await dockerSpawn(['inspect', '-f', '{{.State.Status}}', name]);
    if (inspect.exitCode === 0 && inspect.stdout.trim() === 'running') return;
    tokens.delete(threadKey);
  }

  // Re-hydration path: in-memory cache is empty, but disk may carry a record
  // from a previous bot process.
  //   - same-provider, live container → adopt it.
  //   - same-provider, dead container, **live volume** → create a fresh
  //     container attached to the existing volume. The thread's state
  //     (workspace files, caches, the agent home seed) survives.
  //   - cross-provider or fully-missing → clear and provision from scratch.
  const persisted = await loadSandbox(threadKey);
  if (persisted) {
    if (persisted.provider !== 'docker') {
      log.warn(
        'sandbox',
        `[${threadKey}] persisted sandbox is ${persisted.provider}; SANDBOX_PROVIDER=docker — ignoring`,
      );
      await clearSandbox(threadKey);
    } else if (persisted.container_name === name && (await verifyAlive(name))) {
      tokens.set(threadKey, persisted.token);
      log.info('sandbox', `re-hydrated container ${name} from session.json`);
      return;
    } else if (persisted.volume_name && (await volumeExists(persisted.volume_name))) {
      // Dead container, live volume. Create a fresh container attached to
      // the existing volume; keep the previous token so anyone holding it
      // (e.g. an in-flight HTTP client) can keep going. The entrypoint
      // copy-if-missing seeder no-ops because README.md already exists in
      // the volume from the first provision.
      log.info(
        'sandbox',
        `[${threadKey}] persisted container ${persisted.container_name} dead; reattaching to volume ${persisted.volume_name}`,
      );
      const inspectStale = await dockerSpawn(['inspect', persisted.container_name]);
      if (inspectStale.exitCode === 0) {
        await dockerSpawn(['rm', '-fv', persisted.container_name]);
      }
      const token = persisted.token;
      const run = await dockerSpawn(runArgs(name, persisted.volume_name, token));
      if (run.exitCode !== 0) {
        throw new Error(`docker run ${name} failed: ${run.stderr || run.stdout}`);
      }
      const hostPort = await readHostPort(name);
      await waitForHealth(hostPort);
      tokens.set(threadKey, token);
      await saveSandbox(threadKey, {
        provider: 'docker',
        container_name: name,
        token,
        volume_name: persisted.volume_name,
      });
      log.info(
        'sandbox',
        `container ${name} ready on :${hostPort} (reattached volume ${persisted.volume_name})`,
      );
      return;
    } else {
      log.info(
        'sandbox',
        `[${threadKey}] persisted container ${persisted.container_name} not alive (and no live volume); re-provisioning`,
      );
      await clearSandbox(threadKey);
    }
  }

  const inspectStale = await dockerSpawn(['inspect', name]);
  if (inspectStale.exitCode === 0) {
    await dockerSpawn(['rm', '-fv', name]);
  }

  await ensureVolume(vol);
  const token = randomToken();
  const run = await dockerSpawn(runArgs(name, vol, token));
  if (run.exitCode !== 0) {
    throw new Error(`docker run ${name} failed: ${run.stderr || run.stdout}`);
  }
  const hostPort = await readHostPort(name);
  await waitForHealth(hostPort);
  tokens.set(threadKey, token);
  await saveSandbox(threadKey, {
    provider: 'docker',
    container_name: name,
    token,
    volume_name: vol,
  });
  log.info('sandbox', `container ${name} ready on :${hostPort} (volume ${vol})`);
}

async function getEndpoint(threadKey: string): Promise<SandboxEndpoint> {
  let token = tokens.get(threadKey);
  if (!token) {
    // Lazy re-hydration: in-memory cache is empty but disk may carry a live
    // record from a previous bot process. Adopt it without provisioning a
    // new container; if it's dead, clear it and surface a clear error so
    // the caller knows to `ensure` first.
    const persisted = await loadSandbox(threadKey);
    if (
      persisted &&
      persisted.provider === 'docker' &&
      persisted.container_name === containerName(threadKey) &&
      (await verifyAlive(persisted.container_name))
    ) {
      tokens.set(threadKey, persisted.token);
      token = persisted.token;
      log.info('sandbox', `[${threadKey}] re-hydrated endpoint from session.json`);
    } else {
      if (persisted) await clearSandbox(threadKey);
      throw new Error(`sandbox not initialized for ${threadKey}`);
    }
  }
  const port = await readHostPort(containerName(threadKey));
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    headers: { Authorization: `Bearer ${token}` },
  };
}

async function remove(threadKey: string): Promise<void> {
  const name = containerName(threadKey);
  // Resolve the volume name from the persisted record before clearing it.
  // Falls back to the derived name (volumeName(threadKey)) so a /delete on
  // a thread whose record was written before this change still nukes its
  // legacy volume — AND so we still nuke the volume when the session.json
  // has already been deleted by a racing deleteThreadData call (handler.ts
  // runs deleteThreadData and removeContainer in Promise.all).
  const persisted = await loadSandbox(threadKey);
  const vol =
    persisted?.provider === 'docker'
      ? (persisted.volume_name ?? volumeName(threadKey))
      : volumeName(threadKey);
  tokens.delete(threadKey);
  await clearSandbox(threadKey).catch((err) => {
    log.warn('sandbox', `remove: clearSandbox(${threadKey}) failed: ${(err as Error).message}`);
  });
  const res = await dockerSpawn(['rm', '-fv', name]);
  if (res.exitCode !== 0 && !/No such container/i.test(res.stderr)) {
    log.warn('sandbox', `docker rm ${name}: ${res.stderr.trim()}`);
  } else if (res.exitCode === 0) {
    log.info('sandbox', `container ${name} removed`);
  }
  if (vol) {
    await removeVolume(vol);
  }
}

async function killAll(): Promise<void> {
  const list = await dockerSpawn(['ps', '-aq', '--filter', `name=^${CONTAINER_PREFIX}`]);
  if (list.exitCode !== 0) {
    log.warn('sandbox', `killAll: list failed: ${list.stderr.trim()}`);
    return;
  }
  const ids = list.stdout.trim().split('\n').filter(Boolean);
  if (ids.length > 0) {
    const rm = await dockerSpawn(['rm', '-fv', ...ids]);
    if (rm.exitCode !== 0) {
      log.warn('sandbox', `killAll: rm failed: ${rm.stderr.trim()}`);
    } else {
      log.info('sandbox', `killed ${ids.length} sandbox container(s)`);
    }
  }

  // Sweep every agenta-vol-<*> volume on the host. Container removal had to
  // happen first since `volume rm` refuses to delete a volume in use.
  const volList = await dockerSpawn(['volume', 'ls', '-q', '--filter', `name=^${VOLUME_PREFIX}`]);
  if (volList.exitCode === 0) {
    const volIds = volList.stdout.trim().split('\n').filter(Boolean);
    if (volIds.length > 0) {
      const rmv = await dockerSpawn(['volume', 'rm', ...volIds]);
      if (rmv.exitCode !== 0) {
        log.warn('sandbox', `killAll: volume rm failed: ${rmv.stderr.trim()}`);
      } else {
        log.info('sandbox', `killed ${volIds.length} sandbox volume(s)`);
      }
    }
  }

  tokens.clear();
  await sweepAllSandboxes();
}

// Destroy by container OR volume name (the same id `listAll` returns). The
// orphan reap mixes both kinds. We try container removal first; if it
// reports "no such container" we fall back to volume removal so a stray
// volume isn't left behind.
async function destroyById(id: string): Promise<void> {
  const res = await dockerSpawn(['rm', '-fv', id]);
  if (res.exitCode === 0) return;
  if (/No such container/i.test(res.stderr)) {
    if (id.startsWith(VOLUME_PREFIX)) {
      await removeVolume(id);
      return;
    }
    return;
  }
  log.warn('sandbox', `destroyById ${id}: ${res.stderr.trim()}`);
}

// Returns the container names AND volume names of every sandbox this host
// owns. The orphan reap walks both: a volume without a matching session
// record is just as much an orphan as a container without one.
async function listAll(): Promise<Array<{ id: string }>> {
  const out: Array<{ id: string }> = [];
  const list = await dockerSpawn([
    'ps',
    '-a',
    '--filter',
    `name=^${CONTAINER_PREFIX}`,
    '--format',
    '{{.Names}}',
  ]);
  if (list.exitCode !== 0) {
    log.warn('sandbox', `listAll: ps failed: ${list.stderr.trim()}`);
  } else {
    for (const id of list.stdout.trim().split('\n').filter(Boolean)) {
      out.push({ id });
    }
  }
  const volList = await dockerSpawn(['volume', 'ls', '-q', '--filter', `name=^${VOLUME_PREFIX}`]);
  if (volList.exitCode !== 0) {
    log.warn('sandbox', `listAll: volume ls failed: ${volList.stderr.trim()}`);
  } else {
    for (const id of volList.stdout.trim().split('\n').filter(Boolean)) {
      out.push({ id });
    }
  }
  return out;
}

function isReady(threadKey: string): boolean {
  return tokens.has(threadKey);
}

export const dockerProvider: SandboxProvider = {
  name: 'docker',
  ensure: ensureContainer,
  isReady,
  getEndpoint,
  remove,
  killAll,
  listAll,
  destroyById,
};

// For tests.
export function _resetImageReadyCache(): void {
  imageReady = undefined;
  networkReady = undefined;
  tokens.clear();
}
