#!/usr/bin/env bash
# Install in-container egress block via iptables OUTPUT, then exec the
# sandbox-server. NET_ADMIN must be granted to the container or these
# iptables calls will fail; we fatal-out in that case so the container
# doesn't accidentally run without egress restrictions.
#
# Policy:
#   ACCEPT  on loopback
#   ACCEPT  RELATED/ESTABLISHED (so the server can reply to the bot)
#   ACCEPT  Docker embedded DNS at 127.0.0.11
#   ACCEPT  RFC1918 (10/8, 172.16/12, 192.168/16) and link-local — covers the
#           Docker bridge subnet the bot reaches us on without enumerating it
#   DROP    everything else (the public internet)
#
# Caveat: the container retains NET_ADMIN at runtime, so a malicious bash
# command from the model could `iptables -F OUTPUT` and undo this. The real
# fix is host-side DOCKER-USER rules (deferred — needs root on the host).

set -euo pipefail

if ! iptables -L -n >/dev/null 2>&1; then
  echo "entrypoint: iptables unavailable — refusing to start without egress block" >&2
  exit 1
fi

iptables -F OUTPUT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
iptables -A OUTPUT -d 127.0.0.0/8 -j ACCEPT
iptables -A OUTPUT -d 10.0.0.0/8 -j ACCEPT
iptables -A OUTPUT -d 172.16.0.0/12 -j ACCEPT
iptables -A OUTPUT -d 192.168.0.0/16 -j ACCEPT
iptables -A OUTPUT -d 169.254.0.0/16 -j ACCEPT
iptables -P OUTPUT DROP

exec /usr/local/bin/sandbox-server
