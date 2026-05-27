# Build image for the agenta bot itself (NOT the sandbox — that's
# sandbox/Dockerfile). Two stages:
#
#   1. deps     - `bun install --production` so the runtime image carries
#                 only the prod dependency tree (no biome / @types / etc.).
#   2. runtime  - Debian-slim Bun + git + ca-certificates. The bot shells
#                 out to `git http-backend` per session (src/git/git-server.ts),
#                 and entrypoint.sh clones the configured agent home repo
#                 into the Fly volume on first boot.
#
# The bot only speaks Slack over Socket Mode (outbound WS) + outbound HTTPS
# to the model gateway and Fly Machines API, so the image has no inbound
# network surface to harden.

FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

FROM oven/bun:1-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ca-certificates jq python3 openssh-client curl \
 && rm -rf /var/lib/apt/lists/*

# Salto CLI on the bot host (not the sandbox). The salto_* tools shell
# out to `salto-cloud` here, using SALTO_API_TOKEN from the bot's env
# (Fly secret in prod). Pinned version — release shape is a single
# static ELF binary at the tarball root, extracted to /usr/local/bin.
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

# Container-level health check. The bot serves /health on $HEALTH_PORT
# (default 8080), returning 200 when Socket Mode is connected, 503
# otherwise (see src/index.ts).
#
# On Fly, fly.toml's [[checks]] takes precedence — Fly runs its own HTTP
# health checks against the same endpoint and uses those for routing /
# rollout decisions. This HEALTHCHECK is just container metadata to Fly.
# On ECS, this is the actual container-level health signal the service
# uses (set in the task definition's containerDefinitions.healthCheck).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS "http://localhost:${HEALTH_PORT:-8080}/health" || exit 1

ENTRYPOINT ["/entrypoint.sh"]
