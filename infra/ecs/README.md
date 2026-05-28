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

Stack outputs include `EcrRepositoryUri`, `EfsFileSystemId`, and `SsmParameterPrefix` (default `/agenta-bot`). Override any of `ClusterName`, `ServiceName`, `EcrRepositoryName`, `LogGroupName`, `SsmParameterPrefix`, `AgentaSandboxApp`, `FlyRegion`, `TaskCpu`, `TaskMemory`, `ImageTag`, or `DesiredCount` via `--parameter-overrides` per deployment. For an ECS-sandbox deployment (phase 2, below) also override `SandboxProvider` (default `fly`; set `ecs`), `EcsSandboxCluster`, `EcsSandboxSubnetIds`, `EcsSandboxSecurityGroupIds`, and `EcsSandboxTaskFamily` (#220).

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

## Sandboxes (phase 2, agenta #213)

The bot stack above runs the bot itself; per-thread sandboxes are a separate plane. Phase 1 had the ECS-resident bot still provision sandboxes against Fly. Phase 2 (`SANDBOX_PROVIDER=ecs`) finishes the AWS-native deployment: per-thread sandboxes run as Fargate tasks in the same VPC as the bot, reached over private IP on port 9000.

**Bot ⇄ sandbox pairing is locked**: an ECS bot uses ECS sandboxes, a Fly bot uses Fly sandboxes. No cross-cloud configurations. The bot's `SANDBOX_PROVIDER` env var is the only knob.

Routing direction: the bot is the WebSocket client; the sandbox is the WebSocket server. The bot dials `http://<sandbox-task-private-ip>:9000` for the HTTP API and `ws://<sandbox-task-private-ip>:9000/tunnel` for the git tunnel. No public DNS, no ALB, no Cloud Map — just in-VPC private IP. The sandbox SG opens port 9000 from the bot SG only.

### Cost note

Fargate has no native auto-stop on idle: each per-thread sandbox runs continuously at ~$8.50/mo (1 vCPU, 2 GB) until `/delete`. Fly machines auto-stop after a few minutes of idle and bill ~$2–5/mo per active thread. ECS sandboxes trade higher idle cost for in-VPC routing simplicity and the absence of Fly as a dependency.

### One-time bootstrap (sandbox plane)

1. **Deploy the sandbox CloudFormation stack.** Pair it with the bot stack — both must live in the same VPC. The `BotSecurityGroupId` parameter is the `TaskSecurityGroup` from the bot stack (visible as `aws cloudformation describe-stack-resources --stack-name agenta-bot --logical-resource-id TaskSecurityGroup`).

   ```sh
   aws cloudformation deploy \
     --stack-name agenta-sandbox \
     --template-file infra/ecs/sandbox-cloudformation.yaml \
     --capabilities CAPABILITY_IAM \
     --parameter-overrides \
       VpcId=vpc-xxxxxxxx \
       SubnetIds=subnet-aaaaaaaa,subnet-bbbbbbbb \
       BotSecurityGroupId=sg-xxxxxxxx
   ```

   Stack outputs include `ClusterName`, `EcrRepositoryUri`, `EfsFileSystemId`, `SandboxSecurityGroupId`, `TaskFamily`, `LogGroupName`. Each maps to one of the env vars the bot reads at boot:

   | Stack output | Bot env var |
   |---|---|
   | `ClusterName` | `AGENTA_ECS_SANDBOX_CLUSTER` |
   | `SandboxSecurityGroupId` | `AGENTA_ECS_SANDBOX_SECURITY_GROUP_IDS` (comma-list if you want multiple) |
   | (the subnets you passed) | `AGENTA_ECS_SANDBOX_SUBNET_IDS` |
   | `TaskFamily` | `AGENTA_ECS_SANDBOX_TASK_FAMILY` (optional, defaults to `agenta-sandbox`) |

   The `EfsFileSystemId` output is no longer wired into a bot env var (#218 — the task definition hard-codes the filesystem in its `volumes:` block). It's still exported for operator visibility.

2. **Push the sandbox image.**

   ```sh
   bun scripts/deploy-sandbox-ecs.ts
   ```

   Builds the `sandbox/` Dockerfile (note: build context is `sandbox/`, not the repo root) and pushes both `<sha>` and `:latest` tags. Idempotent — same script for first deploy and per-deploy refreshes. Required env: AWS credentials. Optional env: `AGENTA_ECS_SANDBOX_REPOSITORY`, `AGENTA_ECS_SANDBOX_CLUSTER`, `AGENTA_ECS_SANDBOX_IMAGE_TAG`, `AWS_REGION`.

   There is no service to roll: the bot creates per-thread tasks on demand via `ecs run-task`. The image change takes effect on the next per-thread sandbox provision.

3. **Switch the bot to ECS sandboxes.** The bot stack template (`infra/ecs/cloudformation.yaml`) exposes the provider choice and the four sandbox coordinates as CloudFormation parameters (#220). Re-deploy the bot stack with the phase-2 overrides:

   ```sh
   aws cloudformation deploy \
     --stack-name agenta-bot \
     --template-file infra/ecs/cloudformation.yaml \
     --capabilities CAPABILITY_IAM \
     --parameter-overrides \
       VpcId=vpc-xxxxxxxx \
       PublicSubnetIds=subnet-aaaaaaaa \
       DesiredCount=1 \
       SandboxProvider=ecs \
       EcsSandboxCluster=agenta-sandbox \
       EcsSandboxSubnetIds=subnet-aaaaaaaa \
       EcsSandboxSecurityGroupIds=sg-xxxxxxxx \
       EcsSandboxTaskFamily=agenta-sandbox
   ```

   `SandboxProvider` defaults to `fly`; the four `AGENTA_ECS_SANDBOX_*` env entries always render (harmless empty strings while `SandboxProvider=fly`, since the bot only reads them when `=ecs`). **Pass these overrides on every subsequent `cloudformation deploy` of an ECS-sandbox stack** — omitting them resets `SandboxProvider` to `fly` and the bot silently reverts to Fly sandboxes. Updating the template-managed task definition rolls the service automatically; no separate `--force-new-deployment` is needed.

### What gets created per thread

- One `aws ecs run-task` in the sandbox cluster (one Fargate task per thread, tagged with `agenta_bot_instance=<ClusterName>` for safe scoping).
- One subdirectory on the shared EFS filesystem at `/efs/<thread-slug>`, mkdir+chowned by the sandbox entrypoint when it sees `SANDBOX_WORKSPACE_DIR` in its environment.

The task definition mounts the EFS root at `/efs`; per-thread isolation is the subdirectory the bot picks at RunTask time and passes via `SANDBOX_WORKSPACE_DIR` in `containerOverrides`. There are no per-thread EFS access points (the #213 design tried that and ran into `--volume-configurations` being EBS-only — see #218 for the full story).

Tear-down via `/delete` in Slack does `aws ecs stop-task`. The workspace directory on EFS is left in place — orphan dirs accumulate until a future explicit sweep (deferred from #218; expected to be either a periodic cleaner or an `rm -rf /efs/<slug>` step in the `/delete` path). The boot-time orphan reap (`src/sandbox/index.ts:reapOrphanSandboxes`) walks tasks by tag and stops anything not referenced by a `session.json` record; it does NOT touch workspace dirs.

### Operator must add (deferred from the sandbox stack)

- The **bot stack's task SG** already has wide egress, so no ingress change is required on the bot side — the WS direction is bot → sandbox, not the other way around.
- If you want sandbox tasks to egress for `pip install` / `git clone` / model gateway calls, they reach the internet via their own public IP: the provider assigns one by default (`AGENTA_ECS_SANDBOX_ASSIGN_PUBLIC_IP=ENABLED`, #220), matching the bot's own no-NAT design, so a public subnet needs no NAT Gateway or VPC endpoints. Set that env var to `DISABLED` only if you run sandbox tasks in private subnets fronted by a NAT Gateway / VPC endpoints (a VPC-shape concern the sandbox stack doesn't manage). Either way the sandbox SG still blocks all inbound except port 9000 from the bot SG.

## Open items (see issue #213 and beyond)

- A second CD path in this repo (separate workflow, separate Slack app for canary).
- Auto-stop / idle scale-to-zero for sandbox tasks (Fargate has no native equivalent of Fly machine auto-stop).
