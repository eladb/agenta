import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSession, writeSession } from '../runtime/session-store';
import { _resetEcsState, _slugFor, _workspacePathFor, ecsProvider } from './ecs';

// Test harness:
//   - A throwaway dir is prepended to PATH containing a shim `aws`
//     bash script. The shim reads the script's args, dispatches to a
//     JSON file written via setRoutes(), and prints it on stdout.
//   - Each call also appends a recorded-call line to <scenario>/calls.log
//     so tests can assert which `aws` subcommands were run + with what
//     args, in order.
//   - globalThis.fetch is stubbed for /health probes (the only HTTP
//     call ecs.ts makes — every other side-effect goes through `aws`).

const ORIG_FETCH = globalThis.fetch;
const ORIG_PATH = process.env.PATH;

type FetchCall = { url: string; method: string };
type StubFetch = { calls: FetchCall[] };

function stubFetchHealthy(): StubFetch {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET' });
    if (url.endsWith('/health')) return new Response('ok', { status: 200 });
    return new Response('unexpected', { status: 500 });
  }) as unknown as typeof fetch;
  return { calls };
}

let shimDir: string;
let dataDir: string;
let scenarioDir: string;

type Route = {
  // Matched as: `${service} ${subcommand}` plus optional substring match.
  match: string;
  // Optional substring that must appear in JSON-stringified args (e.g.
  // a task ARN). Lets a test return different responses for the same
  // subcommand depending on which task is being described.
  contains?: string;
  // Response body (printed verbatim to stdout). If undefined, the shim
  // exits 0 with empty body — used for stop-task.
  stdout?: string;
  exit?: number;
};

const callLog: string[] = [];

function setRoutes(rs: Route[]): void {
  writeFileSync(join(scenarioDir, 'routes.json'), JSON.stringify(rs));
  callLog.length = 0;
  writeFileSync(join(scenarioDir, 'calls.log'), '');
}

function readCallLog(): string[] {
  const raw = readFileSync(join(scenarioDir, 'calls.log'), 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => l);
}

