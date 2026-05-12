import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverInterruptedSessions } from './recovery';
import { readRuntime, writeRuntime } from './runtime-store';
import { threadKey } from './thread';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'agenta-recovery-'));
  process.env.AGENTA_DATA_DIR = dataDir;
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.AGENTA_DATA_DIR;
});

// biome-ignore lint/suspicious/noExplicitAny: stub mimics WebClient surface used by recovery
function makeWebStub(): { web: any; posts: Array<{ channel: string; thread_ts?: string; text: string }> } {
  const posts: Array<{ channel: string; thread_ts?: string; text: string }> = [];
  const web = {
    chat: {
      postMessage: mock(async (args: { channel: string; thread_ts?: string; text: string }) => {
        posts.push(args);
        return { ok: true, ts: `t${posts.length}` };
      }),
    },
  };
  return { web, posts };
}

describe('recoverInterruptedSessions', () => {
  test('posts a notice for each runtime.json then clears it', async () => {
    const tk1 = threadKey('C123', '1700000000.000100');
    const tk2 = threadKey('C456', '1700000001.000200');
    await writeRuntime(tk1, { status: 'running', updated_at: 't' });
    await writeRuntime(tk2, { status: 'stopping', updated_at: 't' });

    const { web, posts } = makeWebStub();
    await recoverInterruptedSessions(web);

    expect(posts).toHaveLength(2);
    const byChannel = Object.fromEntries(posts.map((p) => [p.channel, p]));
    expect(byChannel.C123?.thread_ts).toBe('1700000000.000100');
    expect(byChannel.C123?.text).toMatch(/restarted/);
    expect(byChannel.C123?.text).toMatch(/running/);
    expect(byChannel.C456?.text).toMatch(/stopping/);

    expect(await readRuntime(tk1)).toBeUndefined();
    expect(await readRuntime(tk2)).toBeUndefined();
  });

  test('no-op when there are no interrupted sessions', async () => {
    const { web, posts } = makeWebStub();
    await recoverInterruptedSessions(web);
    expect(posts).toEqual([]);
  });

  test('Slack post failure does not abort recovery of other threads', async () => {
    const tk1 = threadKey('C1', '1700000000.000100');
    const tk2 = threadKey('C2', '1700000001.000200');
    await writeRuntime(tk1, { status: 'running', updated_at: 't' });
    await writeRuntime(tk2, { status: 'running', updated_at: 't' });

    let calls = 0;
    const web = {
      chat: {
        postMessage: mock(async (args: { channel: string }) => {
          calls++;
          if (args.channel === 'C1') throw new Error('channel_not_found');
          return { ok: true, ts: 'ok' };
        }),
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: stub
    await recoverInterruptedSessions(web as any);
    expect(calls).toBe(2);
    // Both runtime entries should be cleared regardless of post success — we
    // don't want to keep re-announcing a dead channel on every boot.
    expect(await readRuntime(tk1)).toBeUndefined();
    expect(await readRuntime(tk2)).toBeUndefined();
  });

  test('clears entries with undecodable threadKey without posting', async () => {
    // Write a runtime.json under a malformed dir name.
    await writeRuntime('no-separator', { status: 'running', updated_at: 't' });
    const { web, posts } = makeWebStub();
    await recoverInterruptedSessions(web);
    expect(posts).toEqual([]);
    expect(await readRuntime('no-separator')).toBeUndefined();
  });
});
