import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { log } from '../log';

export const SANDBOX_IMAGE = 'agenta-sandbox:latest';
// Internal network — Docker enforces no external connectivity at the netfilter
// layer. Containers on this network reach loopback only; DNS for external
// names also fails (Docker's embedded resolver has no upstream).
export const SANDBOX_NETWORK = 'agenta-sandbox-net';

// Path to the Dockerfile, resolved relative to this source file so it works
// regardless of cwd. sandbox/Dockerfile lives at repo root.
const DOCKERFILE_DIR = join(import.meta.dir, '..', '..', 'sandbox');

// Docker container names must match [a-zA-Z0-9][a-zA-Z0-9_.-]*. thread_key
// already contains only [a-z0-9_], so simply prefixing is safe.
export function containerName(threadKey: string): string {
  return `agenta-${threadKey}`;
}

export type DockerResult = { stdout: string; stderr: string; exitCode: number };

type DockerSpawnOpts = { signal?: AbortSignal; stdin?: string };

function dockerSpawn(args: string[], opts: DockerSpawnOpts = {}): Promise<DockerResult> {
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
    log.info('sandbox', `creating internal network ${SANDBOX_NETWORK}…`);
    const create = await dockerSpawn([
      'network',
      'create',
      '--internal',
      '--driver',
      'bridge',
      SANDBOX_NETWORK,
    ]);
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

// Idempotent: starts an existing stopped container, or creates a fresh one
// with an anonymous volume mounted at /workspace and the internal sandbox
// network attached (no external connectivity).
export async function ensureContainer(threadKey: string): Promise<void> {
  await Promise.all([ensureImage(), ensureNetwork()]);
  const name = containerName(threadKey);
  const inspect = await dockerSpawn(['inspect', '-f', '{{.State.Status}}', name]);
  if (inspect.exitCode === 0) {
    const status = inspect.stdout.trim();
    if (status === 'running') return;
    const start = await dockerSpawn(['start', name]);
    if (start.exitCode !== 0) {
      throw new Error(`docker start ${name} failed: ${start.stderr || start.stdout}`);
    }
    return;
  }
  const run = await dockerSpawn([
    'run',
    '-d',
    '--name',
    name,
    '--network',
    SANDBOX_NETWORK,
    '-w',
    '/workspace',
    '--mount',
    'type=volume,target=/workspace',
    SANDBOX_IMAGE,
    'sleep',
    'infinity',
  ]);
  if (run.exitCode !== 0) {
    throw new Error(`docker run ${name} failed: ${run.stderr || run.stdout}`);
  }
  log.info('sandbox', `container ${name} created`);
}

export async function runBash(
  threadKey: string,
  command: string,
  signal?: AbortSignal,
): Promise<DockerResult> {
  const name = containerName(threadKey);
  return dockerSpawn(['exec', name, 'bash', '-lc', command], { signal });
}

export async function readFile(
  threadKey: string,
  path: string,
  signal?: AbortSignal,
): Promise<DockerResult> {
  const name = containerName(threadKey);
  return dockerSpawn(['exec', '-w', '/workspace', name, 'cat', '--', path], { signal });
}

export async function writeFile(
  threadKey: string,
  path: string,
  content: string,
  signal?: AbortSignal,
): Promise<DockerResult> {
  const name = containerName(threadKey);
  // `tee --` writes stdin to the file and also echoes to stdout. We redirect
  // stdout to /dev/null inside a bash -lc wrapper so the tool output stays
  // small. mkdir -p the parent directory first so writes to nested paths
  // don't surprise the model with ENOENT.
  const command = `mkdir -p "$(dirname -- "$1")" && tee -- "$1" >/dev/null`;
  return dockerSpawn(['exec', '-i', '-w', '/workspace', name, 'bash', '-lc', command, '_', path], {
    signal,
    stdin: content,
  });
}

// Removes the container *and* its anonymous volume (`-v`). Errors are
// swallowed because /delete is a best-effort cleanup.
export async function removeContainer(threadKey: string): Promise<void> {
  const name = containerName(threadKey);
  const res = await dockerSpawn(['rm', '-fv', name]);
  if (res.exitCode !== 0 && !/No such container/i.test(res.stderr)) {
    log.warn('sandbox', `docker rm ${name}: ${res.stderr.trim()}`);
  } else if (res.exitCode === 0) {
    log.info('sandbox', `container ${name} removed`);
  }
}

// For tests.
export function _resetImageReadyCache(): void {
  imageReady = undefined;
  networkReady = undefined;
}
