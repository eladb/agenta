# --- builder: compile sandbox-server to a single static Bun binary ---
FROM oven/bun:1-slim AS builder
WORKDIR /build
COPY server/ /build/
RUN bun build --compile --outfile sandbox-server server.ts

# --- final image: Ubuntu + tools + the compiled server binary ---
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git iptables jq ripgrep util-linux \
      zip unzip \
      python3 python-is-python3 python3-pil python3-matplotlib python3-numpy python3-pandas \
      imagemagick \
 && rm -rf /var/lib/apt/lists/*

# Unprivileged user for everything except the iptables setup in entrypoint.sh.
# Ubuntu 24.04 base ships with a default `ubuntu` user at uid 1000; drop it
# so we can claim that uid for our sandbox user. The home dir doubles as
# the workspace and is mounted from a per-thread volume at runtime.
RUN userdel -r ubuntu 2>/dev/null || true \
 && useradd --create-home --shell /bin/bash --uid 1000 sandbox

# Bot identity + skills library: a fresh sandbox starts with README.md and
# skills/* seeded into the volume by entrypoint.sh. We ship the seed at
# /opt/botspace/ in the image (instead of populating /home/sandbox directly)
# because /home/sandbox is overlaid by the per-thread volume mount at run
# time — any image-time content there would be hidden. Build context is
# `sandbox/` (see src/sandbox/docker.ts:DOCKERFILE_DIR), so `botspace` here
# resolves to `sandbox/botspace/` in the repo.
COPY --chown=sandbox:sandbox botspace /opt/botspace/

COPY --from=builder /build/sandbox-server /usr/local/bin/sandbox-server
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /home/sandbox
EXPOSE 9000
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
