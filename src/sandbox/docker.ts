import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { log } from '../log';

export const SANDBOX_IMAGE = 'agenta-sandbox:latest';

// Path to the Dockerfile, resolved relative to this source file so it works
// regardless of cwd. sandbox/Dockerfile lives at repo root.
const DOCKERFILE_DIR = join(import.meta.dir, '..', '..', 'sandbox');

// Docker container names must match [a-zA-Z0-9][a-zA-Z0-9_.-]*. thread_key
// already contains only [a-z0-9_], so simply prefixing is safe.
export function containerName(threadKey: string): string {
  return `agenta-${threadKey}`;
}

export type DockerResult = { stdout: string; stderr: string; exitCode: number };

function dockerSpawn(args: string[], signal?: AbortSignal): Promise<DockerResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
    if (signal) {
      const onAbort = (): void => {
        proc.kill('SIGTERM');
      };
      signal.addEventListener('abort', onAbort);
      proc.on('close', () => signal.removeEventListener('abort', onAbort));
    }
  });
}

let imageReady: Promise<void> | undefined;

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
  // Clear the cache on failure so the next call can retry (e.g. user starts
  // Docker Desktop after an initial failure).
  p.catch(() => {
    if (imageReady === p) imageReady = undefined;
  });
  imageReady = p;
  return p;
}

// Idempotent: starts an existing stopped container, or creates a fresh one
// with an anonymous volume mounted at /workspace. Container is named
// containerName(threadKey).
export async function ensureContainer(threadKey: string): Promise<void> {
  await ensureImage();
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
  return dockerSpawn(['exec', name, 'bash', '-lc', command], signal);
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
}
