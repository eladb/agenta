#!/usr/bin/env bash
# Bot entrypoint on Fly.
#
# Run as the container's PID 1. Responsibilities:
#
#   1. Ensure $AGENTA_DATA_DIR exists (thread JSONL / sessions / attachments
#      all land under here; lives on the Fly volume).
#   2. Walk every entry in config/homes.json (default + each channel). For
#      every entry whose URL scheme is `https://`, clone (or fetch + reset
#      --hard) the remote into the derived mirror path
#      `${AGENT_HOMES_ROOT}/<slug>` using the referenced auth env var.
#      `file://` entries are skipped (the path IS the source). Any
#      `ssh://` / `git@` entry fails the boot — direct transport is
#      deferred to #88.
#   3. Set committer identity on each mirror so the post-receive hook can
#      push back to origin without surprises.
#   4. exec the bot — `bun src/index.ts`.
#
# Required env (set as Fly secrets):
#   GITHUB_TOKEN          — fine-grained PAT with read+write to whichever
#                           remotes the config references (entry-by-entry).
# Optional:
#   BOT_GIT_USER_NAME     — committer name (default: "agenta").
#   BOT_GIT_USER_EMAIL    — committer email (default: "agenta@users.noreply.github.com").
#   AGENTA_DATA_DIR       — defaults to /data/agenta (matches fly.toml).
#   AGENT_HOMES_ROOT      — mirror root (default /data/homes, fly.toml).
#   AGENT_HOMES_CONFIG    — config path (default ./config/homes.json).

set -euo pipefail

# Fly auto-injects FLY_APP_NAME=<current-app-name> (here: agenta-bot) and
# this overrides the fly.toml [env] value silently. The bot uses
# FLY_APP_NAME to address the SANDBOX Fly app — that's where per-thread
# sandboxes live, not this machine. Override here so flyProvider hits
# /apps/agenta-sandbox/* instead of /apps/agenta-bot/*. Use
# AGENTA_SANDBOX_APP to make the intent explicit; default to
# "agenta-sandbox".
export FLY_APP_NAME="${AGENTA_SANDBOX_APP:-agenta-sandbox}"

DATA_DIR="${AGENTA_DATA_DIR:-/data/agenta}"
HOMES_ROOT="${AGENT_HOMES_ROOT:-/data/homes}"
HOMES_CONFIG="${AGENT_HOMES_CONFIG:-./config/homes.json}"

mkdir -p "$DATA_DIR"
mkdir -p "$HOMES_ROOT"

if [ ! -f "$HOMES_CONFIG" ]; then
  echo "[entrypoint] FATAL: homes config not found at $HOMES_CONFIG" >&2
  exit 1
fi

# Slug derivation must match src/runtime/home-config.ts:deriveSlug. Compute
# from URL host + sanitized pathname, lowercased, leading dashes stripped.
derive_slug() {
  local url="$1"
  python3 - "$url" <<'PY'
import sys
from urllib.parse import urlparse
url = sys.argv[1]
u = urlparse(url)
host = u.hostname or ''
path = u.path.lstrip('/')
import re
path = re.sub(r'[^a-zA-Z0-9-]', '-', path)
raw = f'{host}-{path}' if host else path
slug = raw.lower().lstrip('-')
print(slug, end='')
PY
}

clone_or_refresh() {
  local name="$1"   # 'default' or 'C0XXX...'
  local remote="$2"
  local auth_env="$3"

  # Scheme dispatch.
  case "$remote" in
    file://*)
      echo "[entrypoint] [$name] file:// — no mirror needed; sandbox uses host path directly"
      return 0
      ;;
    git@*|ssh://*|git+ssh://*)
      echo "[entrypoint] FATAL: [$name] ssh-style remote not implemented; depends on #88 (remote: $remote)" >&2
      exit 1
      ;;
    https://*)
      ;;
    *)
      echo "[entrypoint] FATAL: [$name] unsupported URL scheme (remote: $remote)" >&2
      exit 1
      ;;
  esac

  if [ -z "$auth_env" ] || [ "$auth_env" = "null" ]; then
    echo "[entrypoint] FATAL: [$name] auth_env required for https:// URLs" >&2
    exit 1
  fi
  local token="${!auth_env:-}"
  if [ -z "$token" ]; then
    echo "[entrypoint] FATAL: [$name] auth_env $auth_env is not set in process env" >&2
    exit 1
  fi

  local slug
  slug="$(derive_slug "$remote")"
  if [ -z "$slug" ]; then
    echo "[entrypoint] FATAL: [$name] could not derive slug from $remote" >&2
    exit 1
  fi
  local mirror="$HOMES_ROOT/$slug"

  # Splice the PAT into the URL. Mirrors only github.com today; this
  # builds a clone URL of the form
  # https://x-access-token:${token}@host/<path>.
  local clone_url
  clone_url="$(python3 - "$remote" "$token" <<'PY'
import sys
from urllib.parse import urlparse, urlunparse
remote = sys.argv[1]
token = sys.argv[2]
u = urlparse(remote)
netloc = f'x-access-token:{token}@{u.hostname}'
if u.port:
  netloc += f':{u.port}'
print(urlunparse((u.scheme, netloc, u.path, u.params, u.query, u.fragment)), end='')
PY
)"

  if [ ! -d "$mirror/.git" ]; then
    echo "[entrypoint] [$name] cloning $remote into $mirror"
    git clone "$clone_url" "$mirror"
  else
    echo "[entrypoint] [$name] mirror exists at $mirror; refreshing origin URL + main"
    git -C "$mirror" remote set-url origin "$clone_url"
    # Best-effort fast-forward: a transient network blip shouldn't keep
    # the bot down. The bot can still serve the existing working tree.
    if git -C "$mirror" fetch origin main 2>&1; then
      git -C "$mirror" checkout main 2>&1 || true
      git -C "$mirror" reset --hard origin/main 2>&1
    else
      echo "[entrypoint] WARN: [$name] fetch origin main failed; continuing with existing working tree" >&2
    fi
  fi

  git -C "$mirror" config user.name "${BOT_GIT_USER_NAME:-agenta}"
  git -C "$mirror" config user.email "${BOT_GIT_USER_EMAIL:-agenta@users.noreply.github.com}"
}

# Iterate over every entry: default + each channel's HomeConfig. We emit
# tab-separated `<name>\t<remote>\t<auth_env>` triples from jq and feed
# them into the clone loop.
while IFS=$'\t' read -r name remote auth_env; do
  [ -z "$name" ] && continue
  clone_or_refresh "$name" "$remote" "$auth_env"
done < <(
  jq -r '
    {default: .default} + (.channels // {})
    | to_entries[]
    | [.key, .value.remote, (.value.auth_env // "")]
    | @tsv
  ' "$HOMES_CONFIG"
)

exec bun src/index.ts
