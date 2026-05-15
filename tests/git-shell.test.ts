// Integration test for bin/agenta-git-shell.
//
// Spawns the shell with $SSH_ORIGINAL_COMMAND set and a stubbed $PATH that
// contains shim `git-upload-pack` / `git-receive-pack` binaries which write
// their argv + a curated set of env vars to a tmpfile and exit 0. We assert:
//   - the right verb gets exec'd with the configured repo path
//   - $AGENTA_ALLOWED_REF + the core.hooksPath injection vars are exported
//   - rejection branches (wrong path, unknown verb, missing flags) exit non-zero

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function commandExists(name: string): boolean {
  return Bun.which(name) !== null;
}

const SHELL_PATH = join(import.meta.dir, '..', 'bin', 'agenta-git-shell');

function makeShim(dir: string, name: string, outFile: string): void {
  // A bash shim that records its argv and the agenta-relevant env vars to
  // `outFile`, then exits 0. The format is line-oriented and key=value so
  // the test can grep for individual fields without parsing JSON.
  const body = [
    '#!/usr/bin/env bash',
    'set -eu',
    `out=${JSON.stringify(outFile)}`,
    'printf "argv0=%s\\n" "$0" > "$out"',
    'i=1',
    'for a in "$@"; do',
    '  printf "argv%d=%s\\n" "$i" "$a" >> "$out"',
    '  i=$((i+1))',
    'done',
    `printf "AGENTA_ALLOWED_REF=%s\\n" "\${AGENTA_ALLOWED_REF:-}" >> "$out"`,
    `printf "AGENTA_SESSION=%s\\n" "\${AGENTA_SESSION:-}" >> "$out"`,
    `printf "GIT_CONFIG_COUNT=%s\\n" "\${GIT_CONFIG_COUNT:-}" >> "$out"`,
    `printf "GIT_CONFIG_KEY_0=%s\\n" "\${GIT_CONFIG_KEY_0:-}" >> "$out"`,
    `printf "GIT_CONFIG_VALUE_0=%s\\n" "\${GIT_CONFIG_VALUE_0:-}" >> "$out"`,
    'exit 0',
    '',
  ].join('\n');
  const p = join(dir, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
}

async function runShell(
  args: string[],
  env: Record<string, string>,
): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(SHELL_PATH, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    proc.on('close', (code) => resolve({ exitCode: code ?? -1, stderr }));
  });
}

function parseShimOut(path: string): Record<string, string> {
  const raw = readFileSync(path, 'utf8');
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

describe.skipIf(!commandExists('bash'))('agenta-git-shell', () => {
  let workDir: string;
  let shimDir: string;
  let outFile: string;
  let repo: string;
  let session: string;
  let allowedRef: string;
  let stubPath: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'agenta-shell-'));
    shimDir = join(workDir, 'bin');
    mkdirSync(shimDir, { recursive: true });
    outFile = join(workDir, 'shim-out');
    makeShim(shimDir, 'git-upload-pack', outFile);
    makeShim(shimDir, 'git-receive-pack', outFile);
    repo = '/repos/agenta-repo';
    session = 'tk-test';
    allowedRef = `refs/heads/agenta/sessions/${session}`;
    // Shim dir first so it shadows any real git-upload-pack on the system,
    // but keep the system PATH after it so /usr/bin/env bash + builtins
    // resolve. process.env.PATH is whatever bun inherits; on macOS that's
    // usually /usr/bin:/bin:/usr/sbin:/sbin + homebrew, which is fine.
    stubPath = `${shimDir}:${process.env.PATH ?? '/usr/bin:/bin'}`;
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test('git-upload-pack: execs shim with repo path and injected env', async () => {
    const r = await runShell(['--session', session, '--repo', repo, '--allowed-ref', allowedRef], {
      SSH_ORIGINAL_COMMAND: `git-upload-pack '${repo}'`,
      PATH: stubPath,
    });
    expect(r.exitCode).toBe(0);
    const captured = parseShimOut(outFile);
    expect(captured.argv1).toBe(repo);
    expect(captured.AGENTA_ALLOWED_REF).toBe(allowedRef);
    expect(captured.AGENTA_SESSION).toBe(session);
    expect(captured.GIT_CONFIG_COUNT).toBe('1');
    expect(captured.GIT_CONFIG_KEY_0).toBe('core.hooksPath');
    expect(captured.GIT_CONFIG_VALUE_0).toContain('git-hooks');
  });

  test('git-receive-pack: execs shim with repo path and injected env', async () => {
    const r = await runShell(['--session', session, '--repo', repo, '--allowed-ref', allowedRef], {
      SSH_ORIGINAL_COMMAND: `git-receive-pack '${repo}'`,
      PATH: stubPath,
    });
    expect(r.exitCode).toBe(0);
    const captured = parseShimOut(outFile);
    expect(captured.argv1).toBe(repo);
    expect(captured.AGENTA_ALLOWED_REF).toBe(allowedRef);
  });

  test('rejects when SSH_ORIGINAL_COMMAND path does not match --repo', async () => {
    const r = await runShell(['--session', session, '--repo', repo, '--allowed-ref', allowedRef], {
      SSH_ORIGINAL_COMMAND: `git-upload-pack '/wrong/path'`,
      PATH: stubPath,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/does not match/);
    // Shim must not have been invoked.
    expect(spawnSync('test', ['-e', outFile]).status).not.toBe(0);
  });

  test('rejects an unknown verb (e.g. "ls /")', async () => {
    const r = await runShell(['--session', session, '--repo', repo, '--allowed-ref', allowedRef], {
      SSH_ORIGINAL_COMMAND: 'ls /',
      PATH: stubPath,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/refusing command|unknown/);
  });

  test('rejects when SSH_ORIGINAL_COMMAND is unset', async () => {
    const r = await runShell(['--session', session, '--repo', repo, '--allowed-ref', allowedRef], {
      PATH: stubPath,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/SSH_ORIGINAL_COMMAND/);
  });

  test('rejects when required flags are missing', async () => {
    const r = await runShell(['--session', session, '--repo', repo], {
      SSH_ORIGINAL_COMMAND: `git-upload-pack '${repo}'`,
      PATH: stubPath,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/required/);
  });

  test('accepts the space-separated form "git upload-pack"', async () => {
    // Some clients (older Cygwin/MSYS) send `git upload-pack` with a space
    // instead of a dash. The shell regex tolerates both.
    const r = await runShell(['--session', session, '--repo', repo, '--allowed-ref', allowedRef], {
      SSH_ORIGINAL_COMMAND: `git upload-pack '${repo}'`,
      PATH: stubPath,
    });
    expect(r.exitCode).toBe(0);
    const captured = parseShimOut(outFile);
    expect(captured.argv1).toBe(repo);
  });
});
