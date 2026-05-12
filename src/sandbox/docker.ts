import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { log } from '../log';

export const SANDBOX_IMAGE = 'agenta-sandbox:latest';
export const SANDBOX_NETWORK = 'agenta-sandbox-net';
const SANDBOX_PORT = 9000;
const CONTAINER_PREFIX = 'agenta-';

const DOCKERFILE_DIR = join(import.meta.dir, '..', '..', 'sandbox');

export function containerName(threadKey: string): string {
  return `${CONTAINER_PREFIX}${threadKey}`;
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
    // TODO(egress-block): we previously used `--internal` which blocks all
    // external connectivity at the netfilter layer, but it also blocks port
    // publishing — and the bot now reaches the in-container HTTP server via
    // a published 127.0.0.1 port. Setting enable_ip_masquerade=false doesn't
    // actually block egress on Docker Desktop (VPNkit NATs at a different
    // layer). Re-add a real egress block via iptables OUTPUT rules inside
    // the container (needs --cap-add NET_ADMIN) in a follow-up.
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

// Bearer token per thread. Set by ensureContainer at create time; cleared by
// removeContainer / killAllSandboxContainers. The host port is NOT cached —
// Docker Desktop auto-restarts containers behind our back when their main
// process exits, and reassigns a new random host port on each restart. So we
// look up the live port via `docker port` on every call (~50ms).
const tokens = new Map<string, string>();

function randomToken(): string {
  return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
}

// Wait for GET /health to return 200. The sandbox-server binds to :9000
// inside the container; we poll the host-side mapped port until it answers.
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
  // Output is one or more lines like "0.0.0.0:54321" or "127.0.0.1:54321".
  // Prefer the 127.0.0.1 line; fall back to the first.
  const lines = res.stdout.trim().split('\n');
  const preferred = lines.find((l) => l.startsWith('127.0.0.1:')) ?? lines[0];
  if (!preferred) throw new Error(`docker port ${name} returned no mapping`);
  const port = Number(preferred.split(':').pop());
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`docker port ${name} parse error: ${preferred}`);
  }
  return port;
}

// Idempotent: creates a fresh container if missing (with a random Bearer
// token in env and a random 127.0.0.1 host port mapped to the server's
// :9000), then waits for the in-container server to be healthy.
export async function ensureContainer(threadKey: string): Promise<void> {
  await Promise.all([ensureImage(), ensureNetwork()]);
  const name = containerName(threadKey);

  if (tokens.has(threadKey)) {
    const inspect = await dockerSpawn(['inspect', '-f', '{{.State.Status}}', name]);
    if (inspect.exitCode === 0 && inspect.stdout.trim() === 'running') return;
    tokens.delete(threadKey);
  }

  // If the container exists from before but we have no cached token (e.g.
  // partial state), remove it and recreate so we control the token.
  const inspectStale = await dockerSpawn(['inspect', name]);
  if (inspectStale.exitCode === 0) {
    await dockerSpawn(['rm', '-fv', name]);
  }

  const token = randomToken();
  // Sandbox hardening:
  // - --cap-drop ALL drops every Linux capability...
  // - ...then --cap-add NET_ADMIN puts back just one, so the entrypoint can
  //   install iptables OUTPUT rules (defense-in-depth — a malicious shell
  //   command could still flush them; a follow-up should move egress block
  //   to a host-side DOCKER-USER chain).
  // - --security-opt no-new-privileges blocks setuid escalation.
  // - --pids-limit 256 contains fork bombs.
  // - --memory / --cpus cap resource consumption per thread.
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
    '--cap-drop',
    'ALL',
    '--cap-add',
    'NET_ADMIN',
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
  log.info('sandbox', `container ${name} ready on :${hostPort}`);
}

// Returns the live HTTP base URL + token to reach a thread's sandbox server.
// Re-reads the host port every call (Docker Desktop may have restarted the
// container behind us and reassigned it).
async function getEndpoint(threadKey: string): Promise<{ baseUrl: string; token: string }> {
  const token = tokens.get(threadKey);
  if (!token) throw new Error(`sandbox not initialized for ${threadKey}`);
  const port = await readHostPort(containerName(threadKey));
  return { baseUrl: `http://127.0.0.1:${port}`, token };
}

