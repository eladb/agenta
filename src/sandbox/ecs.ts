// ECS Fargate sandbox provider (#213, refactored #218).
//
// Per-thread `aws ecs run-task` against a dedicated sandbox cluster
// (e.g. `agenta-sandbox`). The task mounts a single shared EFS
// filesystem at /efs (no per-thread access points — see #218 for why
// that didn't work: `--volume-configurations` is EBS-only, EFS access
// points can't be overridden per task). Per-thread isolation is the
// workspace directory: SANDBOX_WORKSPACE_DIR=/efs/<thread-slug> is
// injected via run-task containerOverrides so the same task definition
// serves every thread.
//
// The bot dials the task's private IP on port 9000 over plain HTTP —
// in-VPC routing only, sandbox SG accepts ingress from the bot SG only.
// No ALB, no Cloud Map, no public surface.
//
// Mirrors the shape of fly.ts: same three re-hydration branches
// (live task → adopt / dead task + persisted workspace → re-run with
// the same workspace path / nothing → fresh), same listAll/destroyById
// for orphan reap, same SANDBOX_TOKEN bearer model. Tagged with
// `agenta_bot_instance=<cluster>` so multiple bot deployments in the
// same AWS account don't fight each other.
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
// Mount point inside the sandbox container for the shared EFS root.
// Matches the task-def MountPoint in sandbox-cloudformation.yaml.
const EFS_MOUNT = '/efs';

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
// in the workspace dir slug. Lowercase a-z, 0-9 and dashes only; trim
// length to be conservative. Kept in sync with fly.ts intentionally so
// debugging across providers is easier.
export function _slugFor(threadKey: string): string {
  const slug = threadKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // 40 chars is plenty for a Slack channel + ts pair, and keeps `ls /efs`
  // output readable.
  return slug.slice(0, 40);
}

// Per-thread workspace subdirectory on the shared EFS root. Passed to
// the sandbox server as SANDBOX_WORKSPACE_DIR; the entrypoint
// mkdir+chowns it before exec'ing the server.
export function _workspacePathFor(threadKey: string): string {
  return `${EFS_MOUNT}/${_slugFor(threadKey)}`;
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

type RunTaskResp = {
  tasks?: EcsTask[];
  failures?: Array<{ arn?: string; reason?: string }>;
};

async function runTask(
  threadKey: string,
  sandboxToken: string,
  workspacePath: string,
): Promise<EcsTask> {
  // Per-thread RunTask. Container env (SANDBOX_TOKEN +
  // SANDBOX_WORKSPACE_DIR + optional SANDBOX_EGRESS) goes through
  // `overrides.containerOverrides[*].environment` so we don't have to
  // register a new task-def revision per thread. The task-def's
  // `volumes:` already mounts the shared EFS root at /efs (no access
  // point, no per-task override needed — that was the broken design in
  // #213 fixed by #218).
  const overrides = {
    containerOverrides: [
      {
        name: 'sandbox',
        environment: [
          { name: 'SANDBOX_TOKEN', value: sandboxToken },
          { name: 'SANDBOX_WORKSPACE_DIR', value: workspacePath },
          ...(process.env.SANDBOX_EGRESS
            ? [{ name: 'SANDBOX_EGRESS', value: process.env.SANDBOX_EGRESS }]
            : []),
        ],
      },
    ],
  };

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
        // ENABLED matches the bot's own design: a public subnet + public
        // IP for egress to ECR / CloudWatch Logs / Slack, with no NAT
        // Gateway in the path. Security groups keep inbound locked down
        // (port 9000 reachable only from the bot SG). Override via env if a
        // deployment instead uses private subnets fronted by a NAT Gateway.
        assignPublicIp: process.env.AGENTA_ECS_SANDBOX_ASSIGN_PUBLIC_IP ?? 'ENABLED',
      },
    }),
    '--overrides',
    JSON.stringify(overrides),
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

type SandboxState = {
  taskArn: string;
  token: string;
  workspacePath: string;
  privateIp?: string;
};
const state = new Map<string, SandboxState>();

