import { log } from '../log';
import { containerName, dockerProvider } from './docker';
import { flyProvider } from './fly';
import type { SandboxEndpoint, SandboxProvider } from './provider';

// Re-exported for tests / direct callers that need the docker-specific
// container name (e.g. e2e checking `docker inspect`).
export { containerName };

// Provider-neutral DockerResult — kept under the old name so the rest of
// the codebase doesn't need to learn a new word. Despite the name it has
// nothing to do with Docker; it's the response shape every sandbox
// endpoint returns.
export type DockerResult = { stdout: string; stderr: string; exitCode: number };

function selectProvider(): SandboxProvider {
  const name = (process.env.SANDBOX_PROVIDER ?? 'docker').toLowerCase();
  if (name === 'docker') return dockerProvider;
  if (name === 'fly') return flyProvider;
  throw new Error(`unknown SANDBOX_PROVIDER: ${name} (expected docker | fly)`);
}

// Resolved once at module load. Tests that want to swap providers can do
// it by setting SANDBOX_PROVIDER before importing this module.
const provider: SandboxProvider = selectProvider();
log.info('sandbox', `provider: ${provider.name}`);

// Lifecycle re-exports — names match the old module's exports so callers
// (handler.ts, index.ts) don't change.
export async function ensureContainer(threadKey: string): Promise<void> {
  return provider.ensure(threadKey);
}
export function isSandboxReady(threadKey: string): boolean {
  return provider.isReady(threadKey);
}
export async function removeContainer(threadKey: string): Promise<void> {
  return provider.remove(threadKey);
}
export async function killAllSandboxContainers(): Promise<void> {
  return provider.killAll();
}

async function endpoint(threadKey: string): Promise<SandboxEndpoint> {
  return provider.getEndpoint(threadKey);
}

// Parse an SSE stream of `data: <json>\n\n` events emitted by /exec.
// onChunk fires per stdout/stderr event so callers can stream output (e.g.
// the Slack checklist preview) while the command runs. Exported for unit
// testing — every bash tool call goes through here.
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

async function postJson(
  threadKey: string,
  path: string,
  body: object,
  signal?: AbortSignal,
): Promise<DockerResult> {
  const ep = await endpoint(threadKey);
  const res = await fetch(`${ep.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ep.headers },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    return { stdout: '', stderr: `sandbox HTTP ${res.status}`, exitCode: -1 };
  }
  return (await res.json()) as DockerResult;
}

export async function runBash(
  threadKey: string,
  command: string,
  signal?: AbortSignal,
  onChunk?: (kind: 'stdout' | 'stderr', chunk: string) => void,
): Promise<DockerResult> {
  const ep = await endpoint(threadKey);
  const res = await fetch(`${ep.baseUrl}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ep.headers },
    body: JSON.stringify({ command }),
    signal,
  });
  if (!res.ok) {
    return { stdout: '', stderr: `sandbox HTTP ${res.status}`, exitCode: -1 };
  }
  if (!res.body) throw new Error('sandbox /exec returned no body');
  return consumeExecStream(res.body, onChunk);
}

export async function readFile(
  threadKey: string,
  path: string,
  opts: { offset?: number; limit?: number } = {},
  signal?: AbortSignal,
): Promise<DockerResult> {
  return postJson(threadKey, '/read', { path, ...opts }, signal);
}

export async function readBinary(
  threadKey: string,
  path: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  const res = await postJson(threadKey, '/read_binary', { path }, signal);
  if (res.exitCode !== 0) {
    throw new Error(res.stderr || res.stdout || `read_binary exited ${res.exitCode}`);
  }
  return Buffer.from(res.stdout, 'base64');
}

export async function writeFile(
  threadKey: string,
  path: string,
  content: string,
  signal?: AbortSignal,
): Promise<DockerResult> {
  return postJson(threadKey, '/write', { path, content }, signal);
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
