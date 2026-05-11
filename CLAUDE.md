# agenta — Claude collaboration notes

This file holds preferences and project context for Claude when working in this repo.

## Code style

- **Functional TypeScript only.** No classes.
- Keep things very simple. No redundant abstractions.
- Prefer plain functions and callbacks for abstraction.
- Use event emitters only for one-to-many cases (multiple consumers reacting to one event).
- Don't introduce interfaces or "provider" abstractions unless a second concrete implementation actually exists.

## Collaboration

- **Stop and ask before making non-trivial decisions or implementing.**
- Surface decision points first (libraries, layout, scope, persistence strategy, etc.) and confirm direction before writing code.
- Don't bundle "while I'm here" cleanup or scope expansion.

## Project context

- Implementation of `SPEC.md` in this repo — Slack thread-backed agentic sandbox bot (v1).
- Built in **phases**, starting with the Slack adapter layer.
- Greenfield — do not copy code from `~/agents` (an earlier scratch repo) without asking.

## Stack decisions (locked in 2026-05-11)

- **Runtime / package manager:** Bun.
- **Slack SDK:** `@slack/socket-mode` + `@slack/web-api` (not Bolt — we want explicit event routing).
- **Phase 1 scope:** thin Slack adapter only. Connect, receive mentions, dedupe, parse `/stop` and `/delete`, post hardcoded reply in-thread. No persistence, no agent loop, no sandbox yet.
