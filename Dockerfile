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
      git ca-certificates jq python3 openssh-client \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src
COPY git-hooks ./git-hooks
COPY config ./config
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh git-hooks/pre-receive git-hooks/post-receive

ENV NODE_ENV=production
ENTRYPOINT ["/entrypoint.sh"]
