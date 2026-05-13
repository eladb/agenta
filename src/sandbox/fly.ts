import { log } from '../log';
import { clearSandbox, loadSandbox, saveSandbox, sweepAllSandboxes } from './persistence';
import type { SandboxEndpoint, SandboxProvider } from './provider';

// Fly Machines API base. We don't use flyctl from the bot — too slow, and
// we'd want to keep the bot self-contained. Plain HTTPS works.
const FLY_API = 'https://api.machines.dev/v1';
const MACHINE_PREFIX = 'agenta-';
const VOLUME_PREFIX = 'agenta-vol-';
// Per-thread persistent volume size. 1 GB is the Fly minimum (anything
// smaller is rejected by the API). Code workloads sit well under this; if a
// user hits the cap they can /delete + restart, and we can revisit the size
// per thread later (spec out-of-scope).
const VOLUME_SIZE_GB = 1;

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

// Volume names follow the same constraints as machine names (Fly: lowercase
// alphanumeric + underscores, no hyphens for volumes; bot uses underscores
// in the prefix so we don't get rejected). Reserve room for the prefix.
function volumeNameFor(threadKey: string): string {
  const slug = threadKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  // Volumes also have a length cap (~30 chars). Trim aggressively.
  const trimmed = slug.slice(0, 22);
  return `agenta_vol_${trimmed}`;
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

type MachineSummary = { id: string; name: string; state: string; region?: string };
type FlyVolume = { id: string; name: string; region: string; state?: string };
type SandboxState = { machineId: string; token: string; volumeId?: string };
const state = new Map<string, SandboxState>();

async function machineByName(name: string): Promise<MachineSummary | undefined> {
  const res = await flyFetch('GET', `/apps/${appName()}/machines`);
  if (!res.ok) return undefined;
  const list = (await res.json()) as MachineSummary[];
  return list.find((m) => m.name === name);
}

// Fly volumes must live in the same region as the machine that mounts them.
// Source of truth: FLY_REGION env if set, otherwise the app's primary
// region via GET /v1/apps/<app>. Cached per process.
let cachedRegion: string | undefined;
async function resolveRegion(): Promise<string> {
  if (process.env.FLY_REGION) return process.env.FLY_REGION;
  if (cachedRegion) return cachedRegion;
  const res = await flyFetch('GET', `/apps/${appName()}`);
  if (!res.ok) {
    throw new Error(`fly: GET /apps/${appName()} failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { primary_region?: string; PrimaryRegion?: string };
  const region = body.primary_region ?? body.PrimaryRegion;
  if (!region) {
    throw new Error(`fly: app ${appName()} has no primary_region; set FLY_REGION`);
  }
  cachedRegion = region;
  return region;
}

async function listVolumes(): Promise<FlyVolume[]> {
  const res = await flyFetch('GET', `/apps/${appName()}/volumes`);
  if (!res.ok) {
    log.warn('sandbox', `fly listVolumes: ${res.status}`);
    return [];
  }
  return (await res.json()) as FlyVolume[];
}

async function volumeById(id: string): Promise<FlyVolume | undefined> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 3_000);
  try {
    const res = await fetch(`${FLY_API}/apps/${appName()}/volumes/${id}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token()}` },
      signal: ac.signal,
    });
    if (!res.ok) return undefined;
    return (await res.json()) as FlyVolume;
  } catch {
    return undefined;
  } finally {
    clearTimeout(t);
  }
}

async function createVolume(threadKey: string, region: string): Promise<FlyVolume> {
  const body = {
    name: volumeNameFor(threadKey),
    region,
    size_gb: VOLUME_SIZE_GB,
  };
  const res = await flyFetch('POST', `/apps/${appName()}/volumes`, body);
  if (!res.ok) {
    throw new Error(`fly create volume failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as FlyVolume;
}

async function destroyVolume(id: string): Promise<void> {
  const res = await flyFetch('DELETE', `/apps/${appName()}/volumes/${id}`);
  if (!res.ok) {
    log.warn('sandbox', `fly destroy volume ${id}: ${res.status} ${await res.text()}`);
  }
}

function machineConfig(
  sandboxToken: string,
  region: string,
  volumeId: string,
): Record<string, unknown> {
  return {
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
    // Attach the per-thread volume at the workspace mount point.
    mounts: [{ volume: volumeId, path: '/home/sandbox' }],
    region,
  };
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

// Liveness check for a persisted record. Returns true iff the machine
// exists and is in the 'started' state. ~3s timeout to match the Docker
// path.
async function verifyAlive(machineId: string): Promise<boolean> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 3_000);
  try {
    const res = await fetch(`${FLY_API}/apps/${appName()}/machines/${machineId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token()}` },
      signal: ac.signal,
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { state?: string };
    return body.state === 'started';
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function ensure(threadKey: string): Promise<void> {
  if (state.has(threadKey)) return;
  const name = machineName(threadKey);

  // Re-hydration path: in-memory cache is empty but disk may carry a record
  // from a previous bot process. Three sub-cases:
  //   - same-provider, live machine → adopt it.
  //   - same-provider, dead machine, **live volume** → create a fresh
  //     machine attached to the existing volume. Workspace state survives.
  //   - cross-provider or fully-missing → clear and provision from scratch.
  const persisted = await loadSandbox(threadKey);
  if (persisted) {
    if (persisted.provider !== 'fly') {
      log.warn(
        'sandbox',
        `[${threadKey}] persisted sandbox is ${persisted.provider}; SANDBOX_PROVIDER=fly — ignoring`,
      );
      await clearSandbox(threadKey);
    } else if (await verifyAlive(persisted.machine_id)) {
      state.set(threadKey, {
        machineId: persisted.machine_id,
        token: persisted.token,
        ...(persisted.volume_id ? { volumeId: persisted.volume_id } : {}),
      });
      log.info('sandbox', `re-hydrated fly machine ${persisted.machine_id} from session.json`);
      return;
    } else if (persisted.volume_id) {
      const vol = await volumeById(persisted.volume_id);
      if (vol) {
        log.info(
          'sandbox',
          `[${threadKey}] persisted machine ${persisted.machine_id} dead; reattaching to volume ${persisted.volume_id}`,
        );
        // Tear down the stale machine record (best-effort) before creating
        // the replacement so the machine-by-name lookup below stays clean.
        await flyFetch(
          'DELETE',
          `/apps/${appName()}/machines/${persisted.machine_id}?force=true`,
        ).catch(() => {});
        const existing = await machineByName(name);
        if (existing) {
          await flyFetch('DELETE', `/apps/${appName()}/machines/${existing.id}?force=true`).catch(
            () => {},
          );
        }
        const sandboxToken = persisted.token;
        const create = await flyFetch('POST', `/apps/${appName()}/machines`, {
          name,
          config: machineConfig(sandboxToken, vol.region, persisted.volume_id),
        });
        if (!create.ok) {
          throw new Error(
            `fly create machine (reattach) failed: ${create.status} ${await create.text()}`,
          );
        }
        const machine = (await create.json()) as { id: string };
        state.set(threadKey, {
          machineId: machine.id,
          token: sandboxToken,
          volumeId: persisted.volume_id,
        });
        await saveSandbox(threadKey, {
          provider: 'fly',
          machine_id: machine.id,
          token: sandboxToken,
          volume_id: persisted.volume_id,
        });
        await waitForHealth(machine.id);
        log.info(
          'sandbox',
          `fly machine ${name} (${machine.id}) ready — reattached volume ${persisted.volume_id}`,
        );
        return;
      }
      log.info(
        'sandbox',
        `[${threadKey}] persisted machine ${persisted.machine_id} dead and volume ${persisted.volume_id} gone; re-provisioning`,
      );
      await clearSandbox(threadKey);
    } else {
      log.info(
        'sandbox',
        `[${threadKey}] persisted machine ${persisted.machine_id} not alive; re-provisioning`,
      );
      await clearSandbox(threadKey);
    }
  }

  // If a stale machine with the same name exists (from a previous run that
  // crashed without clearing in-memory state), destroy it before recreating
  // so we control the token.
  const existing = await machineByName(name);
  if (existing) {
    await flyFetch('DELETE', `/apps/${appName()}/machines/${existing.id}?force=true`).catch(
      () => {},
    );
  }

  const region = await resolveRegion();
  const vol = await createVolume(threadKey, region);
  const sandboxToken = randomToken();
  const create = await flyFetch('POST', `/apps/${appName()}/machines`, {
    name,
    config: machineConfig(sandboxToken, region, vol.id),
  });
  if (!create.ok) {
    // Best-effort: if machine creation failed, the newly-created volume is
    // useless; clean it up so the next attempt doesn't accumulate dead
    // volumes.
    await destroyVolume(vol.id).catch(() => {});
    throw new Error(`fly create machine failed: ${create.status} ${await create.text()}`);
  }
  const machine = (await create.json()) as { id: string };
  state.set(threadKey, { machineId: machine.id, token: sandboxToken, volumeId: vol.id });
  await saveSandbox(threadKey, {
    provider: 'fly',
    machine_id: machine.id,
    token: sandboxToken,
    volume_id: vol.id,
  });
  await waitForHealth(machine.id);
  log.info('sandbox', `fly machine ${name} (${machine.id}) ready (volume ${vol.id})`);
}

async function getEndpoint(threadKey: string): Promise<SandboxEndpoint> {
  let s = state.get(threadKey);
  if (!s) {
    // Lazy re-hydration: in-memory cache empty, but disk may carry a record.
    // If alive, adopt it; otherwise clear and throw so caller knows to
    // `ensure` first.
    const persisted = await loadSandbox(threadKey);
    if (persisted && persisted.provider === 'fly' && (await verifyAlive(persisted.machine_id))) {
      s = {
        machineId: persisted.machine_id,
        token: persisted.token,
        ...(persisted.volume_id ? { volumeId: persisted.volume_id } : {}),
      };
      state.set(threadKey, s);
      log.info('sandbox', `[${threadKey}] re-hydrated fly endpoint from session.json`);
    } else {
      if (persisted) await clearSandbox(threadKey);
      throw new Error(`sandbox not initialized for ${threadKey}`);
    }
  }
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
  // Resolve the volume id from the persisted record (more authoritative
  // than in-memory; in-memory may be empty after a bot restart).
  const persisted = await loadSandbox(threadKey);
  const persistedVolumeId = persisted?.provider === 'fly' ? persisted.volume_id : undefined;
  const s = state.get(threadKey);
  state.delete(threadKey);
  await clearSandbox(threadKey).catch((err) => {
    log.warn('sandbox', `remove: clearSandbox(${threadKey}) failed: ${(err as Error).message}`);
  });

  // Destroy the machine first (it holds a reference to the volume).
  if (s) {
    const res = await flyFetch('DELETE', `/apps/${appName()}/machines/${s.machineId}?force=true`);
    if (!res.ok) {
      log.warn('sandbox', `fly destroy machine ${s.machineId}: ${res.status} ${await res.text()}`);
    } else {
      log.info('sandbox', `fly machine ${s.machineId} destroyed`);
    }
  } else if (persisted?.provider === 'fly') {
    // No in-memory entry, but disk still pointed at a machine — try to
    // destroy it anyway.
    await flyFetch(
      'DELETE',
      `/apps/${appName()}/machines/${persisted.machine_id}?force=true`,
    ).catch(() => {});
  }

  const volumeId = s?.volumeId ?? persistedVolumeId;
  if (volumeId) {
    await destroyVolume(volumeId);
  }
}

async function killAll(): Promise<void> {
  const res = await flyFetch('GET', `/apps/${appName()}/machines`);
  if (res.ok) {
    const list = (await res.json()) as MachineSummary[];
    const ours = list.filter((m) => m.name.startsWith(MACHINE_PREFIX));
    for (const m of ours) {
      await flyFetch('DELETE', `/apps/${appName()}/machines/${m.id}?force=true`).catch(() => {});
    }
    if (ours.length > 0) log.info('sandbox', `fly: destroyed ${ours.length} machine(s)`);
  } else {
    log.warn('sandbox', `fly killAll: list machines failed: ${res.status}`);
  }

  // Volumes after machines: volume delete refuses while a machine still
  // references it.
  const vols = await listVolumes();
  const ours = vols.filter(
    (v) => v.name.startsWith(VOLUME_PREFIX) || v.name.startsWith('agenta_vol_'),
  );
  for (const v of ours) {
    await destroyVolume(v.id);
  }
  if (ours.length > 0) log.info('sandbox', `fly: destroyed ${ours.length} volume(s)`);

  state.clear();
  await sweepAllSandboxes();
}

async function listAll(): Promise<Array<{ id: string }>> {
  const out: Array<{ id: string }> = [];
  const res = await flyFetch('GET', `/apps/${appName()}/machines`);
  if (res.ok) {
    const list = (await res.json()) as MachineSummary[];
    for (const m of list) {
      if (m.name.startsWith(MACHINE_PREFIX)) out.push({ id: m.id });
    }
  } else {
    log.warn('sandbox', `fly listAll: ${res.status}`);
  }
  const vols = await listVolumes();
  for (const v of vols) {
    if (v.name.startsWith(VOLUME_PREFIX) || v.name.startsWith('agenta_vol_')) {
      out.push({ id: v.id });
    }
  }
  return out;
}

async function destroyById(id: string): Promise<void> {
  // Fly machine ids start with no fixed prefix; Fly volume ids are
  // prefixed `vol_`. Use that to dispatch.
  if (id.startsWith('vol_')) {
    await destroyVolume(id);
    return;
  }
  const res = await flyFetch('DELETE', `/apps/${appName()}/machines/${id}?force=true`);
  if (!res.ok) {
    log.warn('sandbox', `fly destroyById ${id}: ${res.status}`);
  }
}

function isReady(threadKey: string): boolean {
  return state.has(threadKey);
}

export const flyProvider: SandboxProvider = {
  name: 'fly',
  ensure,
  isReady,
  getEndpoint,
  remove,
  killAll,
  listAll,
  destroyById,
};

// For tests.
export function _resetFlyState(): void {
  state.clear();
  cachedRegion = undefined;
}
