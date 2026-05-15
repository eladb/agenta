// Cache a `known_hosts` file containing the local sshd's ed25519 host key.
// The sandbox uses this to verify the host fingerprint when pushing back —
// without it, every `git push` would either prompt interactively (broken in
// an automated context) or require `StrictHostKeyChecking no` (which would
// expose the sandbox to a MITM trivially).
//
// We probe `ssh-keyscan -t ed25519 localhost` once and cache the result.
// On a host with a stable sshd identity this is a write-once file.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { dataRoot } from '../persistence/store';

function run(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    proc.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
  });
}

export function defaultKnownHostsCacheDir(): string {
  return join(dataRoot(), 'host-keys');
}

export async function ensureKnownHostsCache(
  cacheDir: string = defaultKnownHostsCacheDir(),
): Promise<string> {
  const path = join(cacheDir, 'known_hosts');
  if (existsSync(path)) return path;
  if (!existsSync(dirname(path))) {
    await mkdir(dirname(path), { recursive: true });
  }
  // `ssh-keyscan` writes the host-key line to stdout. We pin to ed25519
  // because that's what modern macOS sshd advertises by default and what
  // the sandbox SSH client expects.
  const res = await run('ssh-keyscan', ['-t', 'ed25519', 'localhost']);
  if (res.exitCode !== 0 || res.stdout.trim().length === 0) {
    throw new Error(`ssh-keyscan localhost failed: ${res.stderr || res.stdout}`);
  }
  await writeFile(path, res.stdout, { mode: 0o644 });
  return path;
}
