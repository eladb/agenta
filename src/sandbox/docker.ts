import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { log } from '../log';
import { clearSandbox, loadSandbox, saveSandbox, sweepAllSandboxes } from './persistence';
import type { SandboxEndpoint, SandboxProvider } from './provider';

export const SANDBOX_IMAGE = 'agenta-sandbox:latest';
export const SANDBOX_NETWORK = 'agenta-sandbox-net';
const SANDBOX_PORT = 9000;
const CONTAINER_PREFIX = 'agenta-';

const DOCKERFILE_DIR = join(import.meta.dir, '..', '..', 'sandbox');

export function containerName(threadKey: string): string {
  return `${CONTAINER_PREFIX}${threadKey}`;
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

async function ensureContainer(threadKey: string): Promise<void> {
  await Promise.all([ensureImage(), ensureNetwork()]);
  const name = containerName(threadKey);

  if (tokens.has(threadKey)) {
    const inspect = await dockerSpawn(['inspect', '-f', '{{.State.Status}}', name]);
    if (inspect.exitCode === 0 && inspect.stdout.trim() === 'running') return;
    tokens.delete(threadKey);
  }

  // Re-hydration path: in-memory cache is empty, but disk may carry a record
  // from a previous bot process. If it's live, adopt it; if dead or
  // cross-provider, clear it and continue to provisioning.
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
    } else {
      log.info(
        'sandbox',
        `[${threadKey}] persisted container ${persisted.container_name} not alive; re-provisioning`,
      );
      await clearSandbox(threadKey);
    }
  }

  const inspectStale = await dockerSpawn(['inspect', name]);
  if (inspectStale.exitCode === 0) {
    await dockerSpawn(['rm', '-fv', name]);
  }

  const token = randomToken();
  const run = await dockerSpawn([
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
    '-w',
    '/workspace',
    '--mount',
    'type=volume,target=/workspace',
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
  ]);
  if (run.exitCode !== 0) {
    throw new Error(`docker run ${name} failed: ${run.stderr || run.stdout}`);
  }
  const hostPort = await readHostPort(name);
  await waitForHealth(hostPort);
  tokens.set(threadKey, token);
  await saveSandbox(threadKey, { provider: 'docker', container_name: name, token });
  log.info('sandbox', `container ${name} ready on :${hostPort}`);
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
}

async function killAll(): Promise<void> {
  const list = await dockerSpawn(['ps', '-aq', '--filter', `name=^${CONTAINER_PREFIX}`]);
  if (list.exitCode !== 0) {
    log.warn('sandbox', `killAll: list failed: ${list.stderr.trim()}`);
    return;
  }
  const ids = list.stdout.trim().split('\n').filter(Boolean);
  if (ids.length === 0) {
    tokens.clear();
    await sweepAllSandboxes();
    return;
  }
  const rm = await dockerSpawn(['rm', '-fv', ...ids]);
  tokens.clear();
  await sweepAllSandboxes();
  if (rm.exitCode !== 0) {
    log.warn('sandbox', `killAll: rm failed: ${rm.stderr.trim()}`);
  } else {
    log.info('sandbox', `killed ${ids.length} sandbox container(s)`);
  }
}

// Destroy by container name (the same id `listAll` returns). Best-effort.
async function destroyById(id: string): Promise<void> {
  const res = await dockerSpawn(['rm', '-fv', id]);
  if (res.exitCode !== 0 && !/No such container/i.test(res.stderr)) {
    log.warn('sandbox', `destroyById ${id}: ${res.stderr.trim()}`);
  }
}

// Returns the container names of every running-or-stopped sandbox container
// this host owns (filter is identical to killAll). Used by the orphan reap.
async function listAll(): Promise<Array<{ id: string }>> {
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
    return [];
  }
  return list.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((id) => ({ id }));
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
