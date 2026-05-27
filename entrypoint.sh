#!/usr/bin/env bash
# Bot entrypoint on Fly.
#
# Run as the container's PID 1. Responsibilities:
#
#   1. Ensure $AGENTA_DATA_DIR exists (thread JSONL / sessions / attachments
#      all land under here; lives on the Fly volume).
#   2. Walk every entry in config/homes.json (default + each channel). For
#      every entry whose URL scheme is `https://` OR `ssh://` / `git@`,
#      clone (or fetch + reset --hard) the remote into the derived mirror
#      path `${AGENT_HOMES_ROOT}/<slug>` using the referenced auth env var.
#      `file://` entries are skipped (the path IS the source). For ssh
#      entries the deploy key is staged into a tmp file and passed via
#      `GIT_SSH_COMMAND` with the pinned `git-hooks/known_hosts` bundle.
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
#
# Gate the override on FLY_APP_NAME actually being set in the environment.
# On Fly, Fly's machine runtime injects it (to "agenta-bot") and we MUST
# replace it. On ECS (or any non-Fly host), nothing injects FLY_APP_NAME,
# so there's nothing to override — flyProvider reads AGENTA_SANDBOX_APP
# directly (or FLY_APP_NAME if the operator chose to set it). Blindly
# exporting AGENTA_SANDBOX_APP into FLY_APP_NAME outside Fly is harmless
# but obscures intent; keep it Fly-only.
if [ -n "${FLY_APP_NAME:-}" ]; then
  export FLY_APP_NAME="${AGENTA_SANDBOX_APP:-agenta-sandbox}"
fi

DATA_DIR="${AGENTA_DATA_DIR:-/data/agenta}"
HOMES_ROOT="${AGENT_HOMES_ROOT:-/data/homes}"
HOMES_CONFIG="${AGENT_HOMES_CONFIG:-./config/homes.json}"

mkdir -p "$DATA_DIR"
mkdir -p "$HOMES_ROOT"

if [ ! -f "$HOMES_CONFIG" ]; then
  echo "[entrypoint] FATAL: homes config not found at $HOMES_CONFIG" >&2
  exit 1
fi

# Slug derivation must match src/runtime/home-config.ts (`deriveSlug` for
# https://+file:// and `deriveSshSlug` for ssh://+git@). Compute from URL
# host + sanitized pathname, lowercased, leading dashes stripped.
derive_slug() {
  local url="$1"
  python3 - "$url" <<'PY'
import sys, re
url = sys.argv[1]
host = ''
path = ''
if url.startswith('git@'):
  # scp form: <user>@<host>:<path>
  m = re.match(r'^[^@]+@([^:]+):(.+)$', url)
  if m:
    host, path = m.group(1), m.group(2)
else:
  from urllib.parse import urlparse
  u = urlparse(url)
  host = u.hostname or ''
  path = u.path.lstrip('/')
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
  local scheme=''
  case "$remote" in
    file://*)
      echo "[entrypoint] [$name] file:// — no mirror needed; sandbox uses host path directly"
      return 0
      ;;
    git@*|ssh://*|git+ssh://*)
      scheme='ssh'
      ;;
    https://*)
      scheme='https'
      ;;
    *)
      echo "[entrypoint] FATAL: [$name] unsupported URL scheme (remote: $remote)" >&2
      exit 1
      ;;
  esac

  if [ -z "$auth_env" ] || [ "$auth_env" = "null" ]; then
    echo "[entrypoint] FATAL: [$name] auth_env required for $scheme URLs" >&2
    exit 1
  fi
  local secret="${!auth_env:-}"
  if [ -z "$secret" ]; then
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

  # Per-transport: compute either a token-spliced clone URL (https) or
  # a GIT_SSH_COMMAND with a tmp key file (ssh). The ssh key file is
  # cleaned up on function exit via the trap.
  local clone_url=''
  local git_ssh_cmd=''
  local key_file=''
  if [ "$scheme" = 'https' ]; then
    clone_url="$(python3 - "$remote" "$secret" <<'PY'
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
  else
    # ssh: stage the PEM into a 0600 tmp file under /tmp and build a
    # GIT_SSH_COMMAND pointing at it + the bundled known_hosts. The tmp
    # key is short-lived (this function's lifetime); it never lands on
    # the data volume.
    key_file="$(mktemp)"
    chmod 600 "$key_file"
    # shellcheck disable=SC2064
    trap "rm -f '$key_file'" RETURN
    printf '%s\n' "$secret" > "$key_file"
    git_ssh_cmd="ssh -i $key_file -o IdentitiesOnly=yes -o UserKnownHostsFile=git-hooks/known_hosts -o StrictHostKeyChecking=yes"
    clone_url="$remote"
  fi

  if [ ! -d "$mirror/.git" ]; then
    echo "[entrypoint] [$name] cloning $remote into $mirror"
    if [ -n "$git_ssh_cmd" ]; then
      GIT_SSH_COMMAND="$git_ssh_cmd" git clone "$clone_url" "$mirror"
    else
      git clone "$clone_url" "$mirror"
    fi
  else
    echo "[entrypoint] [$name] mirror exists at $mirror; refreshing origin URL + main"
    git -C "$mirror" remote set-url origin "$clone_url"
    # Best-effort fast-forward: a transient network blip shouldn't keep
    # the bot down. The bot can still serve the existing working tree.
    local fetch_ok=0
    if [ -n "$git_ssh_cmd" ]; then
      GIT_SSH_COMMAND="$git_ssh_cmd" git -C "$mirror" fetch origin main 2>&1 && fetch_ok=1 || fetch_ok=0
    else
      git -C "$mirror" fetch origin main 2>&1 && fetch_ok=1 || fetch_ok=0
    fi
    if [ "$fetch_ok" = '1' ]; then
      git -C "$mirror" checkout main 2>&1 || true
      git -C "$mirror" reset --hard origin/main 2>&1
    else
      echo "[entrypoint] WARN: [$name] fetch origin main failed; continuing with existing working tree" >&2
    fi
  fi

  # For ssh mirrors, persist core.sshCommand on the mirror itself so any
  # later bot-side fetch (or prompt-refresh) uses the same key + host
  # pin without needing to re-establish the env var. The tmp key path
  # only lives for this function's duration, though, so callers that
  # re-fetch later would still need to re-export it. The bot today
  # doesn't refetch the mirror after boot, so this is just defense-
  # in-depth.
  if [ -n "$git_ssh_cmd" ]; then
    git -C "$mirror" config core.sshCommand "$git_ssh_cmd"
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
