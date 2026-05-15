// ed25519 keypair generation via ssh-keygen. We shell out to the system
// binary rather than depending on a JS crypto library so the output format
// is exactly what OpenSSH expects (and the same fingerprint command the
// user would run by hand verifies it).

import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type Keypair = {
  private: string;
  public: string;
  // SHA256 fingerprint of the public key, formatted as `SHA256:<base64>`.
  // ssh-keygen -lf emits this on stdout; we extract the second whitespace-
  // delimited field.
  fingerprint: string;
};

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

export async function generateKeypair(): Promise<Keypair> {
  // ssh-keygen wants a real path it can write two files into. mkdtemp +
  // join would also work; a stamped filename is enough since the temp dir
  // already gives us isolation.
  const stamp = `${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
  const base = join(tmpdir(), `agenta-key-${stamp}`);
  const privPath = base;
  const pubPath = `${base}.pub`;
  try {
    const gen = await run('ssh-keygen', [
      '-t',
      'ed25519',
      '-f',
      privPath,
      '-N',
      '',
      '-C',
      'agenta',
      // Suppress the banner. -q has been a feature of OpenSSH for years.
      '-q',
    ]);
    if (gen.exitCode !== 0) {
      throw new Error(`ssh-keygen failed: ${gen.stderr || gen.stdout}`);
    }
    const [priv, pub] = await Promise.all([readFile(privPath, 'utf8'), readFile(pubPath, 'utf8')]);
    const fp = await run('ssh-keygen', ['-lf', pubPath]);
    if (fp.exitCode !== 0) {
      throw new Error(`ssh-keygen -lf failed: ${fp.stderr || fp.stdout}`);
    }
    // `ssh-keygen -lf` output:
    //   <bits> <SHA256:...> <comment> (<type>)
    const parts = fp.stdout.trim().split(/\s+/);
    const fingerprint = parts[1] ?? '';
    if (!fingerprint.startsWith('SHA256:')) {
      throw new Error(`unexpected ssh-keygen -lf output: ${fp.stdout}`);
    }
    return { private: priv, public: pub.trim(), fingerprint };
  } finally {
    await rm(privPath, { force: true }).catch(() => {});
    await rm(pubPath, { force: true }).catch(() => {});
  }
}
