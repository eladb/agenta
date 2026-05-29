---
name: keep-install-sh-current
description: "When a change adds a new tool/package dependency, update install.sh in the same change so a fresh box stays fully provisioned."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 73f0e26f-a9df-459f-a065-da90c831bf52
---

Whenever I introduce a new binary or package dependency in the agent's workflow (a script, skill, monitor, etc.), add it to `install.sh` as part of the same change — don't leave install.sh behind.

**Why:** Elad treats `install.sh` as the source of truth for provisioning a fresh agent box ("make sure to always update install.sh as needed"). A dependency that's installed ad-hoc on the current box but missing from install.sh will silently break on the next box. Concrete trigger: `canary-monitor.sh` started using `jq` to build its Slack alert, so install.sh gained an `install_apt_prereqs` step (jq/unzip/curl).

**How to apply:** Before finishing any change that shells out to a new tool, check whether install.sh already guarantees it; if not, add it (user-level installer for binaries like bun/flyctl/aws, or the apt-prereqs path for packages like jq/unzip/curl). install.sh is `.ci-ignore`-covered, so install.sh-only PRs merge without triggering a deploy. Related: [[canary-monitoring-setup]].
