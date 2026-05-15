// End-to-end test for the per-session git HTTP server: spin up a real
// repo, hit `info/refs` over fetch, and verify the response is a valid
// git smart-HTTP pkt-line stream. Skipped if `git` isn't on PATH.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGitServer } from './git-server';

const hasGit = Bun.which('git') !== null;

let tmp: string;
let repoPath: string;
let hooksDir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'agenta-gitsrv-'));
  repoPath = join(tmp, 'sample-repo');
  hooksDir = join(tmp, 'hooks');
  mkdirSync(hooksDir);
  if (hasGit) {
    spawnSync('git', ['init', '--initial-branch=main', repoPath], { stdio: 'ignore' });
    spawnSync('git', ['-C', repoPath, 'config', 'user.email', 'test@agenta.test']);
    spawnSync('git', ['-C', repoPath, 'config', 'user.name', 'agenta-test']);
    writeFileSync(join(repoPath, 'README.md'), 'hello\n');
    spawnSync('git', ['-C', repoPath, 'add', 'README.md'], { stdio: 'ignore' });
    spawnSync('git', ['-C', repoPath, 'commit', '-m', 'initial'], { stdio: 'ignore' });
    // Allow `git http-backend` to serve push/fetch on the working repo.
    spawnSync('git', ['-C', repoPath, 'config', 'http.receivepack', 'true']);
    spawnSync('git', ['-C', repoPath, 'config', 'http.uploadpack', 'true']);
    writeFileSync(
      join(hooksDir, 'pre-receive'),
      '#!/usr/bin/env bash\nexit 0\n',
      { mode: 0o755 },
    );
  }
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!hasGit)('startGitServer', () => {
  test('serves info/refs for git-upload-pack with a valid pkt-line stream', async () => {
    const server = await startGitServer({
      repoPath,
      allowedRef: 'refs/heads/agenta/sessions/test',
      hooksDir,
    });
    try {
      const url = `http://127.0.0.1:${server.port}/sample-repo.git/info/refs?service=git-upload-pack`;
      const res = await fetch(url);
      expect(res.status).toBe(200);
      const ct = res.headers.get('content-type') ?? '';
      expect(ct).toContain('application/x-git-upload-pack-advertisement');
      const body = await res.text();
      // pkt-line format: leading hex length. The first line for an
      // info/refs response is "# service=git-upload-pack" wrapped in a
      // pkt-line frame.
      expect(body).toContain('service=git-upload-pack');
    } finally {
      await server.stop();
    }
  });

  test('rejects unknown paths with 404', async () => {
    const server = await startGitServer({
      repoPath,
      allowedRef: 'refs/heads/agenta/sessions/test',
      hooksDir,
    });
    try {
      const url = `http://127.0.0.1:${server.port}/wrong.git/info/refs?service=git-upload-pack`;
      const res = await fetch(url);
      expect(res.status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  test('stop() closes the listener', async () => {
    const server = await startGitServer({
      repoPath,
      allowedRef: 'refs/heads/agenta/sessions/test',
      hooksDir,
    });
    const port = server.port;
    await server.stop();
    // After stop, fetch should fail to connect.
    let connected = false;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/sample-repo.git/info/refs?service=git-upload-pack`, {
        signal: AbortSignal.timeout(500),
      });
      connected = res.status > 0;
    } catch {
      // Expected.
    }
    expect(connected).toBe(false);
  });
});
