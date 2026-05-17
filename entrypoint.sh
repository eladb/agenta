#!/usr/bin/env bash
# Bot entrypoint on Fly.
#
# Run as the container's PID 1. Responsibilities:
#
#   1. Ensure $AGENTA_DATA_DIR exists (thread JSONL / sessions / attachments
#      all land under here; lives on the Fly volume).
#   2. Clone the configured agent home repo from GitHub into $AGENT_HOME
#      on first boot. On subsequent boots, refresh the origin URL (in case
#      GITHUB_TOKEN was rotated) and `git fetch + reset --hard origin/main`
#      so the latest README/skills from GitHub reach the bot. The agent
#      home's `main` is the bot's source of truth; per-session work lives
#      on `agenta/sessions/<thread_key>` refs which we never touch here.
#   3. Set committer identity on the cloned repo so the post-receive hook
#      can push to origin without surprises.
#   4. exec the bot — `bun src/index.ts`.
#
# Required env (set as Fly secrets):
#   GITHUB_TOKEN      — fine-grained PAT with read+write to AGENT_HOME_REPO.
#   AGENT_HOME_REPO   — "owner/repo", e.g. "eladb/agenta-test-home".
# Optional:
#   BOT_GIT_USER_NAME   — committer name (default: "agenta").
#   BOT_GIT_USER_EMAIL  — committer email (default: "agenta@users.noreply.github.com").
#   AGENTA_DATA_DIR     — defaults to /data/agenta (matches fly.toml).
#   AGENT_HOME          — defaults to /data/agent-home (matches fly.toml).

set -euo pipefail

: "${GITHUB_TOKEN:?GITHUB_TOKEN required (set as Fly secret)}"
: "${AGENT_HOME_REPO:?AGENT_HOME_REPO required (owner/repo, e.g. eladb/agenta-test-home)}"

# Fly auto-injects FLY_APP_NAME=<current-app-name> (here: agenta-bot) and
# this overrides the fly.toml [env] value silently. The bot uses
# FLY_APP_NAME to address the SANDBOX Fly app — that's where per-thread
# sandboxes live, not this machine. Override here so flyProvider hits
# /apps/agenta-sandbox/* instead of /apps/agenta-bot/*. Use
# AGENTA_SANDBOX_APP to make the intent explicit; default to
# "agenta-sandbox".
export FLY_APP_NAME="${AGENTA_SANDBOX_APP:-agenta-sandbox}"

DATA_DIR="${AGENTA_DATA_DIR:-/data/agenta}"
REPO_DIR="${AGENT_HOME:-/data/agent-home}"

mkdir -p "$DATA_DIR"
mkdir -p "$(dirname "$REPO_DIR")"

REMOTE_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${AGENT_HOME_REPO}.git"

if [ ! -d "$REPO_DIR/.git" ]; then
  echo "[entrypoint] cloning ${AGENT_HOME_REPO} into $REPO_DIR"
  git clone "$REMOTE_URL" "$REPO_DIR"
else
  echo "[entrypoint] $REPO_DIR already cloned; refreshing origin URL + main"
  git -C "$REPO_DIR" remote set-url origin "$REMOTE_URL"
  # Fast-forward main from origin so README / skills edits made on GitHub
  # reach the bot. Reset --hard rather than pull --ff-only because session
  # refs that already pushed back may have created divergent local state
  # we don't care about preserving — origin/main is authoritative.
  # Best-effort: a network blip / GitHub outage shouldn't keep the bot down.
  if git -C "$REPO_DIR" fetch origin main 2>&1; then
    git -C "$REPO_DIR" checkout main 2>&1 || true
    git -C "$REPO_DIR" reset --hard origin/main 2>&1
  else
    echo "[entrypoint] WARN: fetch origin main failed; continuing with existing working tree" >&2
  fi
fi

git -C "$REPO_DIR" config user.name "${BOT_GIT_USER_NAME:-agenta}"
git -C "$REPO_DIR" config user.email "${BOT_GIT_USER_EMAIL:-agenta@users.noreply.github.com}"

exec bun src/index.ts
