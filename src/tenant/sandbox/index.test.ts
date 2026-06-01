import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSession } from '../runtime/session-store';
import { _resetImageReadyCache, dockerProvider } from './docker';
import { _resetFlyState, flyProvider } from './fly';
import { containerName, reapOrphanSandboxes } from './index';

// reapOrphanSandboxes is provider-agnostic: it asks `provider.listAll`,
// cross-references with `listSessions`, and calls `provider.destroyById`
// on the leftovers. We monkey-patch BOTH provider objects (whichever one
// `selectProvider` returned at module-load time is the live one) so the
// test works regardless of SANDBOX_PROVIDER.

type ListAllFn = typeof dockerProvider.listAll;
type DestroyByIdFn = typeof dockerProvider.destroyById;

const origDockerListAll: ListAllFn = dockerProvider.listAll;
const origDockerDestroy: DestroyByIdFn = dockerProvider.destroyById;
const origFlyListAll: ListAllFn = flyProvider.listAll;
const origFlyDestroy: DestroyByIdFn = flyProvider.destroyById;

let dataDir: string;

function patchProviders(args: {
  listAll: () => Promise<Array<{ id: string }>>;
  destroyById: (id: string) => Promise<void>;
}): void {
  (dockerProvider as { listAll: ListAllFn }).listAll = args.listAll;
  (flyProvider as { listAll: ListAllFn }).listAll = args.listAll;
  (dockerProvider as { destroyById: DestroyByIdFn }).destroyById = args.destroyById;
  (flyProvider as { destroyById: DestroyByIdFn }).destroyById = args.destroyById;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'agenta-reap-'));
  process.env.AGENTA_DATA_DIR = dataDir;
  _resetImageReadyCache();
  _resetFlyState();
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.AGENTA_DATA_DIR;
  (dockerProvider as { listAll: ListAllFn }).listAll = origDockerListAll;
  (dockerProvider as { destroyById: DestroyByIdFn }).destroyById = origDockerDestroy;
  (flyProvider as { listAll: ListAllFn }).listAll = origFlyListAll;
  (flyProvider as { destroyById: DestroyByIdFn }).destroyById = origFlyDestroy;
  _resetImageReadyCache();
  _resetFlyState();
});

describe('reapOrphanSandboxes', () => {
  test('destroys provider-owned sandboxes with no matching session record', async () => {
    // Provider-owned: three sandboxes. We'll claim two have backing sessions.
    const tk1 = 'C1__1700000000_000001';
    const tk2 = 'C1__1700000000_000002';
    await writeSession(tk1, {
      status: 'idle',
      updated_at: 't',
      sandbox: { provider: 'docker', container_name: containerName(tk1), token: 't1' },
    });
    await writeSession(tk2, {
      status: 'idle',
      updated_at: 't',
      sandbox: { provider: 'fly', machine_id: 'machine-alive', token: 't2' },
    });

    const destroyed: string[] = [];
    patchProviders({
      listAll: async () => [
        // matches docker session above
        { id: containerName(tk1) },
        // matches fly session above
        { id: 'machine-alive' },
        // no match → orphan
        { id: 'agenta-orphan-1' },
        { id: 'machine-orphan' },
      ],
      destroyById: async (id) => {
        destroyed.push(id);
      },
    });

    await reapOrphanSandboxes();
    expect(destroyed.sort()).toEqual(['agenta-orphan-1', 'machine-orphan']);
  });

  test('no-op when provider has nothing to list', async () => {
    let destroys = 0;
    patchProviders({
      listAll: async () => [],
      destroyById: async () => {
        destroys += 1;
      },
    });
    await reapOrphanSandboxes();
    expect(destroys).toBe(0);
  });

  test('no-op when every owned sandbox has a session record', async () => {
    const tk = 'C1__1700000000_000099';
    await writeSession(tk, {
      status: 'idle',
      updated_at: 't',
      sandbox: { provider: 'docker', container_name: containerName(tk), token: 't' },
    });
    let destroys = 0;
    patchProviders({
      listAll: async () => [{ id: containerName(tk) }],
      destroyById: async () => {
        destroys += 1;
      },
    });
    await reapOrphanSandboxes();
    expect(destroys).toBe(0);
  });

  test('treats a session whose docker container_name does not match its threadKey as orphan-side', async () => {
    // Defensive: even with a session record, if the container_name doesn't
    // map to that threadKey we don't claim ownership over the live sandbox
    // — the reap will destroy it. Protects against renames / drift.
    const tk = 'C1__1700000000_000111';
    await writeSession(tk, {
      status: 'idle',
      updated_at: 't',
      sandbox: { provider: 'docker', container_name: 'agenta-other', token: 't' },
    });
    const destroyed: string[] = [];
    patchProviders({
      listAll: async () => [{ id: containerName(tk) }],
      destroyById: async (id) => {
        destroyed.push(id);
      },
    });
    await reapOrphanSandboxes();
    expect(destroyed).toEqual([containerName(tk)]);
  });

  test('survives a destroyById error on one orphan and keeps going', async () => {
    const destroyed: string[] = [];
    patchProviders({
      listAll: async () => [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      destroyById: async (id) => {
        if (id === 'b') throw new Error('boom');
        destroyed.push(id);
      },
    });
    await reapOrphanSandboxes();
    expect(destroyed).toEqual(['a', 'c']);
  });
});
