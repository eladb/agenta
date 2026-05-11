import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallModel } from '../model/gateway';
import { getStatus, resetSessions, signalStop, startOrQueue } from './session';

// Minimal WebClient stub — runTurn uses postInThread/editMessage, which call
// web.chat.postMessage / web.chat.update. Each returns { ts }.
function makeWebStub(): {
  // biome-ignore lint/suspicious/noExplicitAny: stub mimics WebClient surface used by turn.ts
  web: any;
  posts: Array<{ text: string }>;
  edits: Array<{ ts: string; text: string }>;
} {
  const posts: Array<{ text: string }> = [];
  const edits: Array<{ ts: string; text: string }> = [];
  const web = {
    chat: {
      postMessage: mock(async (args: { text: string }) => {
        posts.push({ text: args.text });
        return { ok: true, ts: `t${posts.length}` };
      }),
      update: mock(async (args: { ts: string; text: string }) => {
        edits.push({ ts: args.ts, text: args.text });
        return { ok: true };
      }),
    },
  };
  return { web, posts, edits };
}

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'agenta-session-'));
  process.env.AGENTA_DATA_DIR = dataDir;
  resetSessions();
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.AGENTA_DATA_DIR;
});

const input = { channel: 'C', threadTs: '1.0', threadKey: 'k1' };

describe('session state machine', () => {
  test('runs a turn and returns to idle', async () => {
    const { web, edits } = makeWebStub();
    const callModel: CallModel = async () => 'hi';
    await startOrQueue(web, callModel, 'sys', input);
    expect(getStatus('k1')).toBe('idle');
    expect(edits.some((e) => e.text === 'hi')).toBe(true);
  });

  test('queues a concurrent mention and runs one extra turn after current', async () => {
    const { web } = makeWebStub();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const callModel: CallModel = async () => {
      calls++;
      if (calls === 1) await gate;
      return `reply-${calls}`;
    };
    const first = startOrQueue(web, callModel, 'sys', input);
    // Wait a tick so the first turn is in flight.
    await new Promise((r) => setTimeout(r, 5));
    expect(getStatus('k1')).toBe('running');
    // Second mention arrives mid-turn: should just queue and return.
    await startOrQueue(web, callModel, 'sys', input);
    expect(calls).toBe(1); // not started yet
    release();
    await first;
    expect(calls).toBe(2);
    expect(getStatus('k1')).toBe('idle');
  });

  test('signalStop aborts the in-flight turn', async () => {
    const { web, edits } = makeWebStub();
    let aborted = false;
    const callModel: CallModel = async (_messages, signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
      return 'unreached';
    };
    const run = startOrQueue(web, callModel, 'sys', input);
    await new Promise((r) => setTimeout(r, 5));
    await signalStop(web, 'C', '1.0', 'k1');
    await run;
    expect(aborted).toBe(true);
    expect(edits.some((e) => e.text === 'stopped')).toBe(true);
    expect(getStatus('k1')).toBe('idle');
  });

  test('signalStop on idle thread posts "stopped" ack', async () => {
    const { web, posts } = makeWebStub();
    await signalStop(web, 'C', '1.0', 'k1');
    expect(posts.some((p) => p.text === 'stopped')).toBe(true);
  });

  test('mention during stopping runs a fresh turn after abort', async () => {
    const { web } = makeWebStub();
    let calls = 0;
    const callModel: CallModel = async (_messages, signal) => {
      calls++;
      if (calls === 1) {
        await new Promise<void>((_, reject) => {
          signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        });
      }
      return `reply-${calls}`;
    };
    const run = startOrQueue(web, callModel, 'sys', input);
    await new Promise((r) => setTimeout(r, 5));
    await signalStop(web, 'C', '1.0', 'k1');
    // New mention arrives after /stop while we're still in 'stopping'.
    await startOrQueue(web, callModel, 'sys', input);
    await run;
    expect(calls).toBe(2);
    expect(getStatus('k1')).toBe('idle');
  });
});
