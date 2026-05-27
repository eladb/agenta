#!/usr/bin/env bun
// Builds + pushes the agenta sandbox image to ECR for use by the ECS
// sandbox provider (agenta #213).
//
//   bun scripts/deploy-sandbox-ecs.ts
//
// Analog of scripts/deploy-sandbox-fly.sh and scripts/deploy-bot-ecs.ts.
// Assumes infra/ecs/sandbox-cloudformation.yaml is already deployed --
// it creates the ECR repo, ECS cluster, EFS, IAM, log group, and a
// pre-registered task definition. This script does NOT touch the
// task definition: per-thread customizations (env, EFS access point)
// land at RunTask time via the provider's `--overrides` /
// `--volume-configurations`. There is no service to roll -- the bot
// starts tasks on demand.
//
// Steps (idempotent):
//   1. Verify aws + docker on PATH; resolve AWS account + region.
//   2. `aws ecr get-login-password | docker login` against the account's ECR.
//   3. Build sandbox/Dockerfile (build context = sandbox/, NOT repo root)
//      and `docker push` to <account>.dkr.ecr.<region>.amazonaws.com/<repo>:<tag>.
//   4. Also push the same image as `:latest` so the template-managed
//      task definition keeps resolving (mirror of deploy-bot-ecs.ts #211).
//
// Required env:
//   (nothing -- AWS credentials are resolved via the standard chain)
//
// Optional env:
//   AGENTA_ECS_SANDBOX_REPOSITORY  - ECR repo name (default: agenta-sandbox)
//   AGENTA_ECS_SANDBOX_CLUSTER     - sanity-checked against the running stack (default: agenta-sandbox)
//   AGENTA_ECS_SANDBOX_IMAGE_TAG   - image tag (default: git short SHA, or 'latest')
//   AWS_REGION                     - AWS region (falls back to CLI's configured region)
//
// Plain Bun -- no @aws-sdk. Shells out to `aws` + `docker` like the
// other deploy scripts.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');
const SANDBOX_DIR = join(REPO_ROOT, 'sandbox');

const REPO = process.env.AGENTA_ECS_SANDBOX_REPOSITORY ?? 'agenta-sandbox';
const CLUSTER = process.env.AGENTA_ECS_SANDBOX_CLUSTER ?? 'agenta-sandbox';

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

// Sanity check: the sandbox cluster exists. If not, the operator forgot
// to deploy the CFN stack first -- bail with a useful hint instead of a
// cryptic ECR error later.
type DescribeClustersResp = { clusters?: Array<{ clusterName?: string; status?: string }> };
const cluster = awsJson<DescribeClustersResp>(
  ['ecs', 'describe-clusters', '--clusters', CLUSTER],
  'aws ecs describe-clusters',
);
const c = cluster.clusters?.[0];
if (!c || c.status !== 'ACTIVE') {
  die(
    `ECS cluster ${CLUSTER} not found (or not ACTIVE). Deploy infra/ecs/sandbox-cloudformation.yaml first:\n` +
      `  aws cloudformation deploy --stack-name agenta-sandbox \\\n` +
      `    --template-file infra/ecs/sandbox-cloudformation.yaml \\\n` +
      `    --capabilities CAPABILITY_IAM \\\n` +
      `    --parameter-overrides VpcId=... SubnetIds=... BotSecurityGroupId=sg-...`,
  );
}
console.log(`✓ sandbox cluster ${CLUSTER} ACTIVE`);

// 2. Resolve the image tag.
function resolveTag(): string {
  if (process.env.AGENTA_ECS_SANDBOX_IMAGE_TAG) return process.env.AGENTA_ECS_SANDBOX_IMAGE_TAG;
  const sha = run('git', ['rev-parse', '--short', 'HEAD'], { capture: true });
  if (sha.ok && sha.stdout.trim()) return sha.stdout.trim();
  return 'latest';
}
const TAG = resolveTag();
const REGISTRY = `${caller.Account}.dkr.ecr.${region}.amazonaws.com`;
const IMAGE = `${REGISTRY}/${REPO}:${TAG}`;
const LATEST_IMAGE = `${REGISTRY}/${REPO}:latest`;
console.log(`→ image: ${IMAGE}`);

// 3. ECR login + build + push.
console.log(`→ ecr login: ${REGISTRY}`);
const pw = run('aws', ['ecr', 'get-login-password', '--region', region], { capture: true });
if (!pw.ok) die(`aws ecr get-login-password failed:\n${pw.stderr}`);
const login = spawnSync('docker', ['login', '--username', 'AWS', '--password-stdin', REGISTRY], {
  input: pw.stdout,
  stdio: ['pipe', 'inherit', 'inherit'],
});
if (login.status !== 0) die('docker login against ECR failed');

// NB: build context is sandbox/, NOT REPO_ROOT. The sandbox Dockerfile
// COPYs sandbox/server/ + sandbox/entrypoint.sh into the image.
console.log(`→ docker build → ${IMAGE} (context: ${SANDBOX_DIR})`);
const build = run('docker', ['build', '-t', IMAGE, SANDBOX_DIR]);
if (!build.ok) die('docker build failed (see output above)');

console.log(`→ docker push ${IMAGE}`);
const push = run('docker', ['push', IMAGE]);
if (!push.ok) die('docker push failed (see output above)');

// Also push :latest -- the CFN template pins :latest by default and
// will silently break if it's missing on a stack re-render. Mirrors
// the deploy-bot-ecs.ts fix from #211.
if (TAG !== 'latest') {
  console.log(`→ docker tag ${IMAGE} ${LATEST_IMAGE}`);
  const tagLatest = run('docker', ['tag', IMAGE, LATEST_IMAGE]);
  if (!tagLatest.ok) die('docker tag :latest failed (see output above)');
  console.log(`→ docker push ${LATEST_IMAGE}`);
  const pushLatest = run('docker', ['push', LATEST_IMAGE]);
  if (!pushLatest.ok) die('docker push :latest failed (see output above)');
}

console.log(`\n✓ sandbox image pushed to ${IMAGE}`);
console.log(
  `  Bot will pull this image on the next per-thread RunTask. No service to roll.`,
);
