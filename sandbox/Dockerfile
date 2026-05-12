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
      bash ca-certificates curl git jq python3 ripgrep \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/sandbox-server /usr/local/bin/sandbox-server

WORKDIR /workspace
EXPOSE 9000
CMD ["/usr/local/bin/sandbox-server"]
