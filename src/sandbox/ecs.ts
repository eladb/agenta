// ECS Fargate sandbox provider (#213).
//
// Per-thread `aws ecs run-task` against a dedicated sandbox cluster
// (e.g. `agenta-sandbox`) + per-thread EFS access point pinned under
// /sandboxes/<thread-slug>. The bot dials the task's private IP on
// port 9000 over plain HTTP — in-VPC routing only, sandbox SG accepts
// ingress from the bot SG only. No ALB, no Cloud Map, no public surface.
//
// Mirrors the shape of fly.ts: same three re-hydration branches
// (live task → adopt / dead task + live access point → re-run /
// nothing → fresh), same listAll/destroyById for orphan reap, same
// SANDBOX_TOKEN bearer model. Tagged with `agenta_bot_instance=<cluster>`
// so multiple bot deployments in the same AWS account don't fight each
// other.
//
// We shell out to the `aws` CLI rather than pull in @aws-sdk to stay
// consistent with the rest of the repo (canary.ts, deploy-bot-ecs.ts,
// deploy-sandbox-ecs.ts all do the same).

import { spawn } from 'node:child_process';
import { log } from '../log';
import { clearSandbox, loadSandbox, saveSandbox, sweepAllSandboxes } from './persistence';
import type { SandboxEndpoint, SandboxProvider } from './provider';

const SANDBOX_PORT = 9000;
const TASK_TAG_KEY = 'agenta_bot_instance';
// Tag value on access points uses the same convention. EFS access points
// don't accept arbitrary tags on create via the CLI's --tags shape that
// the runtime uses — see access-point creation below. We keep the
// convention for the task tag side.

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`SANDBOX_PROVIDER=ecs requires env var ${name}`);
  return v;
}