async function ensure(threadKey: string): Promise<void> {
  if (state.has(threadKey)) return;

  // Re-hydration: three branches matching fly.ts.
  //   - same-provider live task → adopt.
  //   - same-provider dead task → re-run task with the same
  //     workspace_path (the directory on EFS survives across tasks,
  //     so the previous turn's files are still there).
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
          workspacePath: persisted.workspace_path,
          ...(liveIp ? { privateIp: liveIp } : {}),
        });
        if (liveIp && liveIp !== persisted.private_ip) {
          await saveSandbox(threadKey, {
            provider: 'ecs',
            task_arn: persisted.task_arn,
            workspace_path: persisted.workspace_path,
            sandbox_token: persisted.sandbox_token,
            private_ip: liveIp,
          });
        }
        log.info('sandbox', `re-hydrated ecs task ${persisted.task_arn} from session.json`);
        return;
      }
      // Dead task. The workspace dir on EFS is durable — re-run a new
      // task pointing at the same SANDBOX_WORKSPACE_DIR so the previous
      // turn's files are still there.
      log.info(
        'sandbox',
        `[${threadKey}] persisted task ${persisted.task_arn} dead; re-running task with workspace ${persisted.workspace_path}`,
      );
      const task = await runTask(
        threadKey,
        persisted.sandbox_token,
        persisted.workspace_path,
      );
      const ready = await waitForTaskRunning(task.taskArn);
      const ip = await resolvePrivateIp(ready);
      if (!ip) throw new Error(`ecs reattach: no private IP for task ${task.taskArn}`);
      state.set(threadKey, {
        taskArn: task.taskArn,
        token: persisted.sandbox_token,
        workspacePath: persisted.workspace_path,
        privateIp: ip,
      });
      await saveSandbox(threadKey, {
        provider: 'ecs',
        task_arn: task.taskArn,
        workspace_path: persisted.workspace_path,
        sandbox_token: persisted.sandbox_token,
        private_ip: ip,
      });
      await waitForHealth(ip);
      log.info(
        'sandbox',
        `ecs task ${task.taskArn} ready — reattached workspace ${persisted.workspace_path}`,
      );
      return;
    }
  }

  // Fresh provision: derive workspace path + run a new task.
  const workspacePath = _workspacePathFor(threadKey);
  const sandboxToken = randomToken();
  const task = await runTask(threadKey, sandboxToken, workspacePath);
  const ready = await waitForTaskRunning(task.taskArn);
  const ip = await resolvePrivateIp(ready);
  if (!ip) throw new Error(`ecs ensure: no private IP for task ${task.taskArn}`);
  state.set(threadKey, {
    taskArn: task.taskArn,
    token: sandboxToken,
    workspacePath,
    privateIp: ip,
  });
  await saveSandbox(threadKey, {
    provider: 'ecs',
    task_arn: task.taskArn,
    workspace_path: workspacePath,
    sandbox_token: sandboxToken,
    private_ip: ip,
  });
  await waitForHealth(ip);
  log.info(
    'sandbox',
    `ecs task ${task.taskArn} ready (workspace ${workspacePath}, ip ${ip})`,
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
          workspacePath: persisted.workspace_path,
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
  // Persisted record carries the task ARN even if the in-memory cache
  // is empty (e.g. bot restart between ensure and remove). The
  // workspace directory on EFS is NOT cleaned up here — orphan dirs
  // accumulate until a future explicit sweep (see #218 spec, "Out of
  // scope").
  const persisted = await loadSandbox(threadKey);
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
}

type ListTasksResp = { taskArns?: string[] };

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
  // No access-point listing — workspace dirs on the shared EFS root
  // aren't AWS resources, just files. Orphan reap leaves them in
  // place (deferred cleanup).
  return out;
}

async function destroyById(id: string): Promise<void> {
  // ECS task ARNs are the only resource kind we manage. Anything that
  // looks like an ECS ARN gets StopTask'd; anything else is logged
  // and ignored.
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
