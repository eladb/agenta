---
name: envstore
description: End-to-end encrypted .env sync. Use when the user wants to push/pull their .env, see history, restore a past version, rotate the token, or bring an existing store onto a new machine. The token IS the secret — never print, log, paste into chat, or commit it.
---

# envstore

`envstore` is a CLI that two-way syncs the local `.env` file with a remote
store using end-to-end encryption. The server never sees plaintext.
Service: https://bensadeh.nanabot.me/envstore.

## Mental model

- **Token = the secret.** Format: `est_<store_id>.<key>` (~83 chars). Possession of the token grants full read / write / delete on the store. Treat it like an SSH private key.
- **`.env`** — contains the user's secrets *and* an `ENVSTORE_TOKEN=...` line. **Belongs in `.gitignore`.**
- **`.envstore`** — small JSON pointer (`{store_id, version, content_mac}`). Leaks nothing without the token. **Committed to source control.**

## Critical rules

1. **Sync on every `.env` touch.** Treat `.env` as shared mutable state, not a local file. Specifically:
   - **Before reading any value out of `.env`** (answering "what's `DATABASE_URL`?", running `psql "$DATABASE_URL"`, generating code that hardcodes a value, etc.), run `envstore sync` first. Other machines may have updated the remote since you last touched it.
   - **After editing `.env`** (any add / change / delete), run `envstore sync` to publish. Don't leave the file dirty between turns — the user may switch machines.
   - The cost of an extra sync is one HTTP request and is free when the file hasn't changed. The cost of a stale read is debugging a value that no longer exists, or pushing over someone else's edit on the next sync.
   - The only exception: if the user *explicitly* says "don't sync" or "work offline", honour that for the turn and remind them at the end.

2. **Never print, log, paste, or echo the token.** That includes:
   - Quoting `ENVSTORE_TOKEN=...` lines back to the user in chat
   - Including the token value in shell commands you display
   - Showing the full `.env` contents — redact the token line
   - Mentioning the token in commit messages or PR descriptions
   When you need to refer to it, write `est_…` (elided).

3. **`.env` must be in `.gitignore`.** If it isn't, add it *before* running anything that could stage a commit.

4. **`.envstore` is *not* gitignored.** It's the version pointer; teammates need it.

5. **Never auto-resolve a sync conflict.** When `envstore sync` exits 1 with a key-level diff, surface the diff to the user and ask which side wins. Don't pick. Don't merge silently.

6. **Don't run `envstore delete`, `envstore rotate-token`, or `envstore sync --push-force` without explicit user confirmation in this turn.** These are destructive or irreversible.

## When to invoke

Use `envstore` when the user:
- Wants to save current `.env` changes (`envstore sync`)
- Wants to pull updates other machines have pushed (`envstore sync`)
- Asks for env-file history (`envstore log`)
- Wants to roll back (`envstore restore <N>` then `envstore sync`)
- Sets up a fresh project that should sync its `.env` (`envstore init`)
- Comes to a fresh machine with the token in their env (`envstore init` auto-detects → pulls)
- Wants to rotate the token (`envstore rotate-token` — ask first)
- Wants to compare local vs remote without writing (`envstore diff`)

## Commands

```
envstore init               # auto-detects: token present → join (sync), else mint new store
envstore sync               # two-way reconcile; exit 1 on conflict
envstore log                # version history newest-first; * = current local
envstore restore <N>        # rewrite .env from v<N>; user then sync to publish
envstore rotate-token       # mint new key + auth, re-encrypt latest, retire old token
envstore diff               # local vs remote; no writes
envstore delete --yes       # destroy store on server (irreversible — confirm with user)
envstore version
```

Shared flags: `--file PATH` (default `.env`), `--state PATH` (default beside file), `--url URL` (override service base), `--token T`.

Token resolution: `--token` > `$ENVSTORE_TOKEN` > `ENVSTORE_TOKEN=` line in `.env`.

## Reporting back to the user

When you finish an envstore operation, surface what changed in a way the
user can verify at a glance — but **never include values**:

- For a push or pull, the CLI already prints `Pushed v<N> (3 keys: A, B, C)`.
  Pass that line through; don't summarise it away.
- For a fresh `init`, also tell the user to copy `ENVSTORE_TOKEN` from
  `.env` into their password manager. Don't print the token value yourself.
- Confirm `.env` is in `.gitignore`.

## Workflows

**First setup (new project, new store):**
```sh
echo '.env' >> .gitignore  # if not already
envstore init              # mints token, writes .env and .envstore
# Tell the user to save the token in a password manager.
# Remind them not to share it in unencrypted channels.
```

**After editing `.env`:**
```sh
envstore sync   # pushes; "Pushed v<N>"
```

**Pulling teammates' updates:**
```sh
git pull        # gets the latest .envstore version pointer
envstore sync   # decrypts and writes the new .env (Pulled v<N>)
```

**Bringing the store onto a fresh machine:**
```sh
git clone <repo> && cd <repo>
ENVSTORE_TOKEN=est_…  envstore sync   # or envstore init — both work
# After this, the token now lives in .env; no env var needed for subsequent runs.
```

**Sync reports a conflict:**
```
$ envstore sync
Conflict: both local .env and remote (v<N>) have diverging changes.
  ~ DATABASE_URL
      local : postgres://local
      remote: postgres://prod
  + LOCAL_ONLY=…
  - REMOTE_ONLY=…
```
**Surface the diff to the user. Ask them to:**
1. Edit `.env` to the desired final state and re-run `envstore sync`, OR
2. `envstore sync --pull-force` to take remote, OR
3. `envstore sync --push-force` to overwrite remote.

Never decide for them.

**Rolling back:**
```sh
envstore log              # find the version
envstore restore 5        # rewrites .env to that content
envstore sync             # publishes it as a new version (v<latest+1>)
```

**Rotating the token (compromised, periodic):**
```sh
envstore sync             # confirm we're in sync first
envstore rotate-token     # mints new, retires old atomically
# Old token immediately dead. Update teammates: they re-bootstrap with the new token.
```

## Common pitfalls to head off

- **User pastes their token into chat to share with a teammate.** Stop them. Recommend a password manager handoff (1Password share, Bitwarden Send, signal). The token in chat history is the same as the token in `git log`.
- **User commits `.env`.** Make `.gitignore` change a precondition for any envstore command in a fresh repo. If a commit has already happened, recommend `git filter-repo` (or treat the token as burned and rotate).
- **User runs `envstore init` thinking it'll join — but it mints a new store.** Note: as of v0.1.1, `init` auto-detects and joins when a token is reachable. Older versions refuse. If on old version: use `envstore sync` instead of `init` for the join case.
- **`.envstore` accidentally gitignored.** It's the version pointer; without it, every sync is a "fresh checkout" and you can't detect conflicts. Make sure `.envstore` is tracked.

## Threats this skill is mostly silent on (and shouldn't pretend otherwise)

- The token model is **single-tier**: there is no read-only token, no audit-of-who-pulled, no per-key permissions. If the user asks for those, tell them envstore doesn't have them; suggest separate stores per environment (per-env token) as the only granularity available.
- The server is a single-node nanabox. Daily snapshots are taken; if the user is using this for critical-path production secrets, that's the operational risk to flag.

## Related files

- `PROTOCOL.md` (at https://bensadeh.nanabot.me/envstore) — wire contract, blob format, sync algorithm. Read if you're debugging unexpected sync behavior.
- `.env` — gitignored; contains token + secrets.
- `.envstore` — committed; small JSON pointer.