// Parse an SSE stream of `data: <json>\n\n` events emitted by /exec.
// onChunk, if provided, fires per stdout/stderr event so callers can stream
// the output somewhere (e.g. the Slack checklist) while the command runs.
// Exported for unit testing — every bash tool call goes through here, so a
// regression here would silently corrupt all tool output.
export async function consumeExecStream(
  body: ReadableStream<Uint8Array>,
  onChunk?: (kind: 'stdout' | 'stderr', chunk: string) => void,
): Promise<DockerResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let stdout = '';
  let stderr = '';
  let exitCode = -1;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep = buffer.indexOf('\n\n');
    while (sep >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);
        try {
          const evt = JSON.parse(payload) as {
            kind: 'stdout' | 'stderr' | 'exit';
            chunk?: string;
            exitCode?: number;
          };
          if (evt.kind === 'stdout' && typeof evt.chunk === 'string') {
            stdout += evt.chunk;
            onChunk?.('stdout', evt.chunk);
          } else if (evt.kind === 'stderr' && typeof evt.chunk === 'string') {
            stderr += evt.chunk;
            onChunk?.('stderr', evt.chunk);
          } else if (evt.kind === 'exit' && typeof evt.exitCode === 'number') {
            exitCode = evt.exitCode;
          }
        } catch {
          // ignore malformed frames
        }
      }
      sep = buffer.indexOf('\n\n');
    }
  }
  return { stdout, stderr, exitCode };
}

export async function runBash(
  threadKey: string,
  command: string,
  signal?: AbortSignal,
  onChunk?: (kind: 'stdout' | 'stderr', chunk: string) => void,
): Promise<DockerResult> {
  const { baseUrl, token } = await getEndpoint(threadKey);
  const res = await fetch(`${baseUrl}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ command }),
    signal,
  });
  if (!res.ok) {
    return { stdout: '', stderr: `sandbox HTTP ${res.status}`, exitCode: -1 };
  }
  if (!res.body) throw new Error('sandbox /exec returned no body');
  return consumeExecStream(res.body, onChunk);
}

async function postJson(
  threadKey: string,
  endpoint: string,
  body: object,
  signal?: AbortSignal,
): Promise<DockerResult> {
  const { baseUrl, token } = await getEndpoint(threadKey);
  const res = await fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    return { stdout: '', stderr: `sandbox HTTP ${res.status}`, exitCode: -1 };
  }
  return (await res.json()) as DockerResult;
}

export async function readFile(
  threadKey: string,
  path: string,
  opts: { offset?: number; limit?: number } = {},
  signal?: AbortSignal,
): Promise<DockerResult> {
  return postJson(threadKey, '/read', { path, ...opts }, signal);
}

export async function editFile(
  threadKey: string,
  path: string,
  oldString: string,
  newString: string,
  signal?: AbortSignal,
): Promise<DockerResult> {
  return postJson(
    threadKey,
    '/edit',
    { path, old_string: oldString, new_string: newString },
    signal,
  );
}

export async function grep(
  threadKey: string,
  pattern: string,
  opts: { path?: string; glob?: string } = {},
  signal?: AbortSignal,
): Promise<DockerResult> {
  return postJson(threadKey, '/grep', { pattern, ...opts }, signal);
}

export async function glob(
  threadKey: string,
  pattern: string,
  opts: { path?: string } = {},
  signal?: AbortSignal,
): Promise<DockerResult> {
  return postJson(threadKey, '/glob', { pattern, ...opts }, signal);
}

export async function listDir(
  threadKey: string,
  path: string | undefined,
  signal?: AbortSignal,
): Promise<DockerResult> {
  return postJson(threadKey, '/ls', path ? { path } : {}, signal);
}

export async function writeFile(
  threadKey: string,
  path: string,
  content: string,
  signal?: AbortSignal,
): Promise<DockerResult> {
  return postJson(threadKey, '/write', { path, content }, signal);
}

export async function removeContainer(threadKey: string): Promise<void> {
  const name = containerName(threadKey);
  tokens.delete(threadKey);
  const res = await dockerSpawn(['rm', '-fv', name]);
  if (res.exitCode !== 0 && !/No such container/i.test(res.stderr)) {
    log.warn('sandbox', `docker rm ${name}: ${res.stderr.trim()}`);
  } else if (res.exitCode === 0) {
    log.info('sandbox', `container ${name} removed`);
  }
}

// Kill every agenta-* container. Called at bot startup so each run starts
// from a clean slate (we don't try to recover state from prior processes).
export async function killAllSandboxContainers(): Promise<void> {
  const list = await dockerSpawn(['ps', '-aq', '--filter', `name=^${CONTAINER_PREFIX}`]);
  if (list.exitCode !== 0) {
    log.warn('sandbox', `killAllSandboxContainers: list failed: ${list.stderr.trim()}`);
    return;
  }
  const ids = list.stdout.trim().split('\n').filter(Boolean);
  if (ids.length === 0) return;
  const rm = await dockerSpawn(['rm', '-fv', ...ids]);
  tokens.clear();
  if (rm.exitCode !== 0) {
    log.warn('sandbox', `killAllSandboxContainers: rm failed: ${rm.stderr.trim()}`);
  } else {
    log.info('sandbox', `killed ${ids.length} sandbox container(s)`);
  }
}

// For tests.
export function _resetImageReadyCache(): void {
  imageReady = undefined;
  networkReady = undefined;
  tokens.clear();
}
