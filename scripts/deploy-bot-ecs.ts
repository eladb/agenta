#!/usr/bin/env bun
// (Re)deploys the agenta bot to Amazon ECS Fargate.
//
//   bun scripts/deploy-bot-ecs.ts
//
// Mirror of scripts/deploy-bot-fly.ts for the AWS deploy target (phase 1
// of issue #208). Assumes the CloudFormation stack from infra/ecs/ is
// already deployed (creates the ECR repo, ECS cluster/service, EFS, IAM,
// CWL log group) AND the SSM SecureString parameters under the stack's
// prefix are populated. See infra/ecs/README.md for the bootstrap.
//
// Steps (idempotent):
//   1. Verify aws + docker on PATH; resolve AWS account + region.
//   2. Read the current task-def for AGENTA_ECS_SERVICE so we can clone it.
//   3. `aws ecr get-login-password | docker login` against the account's ECR.
//   4. Build the Dockerfile at the repo root and `docker push` to
//      <account>.dkr.ecr.<region>.amazonaws.com/<repo>:<tag>.
//   5. Register a new task-def revision identical to the current one
//      except for the bot container's image tag.
//   6. `aws ecs update-service --force-new-deployment` pointing at the
//      new revision.
//   7. Poll `aws ecs describe-services` until the primary deployment
//      reports rolloutState=COMPLETED with runningCount=desiredCount and
//      no pending/failed tasks. Failing tasks dump the deployment events.
//
// Required env:
//   AGENTA_ECS_CLUSTER  - ECS cluster name (default: agenta-bot)
//   AGENTA_ECS_SERVICE  - ECS service name (default: agenta-bot)
//
// Optional env:
//   AGENTA_ECR_REPOSITORY  - ECR repo name (default: agenta-bot)
//   AGENTA_ECS_IMAGE_TAG   - Image tag (default: git short SHA, or 'latest')
//   AWS_REGION             - AWS region (falls back to the CLI's default profile)
//
// Plain Bun — no @aws-sdk. Shells out to `aws` + `docker` like canary does.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');

const CLUSTER = process.env.AGENTA_ECS_CLUSTER ?? 'agenta-bot';
const SERVICE = process.env.AGENTA_ECS_SERVICE ?? 'agenta-bot';
const REPO = process.env.AGENTA_ECR_REPOSITORY ?? 'agenta-bot';

const ROLLOUT_TIMEOUT_MS = 15 * 60_000;
const POLL_INTERVAL_MS = 10_000;

type Result = { ok: boolean; status: number | null; stdout: string; stderr: string };

