FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git jq python3 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# Keep the container alive — the bot will `docker exec` into it per tool call.
CMD ["sleep", "infinity"]
