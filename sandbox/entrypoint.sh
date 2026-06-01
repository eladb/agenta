#!/usr/bin/env bash
# Sets up the sandbox container, then drops to an unprivileged user before
# exec'ing the server. Runs as root inside the container so it can:
#   1. Install iptables OUTPUT rules (egress block; requires NET_ADMIN cap).
#   2. Drop privs and exec the server.
#
# The agent home (README.md + skills/) is no longer baked into the image —
# the host-side bot bootstraps a per-session git clone over the WS-tunnel
# transport on the first sandbox-touching tool. So this script just preps
# capabilities and launches the server; the workspace starts empty until
# ensureRepoBootstrap fills it.
#
# After step 2, the server — and any bash command it spawns via /exec —
# runs as uid 1000 (`sandbox`) with no capabilities. So a malicious shell
# command can't `iptables -F` to undo the egress block, and can't acquire
# caps via setuid (--security-opt no-new-privileges blocks that too).

set -euo pipefail

# Egress policy is configurable via SANDBOX_EGRESS env (default: allow).
# Set SANDBOX_EGRESS=block in the host's .env to lock down outbound
# traffic to RFC1918 + loopback only.
if [ "${SANDBOX_EGRESS:-allow}" = "block" ]; then
  if ! iptables -L -n >/dev/null 2>&1; then
    echo "entrypoint: iptables unavailable — refusing to start with SANDBOX_EGRESS=block" >&2
    exit 1
  fi
  # ACCEPT loopback, RELATED/ESTABLISHED, RFC1918 + link-local. DROP rest.
  iptables -F OUTPUT
  iptables -A OUTPUT -o lo -j ACCEPT
  iptables -A OUTPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  iptables -A OUTPUT -d 127.0.0.0/8 -j ACCEPT
  iptables -A OUTPUT -d 10.0.0.0/8 -j ACCEPT
  iptables -A OUTPUT -d 172.16.0.0/12 -j ACCEPT
  iptables -A OUTPUT -d 192.168.0.0/16 -j ACCEPT
  iptables -A OUTPUT -d 169.254.0.0/16 -j ACCEPT
  iptables -P OUTPUT DROP
fi

# Fly mounts fresh volumes as root:root mode 0755, which masks the
# Dockerfile's `useradd --create-home` ownership. chown the mount back to
# sandbox so subsequent operations work. On docker the volume already
# inherits sandbox ownership and this is a no-op (or harmless failure
# without CAP_CHOWN — ignored).
chown sandbox:sandbox /home/sandbox 2>/dev/null || true

# ECS provider (#218): the bot injects SANDBOX_WORKSPACE_DIR=/efs/<slug>
# pointing at a per-thread subdirectory on the shared EFS root mounted at
# /efs. Create the dir and chown it to sandbox so the server (running as
# uid 1000) can read/write inside it. Idempotent across restarts — `mkdir
# -p` is a no-op if the previous task already populated the workspace,
# and `chown` re-asserting sandbox ownership is harmless.
if [ -n "${SANDBOX_WORKSPACE_DIR:-}" ]; then
  mkdir -p "$SANDBOX_WORKSPACE_DIR"
  chown sandbox:sandbox "$SANDBOX_WORKSPACE_DIR"
fi

export HOME=/home/sandbox
export USER=sandbox
exec setpriv \
  --reuid=sandbox --regid=sandbox --init-groups \
  --bounding-set=-all --inh-caps=-all --ambient-caps=-all \
  /usr/local/bin/sandbox-server