function run(cmd: string, args: string[], opts: { cwd?: string; capture?: boolean } = {}): Result {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : ['inherit', 'inherit', 'inherit'],
    cwd: opts.cwd,
  });
  return { ok: r.status === 0, status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function die(msg: string): never {
  console.error(`\nERROR: ${msg}\n`);
  process.exit(1);
}

function awsJson<T>(args: string[], context: string): T {
  const r = run('aws', [...args, '--output', 'json'], { capture: true });
  if (!r.ok) die(`${context} failed:\n${r.stderr.trim() || r.stdout.trim()}`);
  try {
    return JSON.parse(r.stdout) as T;
  } catch (err) {
    die(`${context}: could not parse JSON output: ${(err as Error).message}\n${r.stdout}`);
  }
}

// 1. Tooling + account/region.
if (run('aws', ['--version'], { capture: true }).status !== 0) {
  die(
    'aws CLI not found on PATH. Install: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html',
  );
}
if (run('docker', ['version', '--format', '{{.Server.Version}}'], { capture: true }).status !== 0) {
  die('docker not found on PATH or daemon not running.');
}

const caller = awsJson<{ Account: string }>(
  ['sts', 'get-caller-identity'],
  'aws sts get-caller-identity',
);
const region =
  process.env.AWS_REGION ??
  run('aws', ['configure', 'get', 'region'], { capture: true }).stdout.trim();
if (!region) die('AWS_REGION is not set and `aws configure get region` returned nothing.');
console.log(`✓ aws account=${caller.Account} region=${region}`);

// 2. Resolve the image tag.
function resolveTag(): string {
  if (process.env.AGENTA_ECS_IMAGE_TAG) return process.env.AGENTA_ECS_IMAGE_TAG;
  const sha = run('git', ['rev-parse', '--short', 'HEAD'], { capture: true });
  if (sha.ok && sha.stdout.trim()) return sha.stdout.trim();
  return 'latest';
}
const TAG = resolveTag();
const REGISTRY = `${caller.Account}.dkr.ecr.${region}.amazonaws.com`;
const IMAGE = `${REGISTRY}/${REPO}:${TAG}`;
console.log(`→ image: ${IMAGE}`);

// 3. Fetch the current service + its task-definition (we'll clone it with
//    a new image tag in step 5).
type ServiceShape = {
  services?: Array<{
    serviceName: string;
    taskDefinition: string;
    desiredCount: number;
  }>;
};
const svcWrap = awsJson<ServiceShape>(
  ['ecs', 'describe-services', '--cluster', CLUSTER, '--services', SERVICE],
  'aws ecs describe-services',
);
const svc = svcWrap.services?.[0];
if (!svc)
  die(`service ${SERVICE} not found in cluster ${CLUSTER}; did you run the CloudFormation stack?`);
console.log(
  `✓ service ${svc.serviceName} (desired=${svc.desiredCount}) currently on ${svc.taskDefinition}`,
);

type TaskDefShape = {
  taskDefinition: {
    family: string;
    taskRoleArn?: string;
    executionRoleArn?: string;
    networkMode?: string;
    containerDefinitions: Array<Record<string, unknown> & { name: string; image: string }>;
    volumes?: unknown;
    placementConstraints?: unknown;
    requiresCompatibilities?: unknown;
    cpu?: string;
    memory?: string;
    runtimePlatform?: unknown;
    ephemeralStorage?: unknown;
  };
};
const tdWrap = awsJson<TaskDefShape>(
  ['ecs', 'describe-task-definition', '--task-definition', svc.taskDefinition],
  'aws ecs describe-task-definition',
);
const td = tdWrap.taskDefinition;

// 4. ECR login + build + push.
console.log(`→ ecr login: ${REGISTRY}`);
const pw = run('aws', ['ecr', 'get-login-password', '--region', region], { capture: true });
if (!pw.ok) die(`aws ecr get-login-password failed:\n${pw.stderr}`);
const login = spawnSync('docker', ['login', '--username', 'AWS', '--password-stdin', REGISTRY], {
  input: pw.stdout,
  stdio: ['pipe', 'inherit', 'inherit'],
});
if (login.status !== 0) die('docker login against ECR failed');

console.log(`→ docker build → ${IMAGE}`);
const build = run('docker', ['build', '-t', IMAGE, REPO_ROOT]);
if (!build.ok) die('docker build failed (see output above)');

console.log(`→ docker push ${IMAGE}`);
const push = run('docker', ['push', IMAGE]);
if (!push.ok) die('docker push failed (see output above)');

// Also push the same image as `:latest`. CFN's template-managed
// task-def pins `${EcrRepositoryName}:latest` by default; without this
// step, the next `aws cloudformation deploy` would re-render the
// task-def and point the service at a non-existent `:latest` tag,
// triggering CannotPullContainerError (see agenta #211). Keeping
// :latest == "the most recently deployed SHA" means CFN updates and
// SHA-pinned deploys stay consistent.
const LATEST_IMAGE = `${REGISTRY}/${REPO}:latest`;
if (TAG !== 'latest') {
  console.log(`→ docker tag ${IMAGE} ${LATEST_IMAGE}`);
  const tagLatest = run('docker', ['tag', IMAGE, LATEST_IMAGE]);
  if (!tagLatest.ok) die('docker tag :latest failed (see output above)');
  console.log(`→ docker push ${LATEST_IMAGE}`);
  const pushLatest = run('docker', ['push', LATEST_IMAGE]);
  if (!pushLatest.ok) die('docker push :latest failed (see output above)');
}

// 5. Register a new task-def revision: same as current, image tag swapped.
// Note: the registered revision pins the SHA tag (IMAGE) -- :latest is
// only here so CFN-managed re-renders don't break the service.
const newContainers = td.containerDefinitions.map((c) => {
  if (c.name === 'bot') return { ...c, image: IMAGE };
  return c;
});
// register-task-definition accepts only the "input" subset, not the full
// describe output (which includes status, revision, etc.). Whitelist.
const registerInput: Record<string, unknown> = {
  family: td.family,
  containerDefinitions: newContainers,
};
if (td.taskRoleArn) registerInput.taskRoleArn = td.taskRoleArn;
if (td.executionRoleArn) registerInput.executionRoleArn = td.executionRoleArn;
if (td.networkMode) registerInput.networkMode = td.networkMode;
if (td.volumes) registerInput.volumes = td.volumes;
if (td.placementConstraints) registerInput.placementConstraints = td.placementConstraints;
if (td.requiresCompatibilities) registerInput.requiresCompatibilities = td.requiresCompatibilities;
if (td.cpu) registerInput.cpu = td.cpu;
if (td.memory) registerInput.memory = td.memory;
if (td.runtimePlatform) registerInput.runtimePlatform = td.runtimePlatform;
if (td.ephemeralStorage) registerInput.ephemeralStorage = td.ephemeralStorage;

const tmp = `/tmp/agenta-ecs-taskdef-${Date.now()}.json`;
await Bun.write(tmp, JSON.stringify(registerInput, null, 2));

const reg = awsJson<{ taskDefinition: { taskDefinitionArn: string } }>(
  ['ecs', 'register-task-definition', '--cli-input-json', `file://${tmp}`],
  'aws ecs register-task-definition',
);
const newTdArn = reg.taskDefinition.taskDefinitionArn;
console.log(`✓ registered ${newTdArn}`);

// 6. Update the service to the new revision + force a rolling deploy.
console.log(`→ updating service ${SERVICE} → ${newTdArn} (force-new-deployment)`);
const upd = run(
  'aws',
  [
    'ecs',
    'update-service',
    '--cluster',
    CLUSTER,
    '--service',
    SERVICE,
    '--task-definition',
    newTdArn,
    '--force-new-deployment',
  ],
  { capture: true },
);
if (!upd.ok) die(`aws ecs update-service failed:\n${upd.stderr}`);

// 7. Wait for rollout.
type DescribeShape = {
  services?: Array<{
    desiredCount?: number;
    runningCount?: number;
    pendingCount?: number;
    deployments?: Array<{
      id?: string;
      status?: string;
      rolloutState?: string;
      rolloutStateReason?: string;
      desiredCount?: number;
      runningCount?: number;
      pendingCount?: number;
      failedTasks?: number;
      taskDefinition?: string;
    }>;
    events?: Array<{ createdAt?: string; message?: string }>;
  }>;
};

function summarize(svc: NonNullable<DescribeShape['services']>[number]): string {
  const primary = (svc.deployments ?? []).find((d) => d.status === 'PRIMARY');
  return (
    `desired=${svc.desiredCount ?? '?'} running=${svc.runningCount ?? '?'} ` +
    `pending=${svc.pendingCount ?? '?'} ` +
    `primary=${primary?.rolloutState ?? 'none'}(running=${primary?.runningCount ?? '?'}, failed=${
      primary?.failedTasks ?? 0
    })`
  );
}

console.log(`→ waiting up to ${ROLLOUT_TIMEOUT_MS / 1000}s for rollout to complete…`);
const deadline = Date.now() + ROLLOUT_TIMEOUT_MS;
let lastSvc: NonNullable<DescribeShape['services']>[number] | undefined;
let lastSummary = '';
while (Date.now() < deadline) {
  const out = awsJson<DescribeShape>(
    ['ecs', 'describe-services', '--cluster', CLUSTER, '--services', SERVICE],
    'aws ecs describe-services',
  );
  const s = out.services?.[0];
  if (!s) die(`service ${SERVICE} disappeared mid-rollout`);
  lastSvc = s;
  const primary = (s.deployments ?? []).find((d) => d.status === 'PRIMARY');
  const summary = summarize(s);
  if (summary !== lastSummary) {
    console.log(`  · ${summary}`);
    lastSummary = summary;
  }
  if (primary?.rolloutState === 'FAILED') {
    console.error('\nDeployment FAILED. Recent events:');
    for (const ev of (s.events ?? []).slice(0, 15)) {
      console.error(`  [${ev.createdAt}] ${ev.message}`);
    }
    die(`primary deployment rolloutState=FAILED: ${primary.rolloutStateReason ?? '<no reason>'}`);
  }
  const ok =
    primary?.rolloutState === 'COMPLETED' &&
    s.runningCount === s.desiredCount &&
    (s.pendingCount ?? 0) === 0 &&
    (primary?.failedTasks ?? 0) === 0;
  if (ok) {
    console.log(`\n✓ rollout complete: ${summary}`);
    console.log(`✓ bot deployed to ECS service ${CLUSTER}/${SERVICE}`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
}

console.error('\nRollout did not converge in time. Recent events:');
for (const ev of (lastSvc?.events ?? []).slice(0, 15)) {
  console.error(`  [${ev.createdAt}] ${ev.message}`);
}
die(`rollout timed out after ${ROLLOUT_TIMEOUT_MS}ms; last=${lastSummary}`);