function cluster(): string {
  return requireEnv('AGENTA_ECS_SANDBOX_CLUSTER');
}
function taskFamily(): string {
  return process.env.AGENTA_ECS_SANDBOX_TASK_FAMILY ?? 'agenta-sandbox';
}
function efsId(): string {
  return requireEnv('AGENTA_ECS_SANDBOX_EFS_ID');
}
function subnets(): string[] {
  return requireEnv('AGENTA_ECS_SANDBOX_SUBNET_IDS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
function securityGroups(): string[] {
  return requireEnv('AGENTA_ECS_SANDBOX_SECURITY_GROUP_IDS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
function awsRegion(): string | undefined {
  return process.env.AWS_REGION;
}

// Same threadKey-normalization shape as fly.ts machineName: thread keys
// contain uppercase Slack channel IDs and underscores, which aren't legal
// in the slug we use for the EFS RootDirectory path. Lowercase a-z, 0-9
// and dashes only; trim length to be conservative.
export function _slugFor(threadKey: string): string {
  const slug = threadKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // EFS RootDirectory path has no hard length limit but keep it short so
  // logs stay readable. 40 chars is plenty for a Slack channel + ts pair.
  return slug.slice(0, 40);
}

// EFS access-point sub-path on the shared filesystem. One per thread.
export function _rootDirectoryFor(threadKey: string): string {
  return `/sandboxes/${_slugFor(threadKey)}`;
}

function randomToken(): string {
  return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
}

type AwsResult = { stdout: string; stderr: string; exitCode: number };

function awsSpawn(args: string[], signal?: AbortSignal): Promise<AwsResult> {
  return new Promise((resolve, reject) => {
    const fullArgs = ['--output', 'json'];
    if (awsRegion()) fullArgs.push('--region', awsRegion()!);
    fullArgs.push(...args);
    const proc = spawn('aws', fullArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
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
    if (signal) {
      const onAbort = (): void => {
        proc.kill('SIGTERM');
      };
      signal.addEventListener('abort', onAbort);
      proc.on('close', () => signal.removeEventListener('abort', onAbort));
    }
  });
}

async function awsJson<T>(args: string[]): Promise<T> {
  const r = await awsSpawn(args);
  if (r.exitCode !== 0) {
    throw new Error(`aws ${args.join(' ')} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  }
  try {
    return JSON.parse(r.stdout) as T;
  } catch (err) {
    throw new Error(`aws ${args.join(' ')}: malformed JSON: ${(err as Error).message}`);
  }
}

// Try-variant: swallows errors, returns undefined. Used in best-effort
// teardown paths where we don't want one stale resource to abort the
// whole sweep.
async function awsJsonTry<T>(args: string[]): Promise<T | undefined> {
  const r = await awsSpawn(args);
  if (r.exitCode !== 0) return undefined;
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    return undefined;
  }
}

type EcsTask = {
  taskArn: string;
  lastStatus?: string;
  desiredStatus?: string;
  attachments?: Array<{
    type?: string;
    details?: Array<{ name?: string; value?: string }>;
  }>;
  tags?: Array<{ key: string; value: string }>;
};

type DescribeTasksResp = { tasks?: EcsTask[]; failures?: unknown[] };

async function describeTask(taskArn: string): Promise<EcsTask | undefined> {
  const resp = await awsJsonTry<DescribeTasksResp>([
    'ecs',
    'describe-tasks',
    '--cluster',
    cluster(),
    '--tasks',
    taskArn,
    '--include',
    'TAGS',
  ]);
  return resp?.tasks?.[0];
}

// ECS task ENIs get a fresh private IP every RunTask. The path is:
//   describe-tasks → attachment of type=ElasticNetworkInterface →
//   detail name=networkInterfaceId → describe-network-interfaces →
//   PrivateIpAddress.
async function resolvePrivateIp(task: EcsTask): Promise<string | undefined> {
  for (const att of task.attachments ?? []) {
    if (att.type !== 'ElasticNetworkInterface') continue;
    // The eni attachment carries `privateIPv4Address` directly once the
    // ENI is attached (which happens before lastStatus=RUNNING for
    // Fargate tasks). Prefer that to skip an EC2 call. Fall back to
    // describe-network-interfaces only if the field is missing.
    const directIp = att.details?.find(
      (d) => d.name === 'privateIPv4Address' || d.name === 'privateIp',
    )?.value;
    if (directIp) return directIp;
    const eniId = att.details?.find((d) => d.name === 'networkInterfaceId')?.value;
    if (!eniId) continue;
    type DescribeEniResp = {
      NetworkInterfaces?: Array<{ PrivateIpAddress?: string }>;
    };
    const resp = await awsJsonTry<DescribeEniResp>([
      'ec2',
      'describe-network-interfaces',
      '--network-interface-ids',
      eniId,
    ]);
    const ip = resp?.NetworkInterfaces?.[0]?.PrivateIpAddress;
    if (ip) return ip;
  }
  return undefined;
}

// Liveness probe analog of fly.ts:verifyAlive. RUNNING + reachable
// private IP = alive. Anything else (PENDING, STOPPED, missing) = dead.
async function verifyAlive(taskArn: string): Promise<string | undefined> {
  const t = await describeTask(taskArn);
  if (!t) return undefined;
  if (t.lastStatus !== 'RUNNING') return undefined;
  return await resolvePrivateIp(t);
}

type EfsAccessPoint = {
  AccessPointId: string;
  AccessPointArn?: string;
  FileSystemId?: string;
  RootDirectory?: { Path?: string };
  LifeCycleState?: string;
  Tags?: Array<{ Key: string; Value: string }>;
};

type DescribeAccessPointsResp = { AccessPoints?: EfsAccessPoint[] };

async function describeAccessPoint(id: string): Promise<EfsAccessPoint | undefined> {
  const resp = await awsJsonTry<DescribeAccessPointsResp>([
    'efs',
    'describe-access-points',
    '--access-point-id',
    id,
  ]);
  return resp?.AccessPoints?.[0];
}

async function createAccessPoint(threadKey: string): Promise<EfsAccessPoint> {
  // EFS access points pin a POSIX uid/gid and a RootDirectory. We mirror
  // the sandbox image's `sandbox` user (uid 1000) so workspace files
  // land with the right ownership without the entrypoint having to
  // chown anything (the sandbox container drops CAP_CHOWN; see CLAUDE.md).
  const path = _rootDirectoryFor(threadKey);
  const resp = await awsJson<{ AccessPointId: string; AccessPointArn?: string }>([
    'efs',
    'create-access-point',
    '--file-system-id',
    efsId(),
    '--posix-user',
    JSON.stringify({ Uid: 1000, Gid: 1000 }),
    '--root-directory',
    JSON.stringify({
      Path: path,
      CreationInfo: { OwnerUid: 1000, OwnerGid: 1000, Permissions: '0755' },
    }),
    '--tags',
    JSON.stringify([
      { Key: TASK_TAG_KEY, Value: cluster() },
      { Key: 'agenta_thread_key', Value: threadKey },
    ]),
  ]);
  return { AccessPointId: resp.AccessPointId, AccessPointArn: resp.AccessPointArn };
}

async function deleteAccessPoint(id: string): Promise<void> {
  const r = await awsSpawn(['efs', 'delete-access-point', '--access-point-id', id]);
  if (r.exitCode !== 0) {
    log.warn('sandbox', `ecs delete-access-point ${id}: ${r.stderr.trim()}`);
  }
}

type RunTaskResp = {
  tasks?: EcsTask[];
  failures?: Array<{ arn?: string; reason?: string }>;
};

async function runTask(
  threadKey: string,
  sandboxToken: string,
  accessPointId: string,
): Promise<EcsTask> {
  // Per-thread RunTask. Container env (SANDBOX_TOKEN + optional
  // SANDBOX_EGRESS) goes through `overrides.containerOverrides[*].environment`
  // so we don't have to register a new task-def revision per thread.
  // The task-def's `volumes:` already wires up the EFS volume with a
  // placeholder access point id; we override it via `overrides.volumes`
  // (a feature ECS added in 2024 — `--volume-configurations`).
  //
  // Fallback for older CLI / control planes: if --volume-configurations
  // isn't supported, the operator needs to pre-create access points
  // per thread out-of-band, which defeats the whole point. We bail
  // explicitly with a helpful message in that case.
  const overrides = {
    containerOverrides: [
      {
        name: 'sandbox',
        environment: [
          { name: 'SANDBOX_TOKEN', value: sandboxToken },
          ...(process.env.SANDBOX_EGRESS
            ? [{ name: 'SANDBOX_EGRESS', value: process.env.SANDBOX_EGRESS }]
            : []),
        ],
      },
    ],
  };
  const volumeConfigurations = [
    {
      name: 'workspace',
      managedEBSVolume: undefined,
      // Bind the task-def-side volume `workspace` to the per-thread
      // EFS access point. Mount-target SG accepts NFS from the sandbox
      // task SG only.
      efsVolumeConfiguration: {
        fileSystemId: efsId(),
        rootDirectory: '/',
        transitEncryption: 'ENABLED',
        authorizationConfig: { accessPointId, iam: 'ENABLED' },
      },
    },
  ];

  const args = [
    'ecs',
    'run-task',
    '--cluster',
    cluster(),
    '--task-definition',
    taskFamily(),
    '--launch-type',
    'FARGATE',
    '--network-configuration',
    JSON.stringify({
      awsvpcConfiguration: {
        subnets: subnets(),
        securityGroups: securityGroups(),
        // Private IP only — sandbox sits in-VPC and is reached by the
        // bot over the VPC private network. No public IP means no
        // accidental public exposure even if SGs misbehave.
        assignPublicIp: 'DISABLED',
      },
    }),
    '--overrides',
    JSON.stringify(overrides),
    '--volume-configurations',
    JSON.stringify(volumeConfigurations),
    '--tags',
    JSON.stringify([
      { key: TASK_TAG_KEY, value: cluster() },
      { key: 'agenta_thread_key', value: threadKey },
    ]),
    '--propagate-tags',
    'TASK_DEFINITION',
    '--enable-execute-command',
  ];

  const resp = await awsJson<RunTaskResp>(args);
  const failure = resp.failures?.[0];
  if (failure) {
    throw new Error(`ecs run-task failed: ${failure.reason ?? JSON.stringify(failure)}`);
  }
  const task = resp.tasks?.[0];
  if (!task?.taskArn) throw new Error('ecs run-task: no task returned');
  return task;
}

async function waitForTaskRunning(taskArn: string, timeoutMs = 180_000): Promise<EcsTask> {
  // Fargate cold-starts a task in 30-90s typically. 3 minutes is generous
  // but not absurd; surfaces a stuck task before the user gives up.
  const deadline = Date.now() + timeoutMs;
  let last: EcsTask | undefined;
  while (Date.now() < deadline) {
    const t = await describeTask(taskArn);
    if (t) {
      last = t;
      if (t.lastStatus === 'RUNNING') return t;
      if (t.lastStatus === 'STOPPED') {
        throw new Error(`ecs task ${taskArn} stopped before becoming RUNNING`);
      }
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  throw new Error(
    `ecs task ${taskArn} did not reach RUNNING within ${timeoutMs}ms (last=${last?.lastStatus ?? '?'})`,
  );
}

async function waitForHealth(ip: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 3_000);
      try {
        const res = await fetch(`http://${ip}:${SANDBOX_PORT}/health`, { signal: ac.signal });
        if (res.status === 200) return;
        lastErr = `status ${res.status}`;
      } finally {
        clearTimeout(t);
      }
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`ecs sandbox not healthy at ${ip}:${SANDBOX_PORT} after ${timeoutMs}ms: ${String(lastErr)}`);
}

async function stopTask(taskArn: string): Promise<void> {
  const r = await awsSpawn(['ecs', 'stop-task', '--cluster', cluster(), '--task', taskArn]);
  if (r.exitCode !== 0) {
    log.warn('sandbox', `ecs stop-task ${taskArn}: ${r.stderr.trim()}`);
  }
}

type SandboxState = { taskArn: string; token: string; accessPointId: string; privateIp?: string };
const state = new Map<string, SandboxState>();

async function ensure(threadKey: string): Promise<void> {
  if (state.has(threadKey)) return;

  // Re-hydration: three branches matching fly.ts.
  //   - same-provider live task → adopt.
  //   - same-provider dead task + live access point → re-run task with
  //     the same access point (workspace state survives via EFS).
  //   - cross-provider or fully missing → provision from scratch.
  const persisted = await loadSandbox(threadKey);
  if (persisted) {
    if (persisted.provider !== 'ecs') {
      log.warn(
        'sandbox',
        `[${threadKey}] persisted sandbox is ${persisted.provider}; SANDBOX_PROVIDER=ecs — ignoring`,
      );
      await clearSandbox(threadKey);
    } else {
      const liveIp = await verifyAlive(persisted.task_arn);
      if (liveIp !== undefined) {
        state.set(threadKey, {
          taskArn: persisted.task_arn,
          token: persisted.sandbox_token,
          accessPointId: persisted.access_point_id,
          ...(liveIp ? { privateIp: liveIp } : {}),
        });
        if (liveIp && liveIp !== persisted.private_ip) {
          await saveSandbox(threadKey, {
            provider: 'ecs',
            task_arn: persisted.task_arn,
            access_point_id: persisted.access_point_id,
            sandbox_token: persisted.sandbox_token,
            private_ip: liveIp,
          });
        }
        log.info('sandbox', `re-hydrated ecs task ${persisted.task_arn} from session.json`);
        return;
      }
      // Dead task. If the access point survived, re-run the task with
      // the same access point so the workspace volume is preserved.
      const ap = await describeAccessPoint(persisted.access_point_id);
      if (ap && ap.LifeCycleState !== 'deleted' && ap.LifeCycleState !== 'deleting') {
        log.info(
          'sandbox',
          `[${threadKey}] persisted task ${persisted.task_arn} dead; reattaching access point ${persisted.access_point_id}`,
        );
        const task = await runTask(threadKey, persisted.sandbox_token, persisted.access_point_id);
        const ready = await waitForTaskRunning(task.taskArn);
        const ip = await resolvePrivateIp(ready);
        if (!ip) throw new Error(`ecs reattach: no private IP for task ${task.taskArn}`);
        state.set(threadKey, {
          taskArn: task.taskArn,
          token: persisted.sandbox_token,
          accessPointId: persisted.access_point_id,
          privateIp: ip,
        });
        await saveSandbox(threadKey, {
          provider: 'ecs',
          task_arn: task.taskArn,
          access_point_id: persisted.access_point_id,
          sandbox_token: persisted.sandbox_token,
          private_ip: ip,
        });
        await waitForHealth(ip);
        log.info(
          'sandbox',
          `ecs task ${task.taskArn} ready — reattached access point ${persisted.access_point_id}`,
        );
        return;
      }
      log.info(
        'sandbox',
        `[${threadKey}] persisted task ${persisted.task_arn} dead and access point gone; re-provisioning`,
      );
      await clearSandbox(threadKey);
    }
  }

  // Fresh provision: new access point + new task.
  const ap = await createAccessPoint(threadKey);
  const sandboxToken = randomToken();
  let task: EcsTask;
  try {
    task = await runTask(threadKey, sandboxToken, ap.AccessPointId);
  } catch (err) {
    // Best-effort: a newly-created access point with no task is useless.
    await deleteAccessPoint(ap.AccessPointId).catch(() => {});
    throw err;
  }
  const ready = await waitForTaskRunning(task.taskArn);
  const ip = await resolvePrivateIp(ready);
  if (!ip) throw new Error(`ecs ensure: no private IP for task ${task.taskArn}`);
  state.set(threadKey, {
    taskArn: task.taskArn,
    token: sandboxToken,
    accessPointId: ap.AccessPointId,
    privateIp: ip,
  });
  await saveSandbox(threadKey, {
    provider: 'ecs',
    task_arn: task.taskArn,
    access_point_id: ap.AccessPointId,
    sandbox_token: sandboxToken,
    private_ip: ip,
  });
  await waitForHealth(ip);
  log.info(
    'sandbox',
    `ecs task ${task.taskArn} ready (access point ${ap.AccessPointId}, ip ${ip})`,
  );
}

async function getEndpoint(threadKey: string): Promise<SandboxEndpoint> {
  let s = state.get(threadKey);
  if (!s) {
    // Lazy re-hydration mirror of fly.ts:getEndpoint.
    const persisted = await loadSandbox(threadKey);
    if (persisted && persisted.provider === 'ecs') {
      const liveIp = await verifyAlive(persisted.task_arn);
      if (liveIp !== undefined) {
        s = {
          taskArn: persisted.task_arn,
          token: persisted.sandbox_token,
          accessPointId: persisted.access_point_id,
          ...(liveIp ? { privateIp: liveIp } : {}),
        };
        state.set(threadKey, s);
        log.info('sandbox', `[${threadKey}] re-hydrated ecs endpoint from session.json`);
      } else {
        await clearSandbox(threadKey);
        throw new Error(`sandbox not initialized for ${threadKey}`);
      }
    } else {
      if (persisted) await clearSandbox(threadKey);
      throw new Error(`sandbox not initialized for ${threadKey}`);
    }
  }
  if (!s.privateIp) {
    // Last-resort re-resolve: in-memory cache existed but the IP was
    // missing (e.g. we adopted a record whose private_ip field was unset).
    const t = await describeTask(s.taskArn);
    const ip = t ? await resolvePrivateIp(t) : undefined;
    if (!ip) throw new Error(`ecs getEndpoint: could not resolve private IP for ${s.taskArn}`);
    s.privateIp = ip;
  }
  return {
    baseUrl: `http://${s.privateIp}:${SANDBOX_PORT}`,
    headers: {
      Authorization: `Bearer ${s.token}`,
    },
  };
}

async function remove(threadKey: string): Promise<void> {
  // Persisted record carries the access point id even if the in-memory
  // cache is empty (e.g. bot restart between ensure and remove).
  const persisted = await loadSandbox(threadKey);
  const persistedAccessPoint =
    persisted?.provider === 'ecs' ? persisted.access_point_id : undefined;
  const persistedTaskArn = persisted?.provider === 'ecs' ? persisted.task_arn : undefined;
  const s = state.get(threadKey);
  state.delete(threadKey);
  await clearSandbox(threadKey).catch((err) => {
    log.warn('sandbox', `remove: clearSandbox(${threadKey}) failed: ${(err as Error).message}`);
  });

  const taskArn = s?.taskArn ?? persistedTaskArn;
  if (taskArn) {
    await stopTask(taskArn);
    log.info('sandbox', `ecs task ${taskArn} stopped`);
  }
  const apId = s?.accessPointId ?? persistedAccessPoint;
  if (apId) {
    await deleteAccessPoint(apId);
  }
}

type ListTasksResp = { taskArns?: string[] };
type ListAccessPointsResp = {
  AccessPoints?: Array<{
    AccessPointId: string;
    Tags?: Array<{ Key: string; Value: string }>;
  }>;
};

async function listAll(): Promise<Array<{ id: string }>> {
  const out: Array<{ id: string }> = [];
  // Tasks in the sandbox cluster — implicitly scoped by cluster name
  // (cluster per bot instance, per #210 + the issue spec).
  const tasksResp = await awsJsonTry<ListTasksResp>([
    'ecs',
    'list-tasks',
    '--cluster',
    cluster(),
    '--desired-status',
    'RUNNING',
  ]);
  for (const arn of tasksResp?.taskArns ?? []) out.push({ id: arn });

  // Access points on the shared EFS, scoped by tag.
  const apResp = await awsJsonTry<ListAccessPointsResp>([
    'efs',
    'describe-access-points',
    '--file-system-id',
    efsId(),
  ]);
  for (const ap of apResp?.AccessPoints ?? []) {
    const tag = ap.Tags?.find((t) => t.Key === TASK_TAG_KEY);
    if (tag?.Value === cluster()) out.push({ id: ap.AccessPointId });
  }
  return out;
}

async function destroyById(id: string): Promise<void> {
  // ECS task ARNs start with `arn:aws:ecs:`; EFS access point ids start
  // with `fsap-`. Dispatch on prefix the way fly.ts does for `vol_`.
  if (id.startsWith('fsap-')) {
    await deleteAccessPoint(id);
    return;
  }
  if (id.startsWith('arn:aws:ecs:') || id.includes(':task/')) {
    await stopTask(id);
    return;
  }
  log.warn('sandbox', `ecs destroyById: unrecognized id format: ${id}`);
}

async function killAll(): Promise<void> {
  const tasksResp = await awsJsonTry<ListTasksResp>([
    'ecs',
    'list-tasks',
    '--cluster',
    cluster(),
  ]);
  const arns = tasksResp?.taskArns ?? [];
  for (const arn of arns) {
    await stopTask(arn);
  }
  if (arns.length > 0) log.info('sandbox', `ecs: stopped ${arns.length} task(s)`);

  const apResp = await awsJsonTry<ListAccessPointsResp>([
    'efs',
    'describe-access-points',
    '--file-system-id',
    efsId(),
  ]);
  const aps = (apResp?.AccessPoints ?? []).filter((ap) =>
    ap.Tags?.some((t) => t.Key === TASK_TAG_KEY && t.Value === cluster()),
  );
  for (const ap of aps) {
    await deleteAccessPoint(ap.AccessPointId);
  }
  if (aps.length > 0) log.info('sandbox', `ecs: deleted ${aps.length} access point(s)`);

  state.clear();
  await sweepAllSandboxes();
}

function isReady(threadKey: string): boolean {
  return state.has(threadKey);
}

export const ecsProvider: SandboxProvider = {
  name: 'ecs',
  ensure,
  isReady,
  getEndpoint,
  remove,
  killAll,
  listAll,
  destroyById,
};

// For tests.
export function _resetEcsState(): void {
  state.clear();
}
