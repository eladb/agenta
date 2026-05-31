// Where this bot is (or will be) deployed. Read from AGENTA_DEPLOY_TARGET
// at canary / deploy time so a single image can run on either Fly or ECS.
//
//   fly   — Fly Machines (this repo's default; CD path)
//   ecs   — AWS ECS Fargate (customer-owned pipelines, see infra/ecs/)
//
// The bot process itself doesn't branch on this — `src/sandbox/fly.ts` is
// still the only sandbox provider used in production regardless of target.
// The split matters for ops tooling (canary, deploy script) that needs to
// poll the control plane to confirm a rollout converged.

export type DeployTarget = 'fly' | 'ecs';

const VALID: readonly DeployTarget[] = ['fly', 'ecs'] as const;

export function resolveDeployTarget(
  env: Record<string, string | undefined> = process.env,
): DeployTarget {
  const raw = env.AGENTA_DEPLOY_TARGET;
  if (raw === undefined || raw === '') return 'fly';
  if ((VALID as readonly string[]).includes(raw)) return raw as DeployTarget;
  throw new Error(
    `AGENTA_DEPLOY_TARGET must be one of ${VALID.join(' | ')}, got: ${JSON.stringify(raw)}`,
  );
}
