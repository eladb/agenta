#!/usr/bin/env bash
#
# install.sh — provision the agenta agent toolchain on a fresh box.
#
# Installs the binaries an agenta agent needs that aren't part of a base
# Ubuntu image: bun (runtime), flyctl (deploy/ssh/canary), the aws CLI
# (ECS), and docker (local sandbox provider). gh is assumed pre-installed.
# Also ensures the apt prereqs the canary + canary-monitor toolchain needs
# (jq, unzip, curl), and installs the 30-min double-canary watchdog
# (scripts/canary-monitor.sh → ~/.local/bin + a cron entry).
#
# NOTE: the watchdog canaries and (via the oncall agent) remediates PROD, so
# it must run on ONE host. install.sh installs it unconditionally — don't run
# install.sh on a box you don't want canarying prod.
#
# Binaries only — no auth, no secrets. Authenticate separately:
#   gh auth login          flyctl auth login          aws creds via .env
#
# Idempotent: each tool already on PATH is skipped. User-level tools
# (bun/flyctl/aws) install without root; docker needs root and is skipped
# with a notice if neither root nor sudo is available.
set -euo pipefail

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }

# A tool counts as present if it's on PATH or already at its install path
# (so re-runs are idempotent before the PATH block takes effect in a shell).
have() { command -v "$1" >/dev/null 2>&1 || { [ -n "${2:-}" ] && [ -x "$2" ]; }; }

# Repo root = the dir this script lives in (canary-monitor.sh needs it to find
# scripts/canary.ts + .env at runtime).
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "$(uname -m)" in
  x86_64)  BUN_ARCH="x64";      AWS_ARCH="x86_64" ;;
  aarch64) BUN_ARCH="aarch64";  AWS_ARCH="aarch64" ;;
  *) warn "unsupported arch $(uname -m); bun/aws steps may fail" ;;
esac

# Extract a zip with unzip if present, else fall back to python3's zipfile.
extract_zip() {
  local zip="$1" dest="$2"
  if command -v unzip >/dev/null 2>&1; then
    unzip -q "$zip" -d "$dest"
  elif command -v python3 >/dev/null 2>&1; then
    # python's `zipfile -e` drops unix perms; restore mode from external_attr
    # so executables (e.g. aws/install, aws/dist/aws) stay runnable.
    python3 - "$zip" "$dest" <<'PY'
import os, sys, zipfile
zf, dest = zipfile.ZipFile(sys.argv[1]), sys.argv[2]
for info in zf.infolist():
    path = zf.extract(info, dest)
    mode = info.external_attr >> 16
    if mode:
        os.chmod(path, mode)
PY
  else
    warn "need unzip or python3 to extract $zip"; return 1
  fi
}

# Apt packages the toolchain needs but a minimal image may lack:
#   jq    — canary-monitor.sh builds the Slack alert JSON with it (no fallback)
#   unzip — bun/aws extraction (extract_zip falls back to python3 without it)
#   curl  — every installer below fetches over curl
# Needs root; skipped with a notice if unavailable.
install_apt_prereqs() {
  local missing=() p
  for p in jq unzip curl; do command -v "$p" >/dev/null 2>&1 || missing+=("$p"); done
  if [ "${#missing[@]}" -eq 0 ]; then log "apt prereqs present (jq, unzip, curl)"; return; fi
  command -v apt-get >/dev/null 2>&1 || { warn "missing ${missing[*]} and no apt-get — install manually"; return; }
  local sudo=""
  if [ "$(id -u)" -eq 0 ]; then sudo=""
  elif sudo -n true 2>/dev/null; then sudo="sudo"
  elif command -v sudo >/dev/null 2>&1 && [ -t 0 ]; then sudo="sudo"
  else warn "missing ${missing[*]} and no usable sudo — install as root: apt-get install -y ${missing[*]}"; return; fi
  log "installing apt prereqs: ${missing[*]}"
  $sudo apt-get update -qq
  $sudo apt-get install -y "${missing[@]}"
}

install_bun() {
  if have bun "$HOME/.bun/bin/bun"; then log "bun present"; return; fi
  log "installing bun (user-level → ~/.bun)"
  local tmp; tmp="$(mktemp -d)"
  curl -fsSL "https://github.com/oven-sh/bun/releases/latest/download/bun-linux-${BUN_ARCH}.zip" -o "$tmp/bun.zip"
  extract_zip "$tmp/bun.zip" "$tmp"
  mkdir -p "$HOME/.bun/bin"
  install -m 0755 "$tmp/bun-linux-${BUN_ARCH}/bun" "$HOME/.bun/bin/bun"
  rm -rf "$tmp"
}

