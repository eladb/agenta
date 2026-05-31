# Build image for the agenta single binary that runs in one of two roles
# (#253):
#
#   bot     — Slack ingress router; loads config/tenants.json, forwards to
#             per-tenant /events endpoints over HTTP. No /data writes.
#   tenant  — Agent harness; owns /data, sessions, sandboxes, model gateway,
#             home repos. Listens on HEALTH_PORT for /events + /health.
#
# Selector lives in /entrypoint.sh: first arg ('bot' or 'tenant') picks the
# role. CMD defaults to 'tenant' for backward compat with operators who
# pulled the image before the split — flipping a deployment to bot mode is
# a CMD/args change in fly.toml / the ECS task def.
#
# This is NOT the sandbox image — that's sandbox/Dockerfile, a separate
# build that runs inside the per-thread VMs the tenant provisions.
#
# Stages:
#   1. deps     - `bun install --production` so the runtime image carries
#                 only the prod dependency tree (no biome / @types / etc.).
#   2. runtime  - Debian-slim Bun + git + ca-certificates + python3 + the
#                 Salto CLI (tenant-only dep, harmless in bot mode).

FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

FROM oven/bun:1-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ca-certificates jq python3 openssh-client curl awscli \
 && rm -rf /var/lib/apt/lists/*

# Salto CLI on the tenant host (not the sandbox). The salto_* tools shell
# out to `salto-cloud` here, using SALTO_API_TOKEN from the tenant's env
# (Fly secret in prod). Pinned version — release shape is a single static
# ELF binary at the tarball root, extracted to /usr/local/bin. Harmless in
# bot mode (the bot never invokes it).
ARG SALTO_CLI_VERSION=1.4.4
RUN curl -fsSL "https://cli.salto.io/release/${SALTO_CLI_VERSION}/linux-x64.tar.gz" \
      | tar -xz -C /usr/local/bin \
 && chmod +x /usr/local/bin/salto-cloud \
 && /usr/local/bin/salto-cloud --version

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src
COPY git-hooks ./git-hooks
COPY config ./config
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh git-hooks/pre-receive git-hooks/post-receive

ENV NODE_ENV=production

# Container-level health check. Both roles serve /health on $HEALTH_PORT
# (default 8080): the bot returns 200 when Socket Mode is connected, the
# tenant returns 200 when its readiness latch is set.
#
# On Fly, fly.toml's [[checks]] takes precedence — Fly runs its own HTTP
# health checks against the same endpoint and uses those for routing /
# rollout decisions. This HEALTHCHECK is just container metadata to Fly.
# On ECS, this is the actual container-level health signal the service
# uses (set in the task definition's containerDefinitions.healthCheck).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS "http://localhost:${HEALTH_PORT:-8080}/health" || exit 1

ENTRYPOINT ["/entrypoint.sh"]
# Default role; override in fly.toml / ECS task def to flip a deployment
# to bot mode (`CMD ["bot"]` in a derived image, or `args: ["bot"]` on the
# ECS container).
CMD ["tenant"]