beforeEach(() => {
  process.env.AGENTA_ECS_SANDBOX_CLUSTER = 'agenta-sandbox';
  process.env.AGENTA_ECS_SANDBOX_SUBNET_IDS = 'subnet-a,subnet-b';
  process.env.AGENTA_ECS_SANDBOX_SECURITY_GROUP_IDS = 'sg-1';
  // Don't set AWS_REGION — the shim doesn't care.
  delete process.env.AWS_REGION;
  // EFS id was required by the #213 provider for access-point creation.
  // After #218 we don't need it (the task def hard-codes the fs). Leave
  // it unset to confirm the provider doesn't reach for it.
  delete process.env.AGENTA_ECS_SANDBOX_EFS_ID;

  dataDir = mkdtempSync(join(tmpdir(), 'agenta-ecs-data-'));
  process.env.AGENTA_DATA_DIR = dataDir;

  shimDir = mkdtempSync(join(tmpdir(), 'agenta-ecs-shim-'));
  scenarioDir = mkdtempSync(join(tmpdir(), 'agenta-ecs-scn-'));

  // Write the shim. The shim:
  //   - logs every invocation (JSON-array of args) to $SCN/calls.log
  //   - reads $SCN/routes.json (an array of {match, contains?, stdout?, exit?})
  //   - emits the first matching entry's stdout (or empty); exits with its
  //     code (default 0).
  // `match` is the second positional arg after `--output json [--region X]`
  // strips: routes are keyed by "service subcommand". We do the parse in
  // jq-free bash to avoid an extra runtime dep.
  const shim = `#!/usr/bin/env bash
set -e
SCN="${scenarioDir}"
ARGS_JSON=$(printf '%s\\n' "$@" | python3 -c 'import json,sys; print(json.dumps([l.rstrip("\\n") for l in sys.stdin]))')
echo "$ARGS_JSON" >> "$SCN/calls.log"

# Find the first positional that isn't a flag and isn't a flag-value.
# Pattern matches: aws --output json [--region X] <service> <subcommand> ...
SERVICE=""
SUBCMD=""
skip_next=0
seen=0
for a in "$@"; do
  if [ $skip_next -eq 1 ]; then skip_next=0; continue; fi
  case "$a" in
    --output|--region) skip_next=1; continue ;;
    --*) continue ;;
  esac
  if [ -z "$SERVICE" ]; then SERVICE="$a"; continue; fi
  if [ -z "$SUBCMD" ]; then SUBCMD="$a"; break; fi
done

KEY="$SERVICE $SUBCMD"

python3 - "$KEY" "$SCN" "$ARGS_JSON" <<'PYEOF'
import json, sys
key, scn, args_json = sys.argv[1], sys.argv[2], sys.argv[3]
with open(f"{scn}/routes.json") as f:
    routes = json.load(f)
args_str = args_json
for r in routes:
    if r.get("match") != key:
        continue
    needle = r.get("contains")
    if needle and needle not in args_str:
        continue
    if r.get("stdout"):
        sys.stdout.write(r["stdout"])
    sys.exit(int(r.get("exit", 0)))
sys.stderr.write(f"shim: unmatched aws call: {key} args={args_str}\\n")
sys.exit(2)
PYEOF
`;
  const awsShim = join(shimDir, 'aws');
  writeFileSync(awsShim, shim);
  chmodSync(awsShim, 0o755);
  process.env.PATH = `${shimDir}:${ORIG_PATH ?? ''}`;
});

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
  process.env.PATH = ORIG_PATH;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(shimDir, { recursive: true, force: true });
  rmSync(scenarioDir, { recursive: true, force: true });
  delete process.env.AGENTA_DATA_DIR;
  delete process.env.AGENTA_ECS_SANDBOX_CLUSTER;
  delete process.env.AGENTA_ECS_SANDBOX_SUBNET_IDS;
  delete process.env.AGENTA_ECS_SANDBOX_SECURITY_GROUP_IDS;
  _resetEcsState();
});

