---
name: workflow-worktree-on-live-hosts
description: "Workflows that restructure src/ in /home/agenta break the canary watchdog because it reads scripts/ + src/ live off disk; use isolation:'worktree' for any structural change here."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 4fa99e3e-eac7-42b7-8a63-eba187c3238a
---

When launching a Workflow on this box (/home/agenta), if it restructures or moves files under `src/` or `scripts/`, every `agent()` call MUST set `isolation: 'worktree'`. Without it, the agents mutate the live working tree and break tools that read it on disk — most importantly the */30 canary-monitor cron (see [[canary-monitoring-setup]]). The watchdog runs `scripts/canary.ts` directly via bun, which imports from `src/runtime/...`; a mid-refactor tree where `src/runtime/` has been moved to `src/tenant/runtime/` makes the script fail to load and pages both targets at the same instant with an identical module error.

**Why:** Happened 2026-05-31T08:00Z. Launched `wf_8463e061-fd7` (multi-tenant split, issue #253) as a 12-phase pipeline without worktree isolation. The scaffold agent moved ~120 files into `src/tenant/`; the next canary cron immediately paged both agenta/Fly and salto/ECS with `Cannot find module '../src/runtime/deploy-target'`. Bots were fine the entire time. Elad accepted the false pages rather than abort, but the underlying mistake was the workflow shape — and the lesson is durable.

**How to apply:** Before calling `Workflow(...)` on this box for anything that moves/restructures committed files: either pass `isolation: 'worktree'` on every `agent()` (and accept the worktree setup cost) or pause the canary-monitor cron for the duration. Tight, file-local edits (single agent, single file) don't need this — only multi-phase refactors that leave the tree in an inconsistent state between phases. The same caution applies if other host-resident tooling reads from `/home/agenta` live (status page, scheduled scripts).

Smell test: if a phase's commit would land halfway through a rename and someone running `bun scripts/canary.ts` *at that moment* would see a broken import → use a worktree.
