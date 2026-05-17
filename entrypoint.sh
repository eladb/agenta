#!/usr/bin/env bash
# Bot entrypoint on Fly.
#
# Run as the container's PID 1. Responsibilities:
#
#   1. Ensure $AGENTA_DATA_DIR exists (thread JSONL / sessions / attachments
#      all land under here; lives on the Fly volume).
#   2. Clone the configured botspace repo from GitHub into $AGENTA_REPO_PATH
#      on first boot. On subsequent boots, just refresh the origin URL in
#      case GITHUB_TOKEN was rotated.
#   3. Set committer identity on the cloned repo so the post-receive hook
#      can push to origin without surprises.
#   4. exec the bot — `bun src/index.ts`.
#
# Required env (set as Fly secrets):
#   GITHUB_TOKEN     — fine-grained PAT with read+write to BOTSPACE_REPO.
#   BOTSPACE_REPO    — "owner/repo", e.g. "eladb/agenta-botspace".
# Optional:
#   BOT_GIT_USER_NAME   — committer name (default: "agenta").
#   BOT_GIT_USER_EMAIL  — committer email (default: "agenta@users.noreply.github.com").
#   AGENTA_DATA_DIR     — defaults to /data/agenta (matches fly.toml).
#   AGENTA_REPO_PATH    — defaults to /data/botspace (matches fly.toml).

set -euo pipefail

: "${GITHUB_TOKEN:?GITHUB_TOKEN required (set as Fly secret)}"
: "${BOTSPACE_REPO:?BOTSPACE_REPO required (owner/repo, e.g. eladb/agenta-botspace)}"

DATA_DIR="${AGENTA_DATA_DIR:-/data/agenta}"
REPO_DIR="${AGENTA_REPO_PATH:-/data/botspace}"

mkdir -p "$DATA_DIR"
mkdir -p "$(dirname "$REPO_DIR")"

REMOTE_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${BOTSPACE_REPO}.git"

if [ ! -d "$REPO_DIR/.git" ]; then
  echo "[entrypoint] cloning ${BOTSPACE_REPO} into $REPO_DIR"
  git clone "$REMOTE_URL" "$REPO_DIR"
else
  echo "[entrypoint] $REPO_DIR already cloned; refreshing origin URL"
  git -C "$REPO_DIR" remote set-url origin "$REMOTE_URL"
fi

git -C "$REPO_DIR" config user.name "${BOT_GIT_USER_NAME:-agenta}"
git -C "$REPO_DIR" config user.email "${BOT_GIT_USER_EMAIL:-agenta@users.noreply.github.com}"

exec bun src/index.ts