describe('ecsProvider', () => {
  test('_slugFor: normalizes threadKeys to a-z0-9- only, trims length', () => {
    const slug = _slugFor('C0B307LP274__1778732880_878239');
    expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.startsWith('-')).toBe(false);
    expect(slug.endsWith('-')).toBe(false);
  });

  test('_workspacePathFor: pins under /efs/<slug>', () => {
    const path = _workspacePathFor('C0X__1');
    expect(path.startsWith('/efs/')).toBe(true);
    // Slug comes from _slugFor — verify the format matches end-to-end.
    expect(path).toBe(`/efs/${_slugFor('C0X__1')}`);
  });

  test('ensure: runs task with SANDBOX_WORKSPACE_DIR=/efs/<slug> override + persists session.json', async () => {
    stubFetchHealthy();
    const TK = 'tk-fresh';
    const taskArn = 'arn:aws:ecs:us-east-1:123:task/agenta-sandbox/abcdef';
    setRoutes([
      // ECS run-task — returns the new task in PROVISIONING with an ENI
      // attachment carrying the private IP directly.
      {
        match: 'ecs run-task',
        stdout: JSON.stringify({
          tasks: [
            {
              taskArn,
              lastStatus: 'PROVISIONING',
              attachments: [
                {
                  type: 'ElasticNetworkInterface',
                  details: [{ name: 'privateIPv4Address', value: '10.0.0.42' }],
                },
              ],
            },
          ],
          failures: [],
        }),
      },
      // describe-tasks — the waitForTaskRunning loop polls until RUNNING.
      {
        match: 'ecs describe-tasks',
        stdout: JSON.stringify({
          tasks: [
            {
              taskArn,
              lastStatus: 'RUNNING',
              attachments: [
                {
                  type: 'ElasticNetworkInterface',
                  details: [{ name: 'privateIPv4Address', value: '10.0.0.42' }],
                },
              ],
            },
          ],
        }),
      },
    ]);

    await ecsProvider.ensure(TK);

    const calls = readCallLog().map((c) => JSON.parse(c) as string[]);

    // No access-point lifecycle anywhere — every trace of #213's
    // per-thread access points should be gone.
    const accessPointTouches = calls.some((c) =>
      c.some((a) => a.includes('access-point') || a.includes('volume-configurations')),
    );
    expect(accessPointTouches).toBe(false);

    // The run-task call must inject SANDBOX_WORKSPACE_DIR=/efs/<slug>
    // via containerOverrides.environment.
    const runTaskCall = calls.find((c) => c.includes('run-task'));
    expect(runTaskCall).toBeDefined();
    const expectedPath = _workspacePathFor(TK);
    expect(expectedPath.startsWith('/efs/')).toBe(true);
    const runTaskFlat = runTaskCall?.join(' ') ?? '';
    expect(runTaskFlat).toContain('SANDBOX_WORKSPACE_DIR');
    expect(runTaskFlat).toContain(expectedPath);

    // And SANDBOX_TOKEN is still passed too.
    expect(runTaskFlat).toContain('SANDBOX_TOKEN');

    const session = await readSession(TK);
    expect(session?.sandbox?.provider).toBe('ecs');
    if (session?.sandbox?.provider !== 'ecs') throw new Error('unreachable');
    expect(session.sandbox.task_arn).toBe(taskArn);
    expect(session.sandbox.workspace_path).toBe(expectedPath);
    expect(session.sandbox.sandbox_token.length).toBeGreaterThan(16);
    expect(session.sandbox.private_ip).toBe('10.0.0.42');

    const ep = await ecsProvider.getEndpoint(TK);
    expect(ep.baseUrl).toBe('http://10.0.0.42:9000');
    expect(ep.headers.Authorization).toBe(`Bearer ${session.sandbox.sandbox_token}`);
  });

  test('ensure: re-hydrates from disk when in-memory state empty and task RUNNING', async () => {
    stubFetchHealthy();
    const TK = 'tk-hydrate';
    const taskArn = 'arn:aws:ecs:us-east-1:123:task/agenta-sandbox/live';
    await writeSession(TK, {
      status: 'idle',
      updated_at: 't',
      sandbox: {
        provider: 'ecs',
        task_arn: taskArn,
        workspace_path: '/efs/tk-hydrate',
        sandbox_token: 'preserved-token',
        private_ip: '10.0.0.99',
      },
    });

    setRoutes([
      {
        match: 'ecs describe-tasks',
        contains: taskArn,
        stdout: JSON.stringify({
          tasks: [
            {
              taskArn,
              lastStatus: 'RUNNING',
              attachments: [
                {
                  type: 'ElasticNetworkInterface',
                  details: [{ name: 'privateIPv4Address', value: '10.0.0.99' }],
                },
              ],
            },
          ],
        }),
      },
    ]);

    await ecsProvider.ensure(TK);

    // No run-task — pure adoption.
    const calls = readCallLog().map((c) => JSON.parse(c) as string[]);
    const ranTask = calls.some((c) => c.includes('run-task'));
    expect(ranTask).toBe(false);

    const ep = await ecsProvider.getEndpoint(TK);
    expect(ep.headers.Authorization).toBe('Bearer preserved-token');
    expect(ep.baseUrl).toBe('http://10.0.0.99:9000');
  });

  test('ensure: dead task re-runs new task with same workspace_path', async () => {
    stubFetchHealthy();
    const TK = 'tk-revive';
    const oldArn = 'arn:aws:ecs:us-east-1:123:task/agenta-sandbox/dead';
    const newArn = 'arn:aws:ecs:us-east-1:123:task/agenta-sandbox/new';
    await writeSession(TK, {
      status: 'idle',
      updated_at: 't',
      sandbox: {
        provider: 'ecs',
        task_arn: oldArn,
        workspace_path: '/efs/preserved-workspace',
        sandbox_token: 'preserved-token',
      },
    });

    setRoutes([
      // verifyAlive: task is STOPPED → treated as dead.
      {
        match: 'ecs describe-tasks',
        contains: 'dead',
        stdout: JSON.stringify({
          tasks: [{ taskArn: oldArn, lastStatus: 'STOPPED' }],
        }),
      },
      // run-task — the new task. The shim doesn't filter on contains
      // here so we don't have to know the run-task arg ordering.
      {
        match: 'ecs run-task',
        stdout: JSON.stringify({
          tasks: [
            {
              taskArn: newArn,
              lastStatus: 'PROVISIONING',
              attachments: [
                {
                  type: 'ElasticNetworkInterface',
                  details: [{ name: 'privateIPv4Address', value: '10.0.0.7' }],
                },
              ],
            },
          ],
          failures: [],
        }),
      },
      // describe-tasks for the new ARN until RUNNING.
      {
        match: 'ecs describe-tasks',
        contains: 'new',
        stdout: JSON.stringify({
          tasks: [
            {
              taskArn: newArn,
              lastStatus: 'RUNNING',
              attachments: [
                {
                  type: 'ElasticNetworkInterface',
                  details: [{ name: 'privateIPv4Address', value: '10.0.0.7' }],
                },
              ],
            },
          ],
        }),
      },
    ]);

    await ecsProvider.ensure(TK);

    const calls = readCallLog().map((c) => JSON.parse(c) as string[]);
    // Workspace path threaded through — the run-task call must carry
    // the same /efs/<slug> the previous task used, so files survive
    // across the dead → new transition.
    const runTaskCall = calls.find((c) => c.includes('run-task'));
    expect(runTaskCall).toBeDefined();
    expect(runTaskCall?.join(' ')).toContain('/efs/preserved-workspace');

    // No access-point lifecycle.
    const accessPointTouches = calls.some((c) =>
      c.some((a) => a.includes('access-point') || a.includes('volume-configurations')),
    );
    expect(accessPointTouches).toBe(false);

    const session = await readSession(TK);
    if (session?.sandbox?.provider !== 'ecs') throw new Error('unreachable');
    expect(session.sandbox.task_arn).toBe(newArn);
    expect(session.sandbox.workspace_path).toBe('/efs/preserved-workspace');
    expect(session.sandbox.sandbox_token).toBe('preserved-token');
    expect(session.sandbox.private_ip).toBe('10.0.0.7');
  });

  test('ensure: cross-provider record is cleared and re-provisioned as ecs', async () => {
    stubFetchHealthy();
    const TK = 'tk-xprov';
    await writeSession(TK, {
      status: 'idle',
      updated_at: 't',
      sandbox: { provider: 'fly', machine_id: 'm-fly', token: 't' },
    });

    setRoutes([
      {
        match: 'ecs run-task',
        stdout: JSON.stringify({
          tasks: [
            {
              taskArn: 'arn:aws:ecs:us-east-1:123:task/agenta-sandbox/fresh',
              lastStatus: 'PROVISIONING',
              attachments: [
                {
                  type: 'ElasticNetworkInterface',
                  details: [{ name: 'privateIPv4Address', value: '10.0.0.1' }],
                },
              ],
            },
          ],
          failures: [],
        }),
      },
      {
        match: 'ecs describe-tasks',
        stdout: JSON.stringify({
          tasks: [
            {
              taskArn: 'arn:aws:ecs:us-east-1:123:task/agenta-sandbox/fresh',
              lastStatus: 'RUNNING',
              attachments: [
                {
                  type: 'ElasticNetworkInterface',
                  details: [{ name: 'privateIPv4Address', value: '10.0.0.1' }],
                },
              ],
            },
          ],
        }),
      },
    ]);

    await ecsProvider.ensure(TK);
    const session = await readSession(TK);
    expect(session?.sandbox?.provider).toBe('ecs');
    if (session?.sandbox?.provider !== 'ecs') throw new Error('unreachable');
    expect(session.sandbox.workspace_path).toBe(_workspacePathFor(TK));
  });

  test('remove: stops task (does NOT delete any access point — there are none)', async () => {
    stubFetchHealthy();
    const TK = 'tk-rm';
    const taskArn = 'arn:aws:ecs:us-east-1:123:task/agenta-sandbox/rm';
    await writeSession(TK, {
      status: 'idle',
      updated_at: 't',
      sandbox: {
        provider: 'ecs',
        task_arn: taskArn,
        workspace_path: '/efs/tk-rm',
        sandbox_token: 't',
        private_ip: '10.0.0.5',
      },
    });

    setRoutes([{ match: 'ecs stop-task', stdout: JSON.stringify({}) }]);

    await ecsProvider.remove(TK);

    const calls = readCallLog().map((c) => JSON.parse(c) as string[]);
    expect(calls.some((c) => c.includes('stop-task'))).toBe(true);
    // No EFS calls at all in the remove path now.
    expect(calls.some((c) => c[0] === 'efs' || c.some((a) => a === 'efs'))).toBe(false);

    const after = await readSession(TK);
    expect(after?.sandbox).toBeUndefined();
    expect(after?.status).toBe('idle');
  });

  test('listAll: returns RUNNING task ARNs (no access points)', async () => {
    setRoutes([
      {
        match: 'ecs list-tasks',
        stdout: JSON.stringify({
          taskArns: [
            'arn:aws:ecs:us-east-1:123:task/agenta-sandbox/t1',
            'arn:aws:ecs:us-east-1:123:task/agenta-sandbox/t2',
          ],
        }),
      },
    ]);

    const list = await ecsProvider.listAll();
    const ids = list.map((e) => e.id).sort();
    expect(ids).toContain('arn:aws:ecs:us-east-1:123:task/agenta-sandbox/t1');
    expect(ids).toContain('arn:aws:ecs:us-east-1:123:task/agenta-sandbox/t2');
    // No access-point ids in the output.
    expect(ids.some((id) => id.startsWith('fsap-'))).toBe(false);

    // And the shim shouldn't have been asked to list access points at all.
    const calls = readCallLog().map((c) => JSON.parse(c) as string[]);
    expect(calls.some((c) => c.includes('describe-access-points'))).toBe(false);
  });

  test('destroyById: dispatches task ARNs, ignores other id shapes', async () => {
    setRoutes([{ match: 'ecs stop-task', stdout: JSON.stringify({}) }]);

    await ecsProvider.destroyById('arn:aws:ecs:us-east-1:123:task/agenta-sandbox/x');
    // Unknown id format is a no-op (just logs a warning).
    await ecsProvider.destroyById('fsap-abc');

    const calls = readCallLog().map((c) => JSON.parse(c) as string[]);
    expect(calls.filter((c) => c.includes('stop-task')).length).toBe(1);
    expect(calls.some((c) => c.includes('delete-access-point'))).toBe(false);
  });

  test('ensure: throws when required env vars missing', async () => {
    delete process.env.AGENTA_ECS_SANDBOX_CLUSTER;
    await expect(ecsProvider.ensure('k')).rejects.toThrow(/AGENTA_ECS_SANDBOX_CLUSTER/);
  });

  test('SandboxRecord(ecs) round-trips through session-store with workspace_path', async () => {
    const TK = 'tk-roundtrip';
    await writeSession(TK, {
      status: 'idle',
      updated_at: 't',
      sandbox: {
        provider: 'ecs',
        task_arn: 'arn:aws:ecs:us-east-1:1:task/c/abc',
        workspace_path: '/efs/tk-roundtrip',
        sandbox_token: 'rt-token',
        private_ip: '10.1.2.3',
      },
    });
    const back = await readSession(TK);
    expect(back?.sandbox?.provider).toBe('ecs');
    if (back?.sandbox?.provider !== 'ecs') throw new Error('unreachable');
    expect(back.sandbox.task_arn).toBe('arn:aws:ecs:us-east-1:1:task/c/abc');
    expect(back.sandbox.workspace_path).toBe('/efs/tk-roundtrip');
    expect(back.sandbox.sandbox_token).toBe('rt-token');
    expect(back.sandbox.private_ip).toBe('10.1.2.3');
  });
});
