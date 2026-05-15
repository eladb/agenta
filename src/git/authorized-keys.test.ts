import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addEntry, listEntries, removeEntry } from './authorized-keys';

const SAMPLE_PUBKEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPlaceholderBase64ContentHerePlaceholder agenta';

let tmpDir: string;
let path: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'agenta-authkeys-'));
  path = join(tmpDir, 'authorized_keys');
  process.env.AGENTA_AUTHORIZED_KEYS_PATH = path;
});

afterEach(() => {
  delete process.env.AGENTA_AUTHORIZED_KEYS_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('authorized-keys', () => {
  test('addEntry appends a tagged line with 0600 mode', async () => {
    await addEntry({
      threadKey: 'abc123',
      publicKey: SAMPLE_PUBKEY,
      command: '/path/to/agenta-git-shell --session abc123 --repo /repo --allowed-ref refs/heads/x',
    });
    const body = readFileSync(path, 'utf8');
    expect(body.trim()).toMatch(/ agenta-abc123$/);
    expect(body).toContain('command="');
    expect(body).toContain('no-port-forwarding');
    expect(body).toContain('no-pty');
    // The pubkey comment ("agenta") should be stripped — only the tag trails.
    expect(body).not.toContain(' agenta agenta-abc123');
    const stat = statSync(path);
    // file mode bits: octal 0o600 — owner read/write only.
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test('addEntry replaces an existing entry for the same thread', async () => {
    await addEntry({ threadKey: 't1', publicKey: SAMPLE_PUBKEY, command: 'cmd1' });
    await addEntry({ threadKey: 't1', publicKey: SAMPLE_PUBKEY, command: 'cmd2' });
    const body = readFileSync(path, 'utf8');
    expect(body).not.toContain('cmd1');
    expect(body).toContain('cmd2');
    expect(body.match(/agenta-t1/g)?.length).toBe(1);
  });

  test('removeEntry removes only the targeted thread', async () => {
    await addEntry({ threadKey: 't1', publicKey: SAMPLE_PUBKEY, command: 'cmd1' });
    await addEntry({ threadKey: 't2', publicKey: SAMPLE_PUBKEY, command: 'cmd2' });
    await removeEntry('t1');
    const body = readFileSync(path, 'utf8');
    expect(body).not.toContain('agenta-t1');
    expect(body).toContain('agenta-t2');
  });

  test('listEntries returns thread keys present', async () => {
    await addEntry({ threadKey: 'aaa', publicKey: SAMPLE_PUBKEY, command: 'c' });
    await addEntry({ threadKey: 'bbb', publicKey: SAMPLE_PUBKEY, command: 'c' });
    const got = await listEntries();
    expect(got.sort()).toEqual(['aaa', 'bbb']);
  });

  test('preserves pre-existing personal keys', async () => {
    const personal = 'ssh-rsa AAAAB3...user-personal-key... user@laptop';
    writeFileSync(path, `${personal}\n`, { mode: 0o600 });
    await addEntry({ threadKey: 'mine', publicKey: SAMPLE_PUBKEY, command: 'cmd' });
    await removeEntry('mine');
    const body = readFileSync(path, 'utf8');
    expect(body.trim()).toBe(personal);
  });

  test('listEntries on empty file returns []', async () => {
    expect(await listEntries()).toEqual([]);
  });

  test('removeEntry on missing thread is a no-op', async () => {
    await addEntry({ threadKey: 'x', publicKey: SAMPLE_PUBKEY, command: 'cmd' });
    const before = readFileSync(path, 'utf8');
    await removeEntry('y');
    const after = readFileSync(path, 'utf8');
    expect(after).toBe(before);
  });

  test('does not match agenta-prefixed lines that are not agenta tags', async () => {
    // A non-agenta line that happens to contain the word "agenta" in its
    // comment should be left alone.
    const personal = 'ssh-ed25519 AAAAfoo my-agenta-laptop-key';
    writeFileSync(path, `${personal}\n`, { mode: 0o600 });
    // listEntries should return [] because the trailing token "my-agenta-…"
    // does NOT start with "agenta-".
    expect(await listEntries()).toEqual([]);
  });
});
