import { readFile as fsReadFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '../log';
import { attachmentsDir } from '../persistence/store';
import { listSessions } from '../runtime/session-store';
import { containerName, dockerProvider, volumeName } from './docker';
import { ecsProvider } from './ecs';
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
  if (name === 'ecs') return ecsProvider;
  throw new Error(`unknown SANDBOX_PROVIDER: ${name} (expected docker | fly | ecs)`);
}

// Resolved once at module load. Tests that want to swap providers can do
// it by setting SANDBOX_PROVIDER before importing this module.
const provider: SandboxProvider = selectProvider();
log.info('sandbox', `provider: ${provider.name}`);

// Per-thread in-flight ensure promise. The provider's own ensure() races
// when called concurrently (its in-memory "ready" flag is only set at the
// end of provisioning), so without this wrapper a background kickoff +
// foreground tool-call ensure would both try to provision and the second
// `docker run` / `POST /machines` would fail with a name conflict.
// We hold the promise so concurrent callers await the same operation.
const inFlightEnsure = new Map<string, Promise<void>>();

// Lifecycle re-exports — names match the old module's exports so callers
// (handler.ts, index.ts) don't change.
export async function ensureContainer(threadKey: string): Promise<void> {
  const existing = inFlightEnsure.get(threadKey);
  if (existing) return existing;
  const p = provider.ensure(threadKey).finally(() => {
    // Clear regardless of outcome so a failed attempt doesn't pin the
    // map entry; the next call retries from scratch.
    if (inFlightEnsure.get(threadKey) === p) inFlightEnsure.delete(threadKey);
  });
  inFlightEnsure.set(threadKey, p);
  return p;
}
// Fire-and-forget warmup: schedules ensureContainer in the background and
// swallows errors (a real foreground tool call will hit the same
// in-flight promise and observe the error there). Used by handler.ts to
// begin provisioning at session start so first-tool latency is hidden.
export function kickoffEnsureContainer(threadKey: string): void {
  ensureContainer(threadKey).catch((err) => {
    log.warn(
      'sandbox',
      `[${threadKey}] background ensureContainer failed: ${(err as Error).message}`,
    );
  });
}
export function isSandboxReady(threadKey: string): boolean {
  return provider.isReady(threadKey);
}
export async function removeContainer(threadKey: string): Promise<void> {
  syncedAttachments.delete(threadKey);
  inFlightEnsure.delete(threadKey);
  return provider.remove(threadKey);
}
export async function killAllSandboxContainers(): Promise<void> {
  syncedAttachments.clear();
  inFlightEnsure.clear();
  return provider.killAll();
}

// Boot-time orphan reap: destroy provider-owned sandboxes with no matching
// session.json record. Replaces the old boot-time killAll — sandboxes now
// survive bot restart and are reattached on demand. This sweep only fires
// when something has gone wrong outside the normal `/delete` flow (e.g.
// `rm -rf data/` without going through the bot). Errors logged, not thrown.
//
// The sweep walks both layers — containers/machines AND volumes — because
// each is owned independently and either can survive without the other.
// A volume with no owning session is just as much an orphan as a container.
export async function reapOrphanSandboxes(): Promise<void> {
  let owned: Array<{ id: string }>;
  try {
    owned = await provider.listAll();
  } catch (err) {
    log.warn('sandbox', `reap: listAll failed: ${(err as Error).message}`);
    return;
  }
  if (owned.length === 0) return;
  const sessions = await listSessions();
  // For docker the provider's id is either the container name
  // (agenta-<threadKey>) or the volume name (agenta-vol-<threadKey>); we
  // expect a session whose record cites that id directly. For fly it's the
  // machine id or the volume id, both stored on the session record.
  const live = new Set<string>();
  for (const { threadKey, state } of sessions) {
    const sb = state.sandbox;
    if (!sb) continue;
    if (sb.provider === 'docker') {
      if (sb.container_name === containerName(threadKey)) live.add(sb.container_name);
      const vol = sb.volume_name ?? volumeName(threadKey);
      live.add(vol);
    } else if (sb.provider === 'fly') {
      live.add(sb.machine_id);
      if (sb.volume_id) live.add(sb.volume_id);
    } else if (sb.provider === 'ecs') {
      live.add(sb.task_arn);
      live.add(sb.access_point_id);
    }
  }
  const orphans = owned.filter((o) => !live.has(o.id));
  if (orphans.length === 0) return;
  log.info('sandbox', `reap: destroying ${orphans.length} orphan sandbox(es)`);
  for (const o of orphans) {
    try {
      await provider.destroyById(o.id);
    } catch (err) {
      log.warn('sandbox', `reap: destroying ${o.id} failed: ${(err as Error).message}`);
    }
  }
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

export async function writeBinary(
  threadKey: string,
  path: string,
  data: Buffer,
  signal?: AbortSignal,
): Promise<DockerResult> {
  return postJson(
    threadKey,
    '/write_binary',
    { path, content_b64: data.toString('base64') },
    signal,
  );
}

// Per-thread set of attachment basenames already pushed into the sandbox in
// this process. Reset on container removal / killAll: a fresh sandbox starts
// without these mirrored files (the volume may already have them from a
// previous turn, but the per-process map is cleared so we re-emit them as
// idempotent writes when the in-memory state was lost).
const syncedAttachments = new Map<string, Set<string>>();

// Push every file under data/{threadKey}/attachments/ into the sandbox at
// attachments/<basename> (relative to the workspace = /home/sandbox),
// skipping files already synced in this process. Called lazily on the first
// sandbox-touching tool call per turn (after ensureContainer). Idempotent
// and safe to re-call.
export async function syncAttachmentsToSandbox(threadKey: string): Promise<{ synced: number }> {
  const dir = attachmentsDir(threadKey);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // No attachments dir → nothing to sync.
    return { synced: 0 };
  }
  let done = syncedAttachments.get(threadKey);
  if (!done) {
    done = new Set<string>();
    syncedAttachments.set(threadKey, done);
  }
  let count = 0;
  for (const name of entries) {
    if (done.has(name)) continue;
    const localPath = join(dir, name);
    let data: Buffer;
    try {
      data = await fsReadFile(localPath);
    } catch (err) {
      log.warn('sandbox', `syncAttachments: read ${localPath} failed`, err);
      continue;
    }
    const res = await writeBinary(threadKey, `attachments/${name}`, data);
    if (res.exitCode !== 0) {
      log.warn('sandbox', `syncAttachments: write_binary ${name} failed: ${res.stderr}`);
      continue;
    }
    done.add(name);
    count += 1;
  }
  return { synced: count };
}

// For tests.
export function _resetSyncedAttachments(): void {
  syncedAttachments.clear();
}
