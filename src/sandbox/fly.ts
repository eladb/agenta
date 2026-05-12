import { log } from '../log';
import type { SandboxEndpoint, SandboxProvider } from './provider';

// Fly Machines API base. We don't use flyctl from the bot — too slow, and
// we'd want to keep the bot self-contained. Plain HTTPS works.
const FLY_API = 'https://api.machines.dev/v1';
const MACHINE_PREFIX = 'agenta-';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`SANDBOX_PROVIDER=fly requires env var ${name}`);
  return v;
}

function token(): string {
  return requireEnv('FLY_API_TOKEN');
}
function appName(): string {
  return requireEnv('FLY_APP_NAME');
}

// Fly machine names are constrained: lowercase, alphanumeric + hyphens,
// 30 chars max. thread_key contains uppercase Slack channel IDs and
// underscores, so we have to normalize.
function machineName(threadKey: string): string {
  const slug = threadKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // Reserve 8 chars for the prefix.
  const trimmed = slug.slice(0, 22);
  return `${MACHINE_PREFIX}${trimmed}`;
}

function randomToken(): string {
  return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
}

async function flyFetch(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${FLY_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      'Content-Type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

type MachineSummary = { id: string; name: string; state: string };
type SandboxState = { machineId: string; token: string };
const state = new Map<string, SandboxState>();

async function machineByName(name: string): Promise<MachineSummary | undefined> {
  const res = await flyFetch('GET', `/apps/${appName()}/machines`);
  if (!res.ok) return undefined;
  const list = (await res.json()) as MachineSummary[];
  return list.find((m) => m.name === name);
}

async function waitForHealth(machineId: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`https://${appName()}.fly.dev/health`, {
        headers: { 'fly-force-instance-id': machineId },
      });
      if (res.status === 200) return;
      lastErr = `status ${res.status}`;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`fly sandbox not healthy after ${timeoutMs}ms: ${String(lastErr)}`);
}

async function ensure(threadKey: string): Promise<void> {
  if (state.has(threadKey)) return;
  const name = machineName(threadKey);
  // If a stale machine with the same name exists (from a previous run that
  // crashed without clearing in-memory state), destroy it before recreating
  // so we control the token.
  const existing = await machineByName(name);
  if (existing) {
    await flyFetch('DELETE', `/apps/${appName()}/machines/${existing.id}?force=true`).catch(
      () => {},
    );
  }

  const sandboxToken = randomToken();
  const body = {
    name,
    config: {
      image: `registry.fly.io/${appName()}:latest`,
      env: { SANDBOX_TOKEN: sandboxToken },
      guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 1024 },
      services: [
        {
          protocol: 'tcp',
          internal_port: 9000,
          ports: [{ port: 443, handlers: ['tls', 'http'] }],
        },
      ],
    },
  };
  const create = await flyFetch('POST', `/apps/${appName()}/machines`, body);
  if (!create.ok) {
    throw new Error(`fly create machine failed: ${create.status} ${await create.text()}`);
  }
  const machine = (await create.json()) as { id: string };
  state.set(threadKey, { machineId: machine.id, token: sandboxToken });
  await waitForHealth(machine.id);
  log.info('sandbox', `fly machine ${name} (${machine.id}) ready`);
}

async function getEndpoint(threadKey: string): Promise<SandboxEndpoint> {
  const s = state.get(threadKey);
  if (!s) throw new Error(`sandbox not initialized for ${threadKey}`);
  return {
    baseUrl: `https://${appName()}.fly.dev`,
    headers: {
      Authorization: `Bearer ${s.token}`,
      // Routes the request to this specific machine. Without this Fly
      // round-robins across all machines in the app, which would land us on
      // the wrong sandbox.
      'fly-force-instance-id': s.machineId,
    },
  };
}

async function remove(threadKey: string): Promise<void> {
  const s = state.get(threadKey);
  if (!s) return;
  state.delete(threadKey);
  const res = await flyFetch('DELETE', `/apps/${appName()}/machines/${s.machineId}?force=true`);
  if (!res.ok) {
    log.warn('sandbox', `fly destroy machine ${s.machineId}: ${res.status} ${await res.text()}`);
  } else {
    log.info('sandbox', `fly machine ${s.machineId} destroyed`);
  }
}

async function killAll(): Promise<void> {
  const res = await flyFetch('GET', `/apps/${appName()}/machines`);
  if (!res.ok) {
    log.warn('sandbox', `fly killAll: list failed: ${res.status}`);
    return;
  }
  const list = (await res.json()) as MachineSummary[];
  const ours = list.filter((m) => m.name.startsWith(MACHINE_PREFIX));
  for (const m of ours) {
    await flyFetch('DELETE', `/apps/${appName()}/machines/${m.id}?force=true`).catch(() => {});
  }
  state.clear();
  if (ours.length > 0) log.info('sandbox', `fly: destroyed ${ours.length} machine(s)`);
}

export const flyProvider: SandboxProvider = {
  name: 'fly',
  ensure,
  getEndpoint,
  remove,
  killAll,
};

// For tests.
export function _resetFlyState(): void {
  state.clear();
}
