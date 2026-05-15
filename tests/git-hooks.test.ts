// Integration test for git-hooks/pre-receive.
//
// Drives the hook directly via spawn, feeding it `<old> <new> <ref>` lines
// on stdin and setting AGENTA_ALLOWED_REF. We don't need a full ssh round-
// trip to verify the policy — the hook is a self-contained bash script.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function commandExists(name: string): boolean {
  return Bun.which(name) !== null;
}

const HOOK_PATH = join(import.meta.dir, '..', 'git-hooks', 'pre-receive');

const ZERO = '0000000000000000000000000000000000000000';

async function runHook(
  stdin: string,
  env: Record<string, string>,
  cwd: string,
): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(HOOK_PATH, [], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    proc.on('close', (code) => {
      resolve({ exitCode: code ?? -1, stderr });
    });
    proc.stdin.end(stdin);
  });
}

function gitInit(dir: string, bare = false): void {
  const args = ['init'];
  if (bare) args.push('--bare');
  args.push(dir);
  const res = spawnSync('git', args);
  if (res.status !== 0) throw new Error(`git init failed: ${res.stderr.toString()}`);
}

function gitIn(dir: string, args: string[]): { stdout: string; status: number } {
  const res = spawnSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  return { stdout: res.stdout.toString('utf8'), status: res.status ?? -1 };
}

function commit(dir: string, file: string, body: string, msg: string): string {
  Bun.write(join(dir, file), body);
  if (gitIn(dir, ['add', file]).status !== 0) throw new Error('git add failed');
  // The test environment may lack a git identity — set one locally.
  gitIn(dir, ['config', 'user.email', 'test@agenta.local']);
  gitIn(dir, ['config', 'user.name', 'agenta-test']);
  if (gitIn(dir, ['commit', '-m', msg]).status !== 0) throw new Error('git commit failed');
  const sha = gitIn(dir, ['rev-parse', 'HEAD']).stdout.trim();
  return sha;
}

describe.skipIf(!commandExists('git'))('git-hooks/pre-receive', () => {
  let workDir: string;
  let sha1: string;
  let sha2: string;
  let sha3: string;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'agenta-hook-work-'));
    rmSync(workDir, { recursive: true, force: true });
    gitInit(workDir);
    sha1 = commit(workDir, 'a.txt', 'one\n', 'one');
    sha2 = commit(workDir, 'a.txt', 'two\n', 'two');
    sha3 = commit(workDir, 'a.txt', 'three\n', 'three');
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test('rejects when AGENTA_ALLOWED_REF is unset', async () => {
    const r = await runHook(`${ZERO} ${sha1} refs/heads/agenta/sessions/x\n`, {}, workDir);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('AGENTA_ALLOWED_REF');
  });

  test('accepts initial creation of the allowed ref', async () => {
    const allowed = 'refs/heads/agenta/sessions/abc';
    const r = await runHook(
      `${ZERO} ${sha1} ${allowed}\n`,
      { AGENTA_ALLOWED_REF: allowed },
      workDir,
    );
    expect(r.exitCode).toBe(0);
  });

  test('rejects any other ref', async () => {
    const allowed = 'refs/heads/agenta/sessions/abc';
    const r = await runHook(
      `${ZERO} ${sha1} refs/heads/main\n`,
      { AGENTA_ALLOWED_REF: allowed },
      workDir,
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('not allowed');
  });

  test('accepts fast-forward update on the allowed ref', async () => {
    const allowed = 'refs/heads/agenta/sessions/abc';
    // sha2 is a descendant of sha1 (they're consecutive commits on the same
    // branch in workDir), so this is a fast-forward.
    const r = await runHook(
      `${sha1} ${sha2} ${allowed}\n`,
      { AGENTA_ALLOWED_REF: allowed },
      workDir,
    );
    expect(r.exitCode).toBe(0);
  });

  test('rejects non-fast-forward update', async () => {
    const allowed = 'refs/heads/agenta/sessions/abc';
    // sha3 -> sha1 is going backwards: sha3 is not an ancestor of sha1.
    const r = await runHook(
      `${sha3} ${sha1} ${allowed}\n`,
      { AGENTA_ALLOWED_REF: allowed },
      workDir,
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('non-fast-forward');
  });

  test('rejects mixed input if any single ref is disallowed', async () => {
    const allowed = 'refs/heads/agenta/sessions/abc';
    const r = await runHook(
      `${ZERO} ${sha1} ${allowed}\n${ZERO} ${sha1} refs/heads/main\n`,
      { AGENTA_ALLOWED_REF: allowed },
      workDir,
    );
    expect(r.exitCode).not.toBe(0);
  });
});
