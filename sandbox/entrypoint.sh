#!/usr/bin/env bash
# Sets up the sandbox container, then drops to an unprivileged user before
# exec'ing the server. Runs as root inside the container so it can:
#   1. Install iptables OUTPUT rules (egress block; requires NET_ADMIN cap).
#   2. chown the (possibly empty) /workspace volume mount to the sandbox user.
#   3. Drop privs and exec the server.
#
# After step 3, the server — and any bash command it spawns via /exec —
# runs as uid 1000 (`sandbox`) with no capabilities. So a malicious shell
# command can't `iptables -F` to undo the egress block, and can't acquire
# caps via setuid (--security-opt no-new-privileges blocks that too).

set -euo pipefail

if ! iptables -L -n >/dev/null 2>&1; then
  echo "entrypoint: iptables unavailable — refusing to start without egress block" >&2
  exit 1
fi

# Egress policy: ACCEPT loopback, RELATED/ESTABLISHED, Docker DNS at
# 127.0.0.11, RFC1918 + link-local. DROP everything else.
iptables -F OUTPUT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
iptables -A OUTPUT -d 127.0.0.0/8 -j ACCEPT
iptables -A OUTPUT -d 10.0.0.0/8 -j ACCEPT
iptables -A OUTPUT -d 172.16.0.0/12 -j ACCEPT
iptables -A OUTPUT -d 192.168.0.0/16 -j ACCEPT
iptables -A OUTPUT -d 169.254.0.0/16 -j ACCEPT
iptables -P OUTPUT DROP

# /workspace is owned by sandbox:sandbox in the image; Docker preserves that
# when populating a fresh anonymous volume. We don't chown here because
# --cap-drop ALL strips CAP_CHOWN even from root inside the container.

export HOME=/home/sandbox
export USER=sandbox
exec setpriv \
  --reuid=sandbox --regid=sandbox --init-groups \
  --bounding-set=-all --inh-caps=-all --ambient-caps=-all \
  /usr/local/bin/sandbox-server
