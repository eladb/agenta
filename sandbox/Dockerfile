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
      python3 python-is-python3 python3-pip python3-pil python3-matplotlib python3-numpy python3-pandas \
      imagemagick \
 && rm -rf /var/lib/apt/lists/*

# Unprivileged user for everything except the iptables setup in entrypoint.sh.
# Ubuntu 24.04 base ships with a default `ubuntu` user at uid 1000; drop it
# so we can claim that uid for our sandbox user. The home dir doubles as
# the workspace and is mounted from a per-thread volume at runtime.
RUN userdel -r ubuntu 2>/dev/null || true \
 && useradd --create-home --shell /bin/bash --uid 1000 sandbox

# Botspace is no longer baked into the image. Each session shallow-clones
# the configured host-side repo over SSH on first sandbox-touching tool —
# see src/git/bootstrap.ts. /home/sandbox is the working tree and the
# botspace (README.md + skills/) all at once.

COPY --from=builder /build/sandbox-server /usr/local/bin/sandbox-server
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /home/sandbox
EXPOSE 9000
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
