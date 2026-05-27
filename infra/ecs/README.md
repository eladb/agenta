# agenta bot on Amazon ECS Fargate

Phase 1 (per [issue #208](https://github.com/eladb/agenta/issues/208)) of running the bot on AWS as a second deployment target alongside Fly. This directory is the deployment artifact; nothing in this repo's CD wires it — a customer drives ECS deploys from their own pipeline.

Phase 1 scope:

- Bot only. Sandboxes still provision on Fly (the ECS-resident bot dials out to `api.machines.dev` from AWS — outbound HTTPS, works as-is).
- Single Fargate task, public subnet + public IP, no NAT, no ALB. EFS for `/data`.
- Secrets in SSM Parameter Store (`SecureString`), injected via the task definition.
- No second CD path. The customer runs `bun scripts/deploy-bot-ecs.ts` from their own pipeline / laptop.

## One-time bootstrap

You'll need:

- An AWS account with the AWS CLI configured (`aws sts get-caller-identity` works).
- A VPC + at least one public subnet (with an IGW route). The default VPC in any region works.
- Bun, Docker, and access to push to the ECR repo this stack creates.
- A separate Slack app for this deployment (see _Customer-side concerns_ below).

### 1. Deploy the CloudFormation stack

```sh
aws cloudformation deploy \
  --stack-name agenta-bot \
  --template-file infra/ecs/cloudformation.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    VpcId=vpc-xxxxxxxx \
    PublicSubnetIds=subnet-aaaaaaaa
```

Stack outputs include `EcrRepositoryUri`, `EfsFileSystemId`, and `SsmParameterPrefix` (default `/agenta-bot`). Override any of `ClusterName`, `ServiceName`, `EcrRepositoryName`, `LogGroupName`, `SsmParameterPrefix`, `AgentaSandboxApp`, `FlyRegion`, `TaskCpu`, `TaskMemory`, or `ImageTag` via `--parameter-overrides` per deployment.

The first deploy will fail to start the task because:

1. The ECR repo is empty (`scripts/deploy-bot-ecs.ts` hasn't pushed yet).
2. SSM parameters don't exist yet.

That's fine — proceed to steps 2 and 3.

### 2. Populate SSM parameters

Every entry in the task definition's `secrets:` block must exist as a `SecureString` parameter at `<SsmParameterPrefix>/<NAME>` BEFORE the task can start. With the default prefix `/agenta-bot`:

```sh
PREFIX=/agenta-bot
aws ssm put-parameter --type SecureString --name $PREFIX/SLACK_APP_TOKEN --value 'xapp-...'
aws ssm put-parameter --type SecureString --name $PREFIX/SLACK_BOT_TOKEN --value 'xoxb-...'
aws ssm put-parameter --type SecureString --name $PREFIX/MODEL_API_KEY --value '...'
aws ssm put-parameter --type SecureString --name $PREFIX/MODEL_BASE_URL --value 'https://api.anthropic.com/v1'
aws ssm put-parameter --type SecureString --name $PREFIX/MODEL_NAME --value 'claude-sonnet-4-6'
aws ssm put-parameter --type SecureString --name $PREFIX/GITHUB_TOKEN --value 'github_pat_...'
aws ssm put-parameter --type SecureString --name $PREFIX/SALTO_API_TOKEN --value '...'
aws ssm put-parameter --type SecureString --name $PREFIX/AGENTA_TEST_HOME_ALONE_DEPLOY_KEY --value "$(cat deploy-key.pem)"
aws ssm put-parameter --type SecureString --name $PREFIX/FLY_API_TOKEN --value 'FlyV1 fm2_...'
```

`FLY_API_TOKEN` is required even on ECS — sandboxes still run on Fly. Generate the token with `flyctl tokens create deploy -a <sandbox-app>`.

Customer-specific parameters: if you've forked `config/homes.json` to point at your own home repos, swap the auth env names accordingly and `put-parameter` the matching secrets.

### 3. Push the initial image

```sh
bun scripts/deploy-bot-ecs.ts
```

The script logs into ECR, builds the Dockerfile at the repo root, pushes to `<account>.dkr.ecr.<region>.amazonaws.com/agenta-bot:<tag>`, registers a new task-def revision pinning that tag, then `force-new-deployment` and polls `DescribeServices` until the rollout converges. Required env: `AGENTA_ECS_CLUSTER`, `AGENTA_ECS_SERVICE` (match the stack's `ClusterName` / `ServiceName`), and the usual AWS CLI credentials. Optional: `AGENTA_ECR_REPOSITORY` (defaults to `agenta-bot`), `AGENTA_ECS_IMAGE_TAG` (defaults to git SHA), `AWS_REGION`.

## Per-deploy steps

After the initial bootstrap, day-to-day deploys are:

```sh
bun scripts/deploy-bot-ecs.ts
```

The same script is idempotent — it builds, pushes, registers, and rolls. Use `AGENTA_ECS_IMAGE_TAG` to pin to a specific tag rather than the auto-derived git SHA.

## Smoke test

```sh
AGENTA_DEPLOY_TARGET=ecs \
AGENTA_ECS_CLUSTER=agenta-bot \
AGENTA_ECS_SERVICE=agenta-bot \
TEST_APP_TOKEN=xapp-... TEST_BOT_TOKEN=xoxb-... \
CANARY_TARGET_USER_ID=U... TEST_CHANNEL_ID=C... \
bun run canary
```

The canary's pre-flight branches on `AGENTA_DEPLOY_TARGET`: `fly` (default) polls the Fly Machines API, `ecs` polls `aws ecs describe-services` and waits for `runningCount=1` + primary deployment `rolloutState=COMPLETED`. After that it runs the same three Slack steps it always has (chat → bash → /delete).

## What stays on Fly

- All per-thread sandboxes (`SANDBOX_PROVIDER=fly`, `agenta-sandbox` app).
- The household / dev bot deployment (`agenta-bot` Fly app, this repo's `fly.toml` + CD).

The `Dockerfile`, `src/`, and `config/` build the same image artifact for both targets. Only `infra/ecs/` and `scripts/deploy-bot-ecs.ts` are ECS-specific.

## Customer-side concerns (not implemented in phase 1)

- **Separate Slack app.** Don't reuse the household's bot tokens. Bootstrap a new app via `SLACK_CONFIG_ACCESS_TOKEN=... bun run setup --app-name <your-bot>` (config token generated at <https://api.slack.com/apps>), install into the customer workspace, mint an `xapp-` for Socket Mode, then `put-parameter` the credentials into SSM.
- **Customer-specific `config/homes.json`.** The committed config points at `eladb/agenta-test-home`. Most customer deployments will fork the repo (or maintain a private overlay) so `config/homes.json` and `slack-manifests/<bot>.json` point at customer-owned remotes.
- **Secrets migration.** If you're moving from a Fly deployment, dump Fly secrets and replay them into SSM — there's no automatic sync.
- **`debug-thread` skill.** The skill in `.claude/skills/debug-thread/` currently uses `flyctl ssh console` to read JSONL off the bot's volume. It'll need an `aws ecs execute-command` variant before the customer's ECS deployment is operationally debuggable from a Slack permalink. Phase 1 explicitly defers this.

## Open phase-2 items (see issue #208)

- A second CD path in this repo (separate workflow, separate Slack app for canary).
- An `ECS sandbox provider` (`src/sandbox/ecs.ts`) so customers who can't reach `api.machines.dev` from inside their VPC can run sandboxes locally on ECS as well.
