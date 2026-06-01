#!/usr/bin/env bash
# Provisions + (re)deploys the sandbox image to Fly.
#
#   scripts/deploy-sandbox-fly.sh
#
# Idempotent. Run it once for initial setup, and again whenever the
# Dockerfile or sandbox-server changes — the bot picks up the new image
# the next time it creates a machine (existing machines keep the old
# image until destroyed via /delete).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SANDBOX_DIR="$SCRIPT_DIR/../sandbox"
APP="${FLY_APP_NAME:-agenta-sandbox}"

die() { echo -e "\nERROR: $*\n" >&2; exit 1; }

command -v flyctl >/dev/null 2>&1 \
  || die "flyctl not found on PATH. Install: https://fly.io/docs/flyctl/install/"

WHOAMI="$(flyctl auth whoami 2>/dev/null)" \
  || die "flyctl is not authenticated. Run: flyctl auth login"
echo "✓ flyctl authenticated as $WHOAMI"

if flyctl apps list --json | jq -e --arg a "$APP" 'any(.[]; .Name == $a)' >/dev/null; then
  echo "✓ Fly app exists: $APP"
else
  echo "creating Fly app: $APP"
  flyctl apps create "$APP" || die "failed to create app $APP"
fi

# Build + push the image. --build-only --push: builds the Dockerfile on
# Fly's remote builder and pushes to registry.fly.io/<app>:latest. Does
# NOT create any machines. --image-label latest pins the tag so the bot
# can reference registry.fly.io/<app>:latest unambiguously.
echo
echo "deploying image from $SANDBOX_DIR…"
(cd "$SANDBOX_DIR" && flyctl deploy -a "$APP" --build-only --push --image-label latest) \
  || die "fly deploy failed (see output above)"

echo
echo "✓ image pushed: registry.fly.io/$APP:latest"

# Allocate public IPs so the app's <app>.fly.dev hostname actually
# resolves. Fly apps don't get IPs by default; without these the bot
# can't reach the per-thread machines. Shared IPv4 is free.
IPS_JSON="$(flyctl ips list -a "$APP" --json 2>/dev/null || echo '[]')"
HAS_V4="$(echo "$IPS_JSON" | jq 'any(.[]; .Type == "shared_v4" or .Type == "v4")')"
HAS_V6="$(echo "$IPS_JSON" | jq 'any(.[]; .Type == "v6" or .Type == "private_v6")')"

if [[ "$HAS_V4" != "true" ]]; then
  echo
  echo "allocating shared IPv4 for the app…"
  flyctl ips allocate-v4 -a "$APP" --shared -y || die "fly ips allocate-v4 failed"
else
  echo "✓ shared IPv4 already allocated"
fi
if [[ "$HAS_V6" != "true" ]]; then
  echo "allocating IPv6 for the app…"
  flyctl ips allocate-v6 -a "$APP" || die "fly ips allocate-v6 failed"
else
  echo "✓ IPv6 already allocated"
fi

cat <<EOF

Next steps:
  1. Generate an API token (one-time):
     flyctl tokens create deploy -a $APP

  2. Add to .env:
     SANDBOX_PROVIDER=fly
     FLY_APP_NAME=$APP
     FLY_API_TOKEN=<token from step 1>

Then \`bun start\` will create per-thread Fly machines for sandboxes.
EOF
