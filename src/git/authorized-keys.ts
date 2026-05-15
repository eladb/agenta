// Per-session entries in the host's `~/.ssh/authorized_keys`. We tag each
// agenta-owned line with a trailing `agenta-<thread_key>` comment so:
//   - `removeEntry` can find the right line on /delete without parsing the
//     `command="…"` argument list.
//   - `listEntries` can enumerate which sessions currently have a key.
//   - `reapOrphanAuthorizedKeys` can drop lines whose thread has no
//     corresponding session.json on disk.
//
// Lines that don't match the agenta tag are preserved verbatim — this file
// is shared with the user's personal SSH keys.

import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { log } from '../log';
import { listSessions } from '../runtime/session-store';

const DEFAULT_OPTIONS = 'no-port-forwarding,no-X11-forwarding,no-pty,no-agent-forwarding';

export function authorizedKeysPath(): string {
  return process.env.AGENTA_AUTHORIZED_KEYS_PATH ?? join(homedir(), '.ssh', 'authorized_keys');
}

function tagFor(threadKey: string): string {
  return `agenta-${threadKey}`;
}

async function ensureFile(path: string): Promise<void> {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  if (!existsSync(path)) {
    await writeFile(path, '', { mode: 0o600 });
  }
}

async function readAll(path: string): Promise<string[]> {
  await ensureFile(path);
  const raw = await readFile(path, 'utf8');
  return raw.length === 0 ? [] : raw.split('\n');
}

async function writeAll(path: string, lines: string[]): Promise<void> {
  // Always end with a single trailing newline so subsequent appends don't
  // glue onto the last entry. Strip any existing trailing empties first.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const body = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, body, { mode: 0o600 });
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => {});
}

// Pull the trailing `agenta-<thread_key>` tag off a line, if present. The
// tag is always the last whitespace-delimited token. Returns undefined for
// non-agenta lines.
function extractTag(line: string): string | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith('#')) return undefined;
  const last = trimmed.split(/\s+/).pop();
  if (!last) return undefined;
  if (!last.startsWith('agenta-')) return undefined;
  return last;
}

export type AddEntryInput = {
  threadKey: string;
  // The full `ssh-ed25519 AAAA... <comment>` text exactly as ssh-keygen
  // produced it. We strip the trailing comment field before re-emitting so
  // the agenta tag is the line's only trailing comment.
  publicKey: string;
  // The full `command="..."` value (just the inside of the quotes — we add
  // the wrapping). This is what sshd will set as $SSH_ORIGINAL_COMMAND
  // override; agenta-git-shell uses it to parse --session/--repo/etc.
  command: string;
};

function stripPubKeyComment(pub: string): string {
  // OpenSSH public-key line: `<type> <base64> [comment]`. Drop the comment.
  const parts = pub.trim().split(/\s+/);
  if (parts.length < 2) return pub.trim();
  return `${parts[0]} ${parts[1]}`;
}

export async function addEntry(input: AddEntryInput): Promise<void> {
  const path = authorizedKeysPath();
  const lines = await readAll(path);
  // Drop any pre-existing entry for the same thread (shouldn't happen in the
  // normal flow but keeps add idempotent).
  const tag = tagFor(input.threadKey);
  const filtered = lines.filter((l) => extractTag(l) !== tag);
  const keyOnly = stripPubKeyComment(input.publicKey);
  // Quote the command literal. authorized_keys uses backslash-escaped
  // double quotes inside the value; we don't expect quotes in our command
  // string (the bootstrap composes it from controlled flags) but guard
  // anyway.
  const escapedCmd = input.command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const line = `command="${escapedCmd}",${DEFAULT_OPTIONS} ${keyOnly} ${tag}`;
  filtered.push(line);
  await writeAll(path, filtered);
}

export async function removeEntry(threadKey: string): Promise<void> {
  const path = authorizedKeysPath();
  if (!existsSync(path)) return;
  const lines = await readAll(path);
  const tag = tagFor(threadKey);
  const next = lines.filter((l) => extractTag(l) !== tag);
  if (next.length === lines.length) return;
  await writeAll(path, next);
}

export async function listEntries(): Promise<string[]> {
  const path = authorizedKeysPath();
  if (!existsSync(path)) return [];
  const lines = await readAll(path);
  const out: string[] = [];
  for (const l of lines) {
    const tag = extractTag(l);
    if (tag) out.push(tag.slice('agenta-'.length));
  }
  return out;
}

// Drop authorized_keys lines whose thread has no matching session.json.
// Symmetric with reapOrphanSandboxes — the bot may have crashed between
// adding the entry and writing session.json, or the user may have
// `rm -rf data/` without going through /delete. Returns the count of
// entries removed. Errors logged; never throws.
export async function reapOrphanAuthorizedKeys(): Promise<number> {
  const path = authorizedKeysPath();
  if (!existsSync(path)) return 0;
  let entries: string[];
  try {
    entries = await listEntries();
  } catch (err) {
    log.warn('git', `reap: list authorized_keys failed: ${(err as Error).message}`);
    return 0;
  }
  if (entries.length === 0) return 0;
  // Cross-reference against session.json `git.pubkey_fp` records. A thread
  // without a session, OR a thread whose session no longer carries a git
  // record, gets its authorized_keys line dropped.
  const sessions = await listSessions();
  const live = new Set<string>();
  for (const { threadKey, state } of sessions) {
    if (state.git?.pubkey_fp) live.add(threadKey);
  }
  const stale = entries.filter((tk) => !live.has(tk));
  for (const tk of stale) {
    try {
      await removeEntry(tk);
    } catch (err) {
      log.warn('git', `reap: removeEntry(${tk}) failed: ${(err as Error).message}`);
    }
  }
  if (stale.length > 0)
    log.info('git', `reap: dropped ${stale.length} orphan authorized_keys line(s)`);
  return stale.length;
}

// For tests: wipe the configured file (always a tmpfile in tests because
// AGENTA_AUTHORIZED_KEYS_PATH is set in beforeEach).
export async function _resetForTests(): Promise<void> {
  const path = authorizedKeysPath();
  if (existsSync(path)) await rm(path, { force: true });
}
