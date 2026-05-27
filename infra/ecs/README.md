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

The sequence below is deliberately ordered so every step succeeds on the first try against a brand-new AWS account — no "first deploy will fail, that's fine" hand-waving.

### 1. Deploy the CloudFormation stack with `DesiredCount=0`

```sh
aws cloudformation deploy \
  --stack-name agenta-bot \
  --template-file infra/ecs/cloudformation.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    VpcId=vpc-xxxxxxxx \
    PublicSubnetIds=subnet-aaaaaaaa \
    DesiredCount=0
```

`DesiredCount=0` is the template's default, so you can omit the override — listed here for clarity. The stack creates the ECR repo, EFS filesystem + mount target + access point, IAM roles, security groups, CloudWatch log group, ECS cluster, task definition, and service — but launches zero tasks. That avoids the ECR-empty / SSM-empty crashloop the service would otherwise hit.

Stack outputs include `EcrRepositoryUri`, `EfsFileSystemId`, and `SsmParameterPrefix` (default `/agenta-bot`). Override any of `ClusterName`, `ServiceName`, `EcrRepositoryName`, `LogGroupName`, `SsmParameterPrefix`, `AgentaSandboxApp`, `FlyRegion`, `TaskCpu`, `TaskMemory`, `ImageTag`, or `DesiredCount` via `--parameter-overrides` per deployment.

### 2. Populate SSM parameters

Every entry in the task definition's `secrets:` block must exist as a `SecureString` parameter at `<SsmParameterPrefix>/<NAME>` BEFORE the task can start. There are 12 entries; with the default prefix `/agenta-bot`:

```sh
PREFIX=/agenta-bot

# --- Slack (from the per-deployment Slack app; xapp- + xoxb-) ---
aws ssm put-parameter --type SecureString --name $PREFIX/SLACK_APP_TOKEN --value 'xapp-...'
aws ssm put-parameter --type SecureString --name $PREFIX/SLACK_BOT_TOKEN --value 'xoxb-...'

# --- Model gateway (default: Anthropic's OpenAI-compat endpoint) ---
aws ssm put-parameter --type SecureString --name $PREFIX/MODEL_API_KEY  --value 'sk-ant-...'
aws ssm put-parameter --type SecureString --name $PREFIX/MODEL_BASE_URL --value 'https://api.anthropic.com/v1'
aws ssm put-parameter --type SecureString --name $PREFIX/MODEL_NAME     --value 'claude-sonnet-4-6'

# Per-channel Bedrock override (referenced from config/homes.json by
# channels that pick a Bedrock model). Long-lived AWS Bedrock bearer
# token: `aws bedrock-runtime ...` style credentials.
aws ssm put-parameter --type SecureString --name $PREFIX/AWS_BEARER_TOKEN_BEDROCK --value 'bedrock-bearer-...'

# --- Home-repo auth (one entry per auth_env in config/homes.json) ---
# GITHUB_TOKEN: fine-grained PAT with read+write on the default home
# repo (HTTPS clone + push). Generate at github.com/settings/tokens.
aws ssm put-parameter --type SecureString --name $PREFIX/GITHUB_TOKEN --value 'github_pat_...'

# Deploy keys: per-repo SSH private key (PEM) for direct-mode home
# repos. The home repo's GitHub Settings -> Deploy keys page holds the
# matching public key with write access.
aws ssm put-parameter --type SecureString --name $PREFIX/AGENTA_TEST_HOME_ALONE_DEPLOY_KEY      --value "$(cat agenta-test-home-alone-deploy-key.pem)"
aws ssm put-parameter --type SecureString --name $PREFIX/SALTO_SALESFORCE_PLAYGROUND_DEPLOY_KEY --value "$(cat salto-sf-playground-deploy-key.pem)"

# --- Tool credentials ---
# salto_* tools shell out to `salto-cloud` on the bot host.
aws ssm put-parameter --type SecureString --name $PREFIX/SALTO_API_TOKEN --value '...'
# web_search tool hits the Tavily API.
aws ssm put-parameter --type SecureString --name $PREFIX/TAVILY_API_KEY  --value 'tvly-...'

# --- Sandbox provider: bot stays on Fly for per-thread sandboxes even
# when itself on ECS. `flyctl tokens create deploy -a <sandbox-app>`.
aws ssm put-parameter --type SecureString --name $PREFIX/FLY_API_TOKEN --value 'FlyV1 fm2_...'
```

If you've forked `config/homes.json` to point at your own home repos, swap the `*_DEPLOY_KEY` / `GITHUB_TOKEN` / `AWS_BEARER_TOKEN_BEDROCK` entries to match the `auth_env` names your config references — every value listed in any channel's `auth_env` must also be in the task definition's `secrets:` block AND in SSM.

### 3. Push the initial image

```sh
bun scripts/deploy-bot-ecs.ts
```

The script logs into ECR, builds the Dockerfile at the repo root, and pushes to `<account>.dkr.ecr.<region>.amazonaws.com/agenta-bot:<sha>` AND `:latest` (the SHA tag is what the task-def revision pins; the `:latest` tag exists so CFN-managed re-renders of the template-owned task-def don't break the service — see agenta #211). It then registers a new task-def revision pinning the SHA, calls `update-service --force-new-deployment`, and polls `DescribeServices` until the rollout converges. With `DesiredCount=0` the service just registers the new revision and idles — no task launches yet. Required env: `AGENTA_ECS_CLUSTER`, `AGENTA_ECS_SERVICE` (match the stack's `ClusterName` / `ServiceName`), and the usual AWS CLI credentials. Optional: `AGENTA_ECR_REPOSITORY` (defaults to `agenta-bot`), `AGENTA_ECS_IMAGE_TAG` (defaults to git SHA), `AWS_REGION`.

### 4. Scale the service to 1

```sh
aws ecs update-service \
  --cluster agenta-bot \
  --service agenta-bot \
  --desired-count 1
```

Or, to keep CloudFormation as the source of truth:

```sh
aws cloudformation deploy \
  --stack-name agenta-bot \
  --template-file infra/ecs/cloudformation.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    VpcId=vpc-xxxxxxxx \
    PublicSubnetIds=subnet-aaaaaaaa \
    DesiredCount=1
```

ECS pulls the image, mounts EFS, injects all 12 SSM parameters as env vars, and starts the bot. Confirm `aws ecs describe-services --cluster agenta-bot --services agenta-bot` shows `runningCount=1` and the primary deployment's `rolloutState=COMPLETED`. The bot connects to Slack Socket Mode within seconds; `aws logs tail /ecs/agenta-bot --follow` shows the startup banner.

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