install_flyctl() {
  if have flyctl "$HOME/.fly/bin/flyctl"; then log "flyctl present"; return; fi
  log "installing flyctl (user-level → ~/.fly)"
  curl -fsSL https://fly.io/install.sh | sh
}

install_aws() {
  if have aws "$HOME/.local/bin/aws"; then log "aws present"; return; fi
  log "installing aws CLI v2 (user-level → ~/.local)"
  local tmp; tmp="$(mktemp -d)"
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${AWS_ARCH}.zip" -o "$tmp/awscliv2.zip"
  extract_zip "$tmp/awscliv2.zip" "$tmp"
  "$tmp/aws/install" -i "$HOME/.local/aws-cli" -b "$HOME/.local/bin"
  rm -rf "$tmp"
}

install_docker() {
  if command -v docker >/dev/null 2>&1; then log "docker present: $(command -v docker)"; return; fi
  local sudo=""
  if [ "$(id -u)" -eq 0 ]; then
    sudo=""
  elif sudo -n true 2>/dev/null; then
    sudo="sudo"               # passwordless sudo
  elif command -v sudo >/dev/null 2>&1 && [ -t 0 ]; then
    sudo="sudo"               # interactive shell — sudo will prompt
  else
    warn "docker needs root and no usable sudo — skipping."
    warn "  later as root: curl -fsSL https://get.docker.com | sh && usermod -aG docker $(id -un)"
    return
  fi
  log "installing docker engine (needs root)"
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  $sudo sh /tmp/get-docker.sh
  $sudo usermod -aG docker "$(id -un)" || true
  rm -f /tmp/get-docker.sh
  warn "log out/in (or 'newgrp docker') for the docker group to take effect."
}

# Make sure the user-level bin dirs are on PATH for future shells.
ensure_path() {
  local marker="# agenta install.sh PATH"
  for rc in "$HOME/.bashrc" "$HOME/.profile"; do
    [ -f "$rc" ] || continue
    grep -qF "$marker" "$rc" && continue
    {
      printf '\n%s\n' "$marker"
      printf '%s\n' 'export PATH="$HOME/.bun/bin:$HOME/.fly/bin:$HOME/.local/bin:$PATH"'
    } >> "$rc"
    log "added PATH block to $rc"
  done
}

# Deploy the 30-min canary watchdog: copy canary-monitor.sh to ~/.local/bin
# (stable path, so cron survives repo branch switches) + install the cron.
# Idempotent: replaces any prior watchdog cron line. Always runs.
setup_monitor() {
  local src="$REPO_DIR/scripts/canary-monitor.sh" dst="$HOME/.local/bin/canary-monitor.sh"
  [ -f "$src" ] || { warn "monitor: $src not found — skipping"; return; }
  command -v crontab >/dev/null 2>&1 || { warn "monitor: no crontab — skipping cron install"; return; }
  mkdir -p "$HOME/.local/bin"
  install -m 0755 "$src" "$dst"
  local line="*/30 * * * * AGENTA_REPO=\"$REPO_DIR\" \"$dst\" >/dev/null 2>&1"
  local cur; cur="$(crontab -l 2>/dev/null | grep -v 'canary-monitor\.sh' | grep -v '# agenta double-canary watchdog' || true)"
  printf '%s\n# agenta double-canary watchdog (every 30 min) — see the canary skill\n%s\n' "$cur" "$line" | crontab -
  log "monitor installed → $dst (cron */30, repo=$REPO_DIR)"
}

main() {
  log "agenta toolchain install (arch=$(uname -m), uid=$(id -u))"
  install_apt_prereqs || warn "apt prereqs step failed; jq/unzip/curl may be missing"
  install_bun
  install_flyctl
  install_aws
  install_docker || warn "docker step failed; install manually as root"
  ensure_path
  setup_monitor || warn "monitor setup failed; canary-monitor cron not installed"
  log "done. Open a new shell or: export PATH=\"\$HOME/.bun/bin:\$HOME/.fly/bin:\$HOME/.local/bin:\$PATH\""
  log "then authenticate: gh auth login · flyctl auth login · aws creds via .env"
}

main "$@"
