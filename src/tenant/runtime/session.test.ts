import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallModel } from '../model/gateway';
import { newEventId, nowIso, record } from '../persistence/events';
import {
  clearThinking,
  getStatus,
  markThinking,
  resetSessions,
  signalStop,
  startOrQueue,
} from './session';

// Minimal WebClient stub — runTurn uses postInThread/editMessage, which call
// web.chat.postMessage / web.chat.update. Each returns { ts }. The
// reactions.add/remove calls (used by markThinking/clearThinking) are
// recorded so the thinking-reaction tests can assert on them.
function makeWebStub(): {
  // biome-ignore lint/suspicious/noExplicitAny: stub mimics WebClient surface used by turn.ts
  web: any;
  posts: Array<{ text: string }>;
  edits: Array<{ ts: string; text: string }>;
  reactionsAdded: Array<{ ts: string; name: string }>;
  reactionsRemoved: Array<{ ts: string; name: string }>;
} {
  const posts: Array<{ text: string }> = [];
  const edits: Array<{ ts: string; text: string }> = [];
  const reactionsAdded: Array<{ ts: string; name: string }> = [];
  const reactionsRemoved: Array<{ ts: string; name: string }> = [];
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
      delete: mock(async () => ({ ok: true })),
    },
    reactions: {
      add: mock(async (args: { timestamp: string; name: string }) => {
        reactionsAdded.push({ ts: args.timestamp, name: args.name });
        return { ok: true };
      }),
      remove: mock(async (args: { timestamp: string; name: string }) => {
        reactionsRemoved.push({ ts: args.timestamp, name: args.name });
        return { ok: true };
      }),
    },
  };
  return { web, posts, edits, reactionsAdded, reactionsRemoved };
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
    const { web, posts } = makeWebStub();
    const callModel: CallModel = async () => ({ role: 'assistant', content: 'hi' });
    await startOrQueue(web, callModel, 'sys', input);
    expect(getStatus('k1')).toBe('idle');
    // Final reply is posted as a fresh clean message (not an edit) under the
    // rolling-rounds UX. The 💭-prefixed placeholder is also posted, then
    // deleted before the clean final reply lands.
    expect(posts.some((p) => p.text === 'hi')).toBe(true);
  });

  test('session.json is running while in flight, flips to idle after a successful turn', async () => {
    const { readSession } = await import('./session-store');
    const { web } = makeWebStub();
    let observedDuringRun: string | undefined;
    const callModel: CallModel = async () => {
      observedDuringRun = (await readSession('k1'))?.status;
      return { role: 'assistant', content: 'hi' };
    };
    await startOrQueue(web, callModel, 'sys', input);
    expect(observedDuringRun).toBe('running');
    const after = await readSession('k1');
    expect(after?.status).toBe('idle');
  });

  test('session.json flips to stopping when /stop fires mid-turn', async () => {
    const { readSession } = await import('./session-store');
    const { web, edits, posts } = makeWebStub();
    const callModel: CallModel = async (_msgs, opts) => {
      await new Promise<void>((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
      return { role: 'assistant', content: 'unreached' };
    };
    const run = startOrQueue(web, callModel, 'sys', input);
    await new Promise((r) => setTimeout(r, 10));
    await signalStop(web, 'C', '1.0', 'k1');
    // After signalStop, session.json should say "stopping" before the turn
    // actually exits. sandbox + git + home + model + display preserved.
    const duringStop = await readSession('k1');
    expect(duringStop?.status).toBe('stopping');
    await run;
    // Once the loop exits, session.json flips to idle (preserving prompt).
    const after = await readSession('k1');
    expect(after?.status).toBe('idle');
    // "stopped" lands as a post (or an edit if a round message exists);
    // either way it surfaces in the thread.
    const stoppedSeen =
      edits.some((e) => e.text === 'stopped') || posts.some((p) => p.text === 'stopped');
    expect(stoppedSeen).toBe(true);
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
      return { role: 'assistant', content: `reply-${calls}` };
    };
    const first = startOrQueue(web, callModel, 'sys', input);
    // Wait a tick so the first turn is in flight.
    await new Promise((r) => setTimeout(r, 50));
    expect(getStatus('k1')).toBe('running');
    // Second mention arrives mid-turn: should just queue and return.
    await startOrQueue(web, callModel, 'sys', input);
    expect(calls).toBe(1); // not started yet
    release();
    await first;
    expect(calls).toBe(2);
    expect(getStatus('k1')).toBe('idle');
  }, 30000);

  test('signalStop aborts the in-flight turn', async () => {
    const { web, edits, posts } = makeWebStub();
    let aborted = false;
    const callModel: CallModel = async (_messages, opts) => {
      await new Promise<void>((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
      return { role: 'assistant', content: 'unreached' };
    };
    const run = startOrQueue(web, callModel, 'sys', input);
    await new Promise((r) => setTimeout(r, 50));
    await signalStop(web, 'C', '1.0', 'k1');
    await run;
    expect(aborted).toBe(true);
    // "stopped" lands as a post (no live message exists at abort time
    // since the round-message is lazy-created and we haven't seen a
    // model response yet) — or, when an iteration has rendered, as an
    // edit. Either surface is acceptable; both put it in the thread.
    const stoppedSeen =
      edits.some((e) => e.text === 'stopped') || posts.some((p) => p.text === 'stopped');
    expect(stoppedSeen).toBe(true);
    expect(getStatus('k1')).toBe('idle');
  }, 30000);

  test('signalStop on idle thread posts "stopped" ack', async () => {
    const { web, posts } = makeWebStub();
    await signalStop(web, 'C', '1.0', 'k1');
    expect(posts.some((p) => p.text === 'stopped')).toBe(true);
  });

  test('mention during stopping runs a fresh turn after abort', async () => {
    const { web } = makeWebStub();
    let calls = 0;
    const callModel: CallModel = async (_messages, opts) => {
      calls++;
      if (calls === 1) {
        await new Promise<void>((_, reject) => {
          opts?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        });
      }
      return { role: 'assistant', content: `reply-${calls}` };
    };
    const run = startOrQueue(web, callModel, 'sys', input);
    await new Promise((r) => setTimeout(r, 50));
    await signalStop(web, 'C', '1.0', 'k1');
    // New mention arrives after /stop while we're still in 'stopping'.
    await startOrQueue(web, callModel, 'sys', input);
    await run;
    expect(calls).toBe(2);
    expect(getStatus('k1')).toBe('idle');
  }, 15000);

  test('mid-turn steering clears pending and avoids a redundant follow-up turn', async () => {
    const { web } = makeWebStub();
    let n = 0;
    // The model stub fires startOrQueue recursively at iteration 1 (this
    // mirrors handler.ts: a new mention arrives mid-turn → calls
    // startOrQueue → that call sees status='running' → sets pending=true
    // and returns). The turn's steering hook should then clear pending so
    // the post-turn loop exits cleanly without re-running.
    const callModel: CallModel = async () => {
      n++;
      if (n === 1) {
        await record({
          event_id: newEventId(),
          thread_key: 'k1',
          source: 'slack',
          type: 'message',
          ts: nowIso(),
          ingested_at: nowIso(),
          payload: {
            slack_event_id: 'E-mid',
            slack_ts: '5.5',
            user: 'U2',
            text: 'extra: also do X',
          },
        });
        // Simulate the handler-level reentry that sets pending=true.
        await startOrQueue(web, callModel, 'sys', input);
        return {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 't1',
              type: 'function',
              function: { name: 'get_current_time', arguments: '{}' },
            },
          ],
        };
      }
      return { role: 'assistant', content: 'done' };
    };

    await startOrQueue(web, callModel, 'sys', input);

    // Two model calls is enough: iteration 1 with tools + iteration 2
    // final. If pending had survived the steering consume, the session
    // would run another full turn → 4 model calls.
    expect(n).toBe(2);
    expect(getStatus('k1')).toBe('idle');
  });
});

describe('thinking reaction (session-level)', () => {
  test('markThinking adds 🤔 on the mention and a successful turn clears it', async () => {
    const { web, reactionsAdded, reactionsRemoved } = makeWebStub();
    // Handler fires markThinking right before kickoffTurn.
    markThinking(web, 'k1', 'C', '1.5');
    // markThinking fires addReaction fire-and-forget; let it land.
    await new Promise((r) => setTimeout(r, 0));
    expect(reactionsAdded.some((r) => r.ts === '1.5' && r.name === 'thinking_face')).toBe(true);

    const callModel: CallModel = async () => ({ role: 'assistant', content: 'hi' });
    await startOrQueue(web, callModel, 'sys', input);

    // startOrQueue's finally removes the thinking reaction when the thread
    // returns to idle.
    expect(reactionsRemoved.some((r) => r.ts === '1.5' && r.name === 'thinking_face')).toBe(true);
    expect(getStatus('k1')).toBe('idle');
  });

  test('a burst of mentions all get 🤔, all cleared together at idle', async () => {
    const { web, reactionsAdded, reactionsRemoved } = makeWebStub();
    // Three mentions coalesce into one session (one batch).
    markThinking(web, 'k1', 'C', '1.1');
    markThinking(web, 'k1', 'C', '1.2');
    markThinking(web, 'k1', 'C', '1.3');
    await new Promise((r) => setTimeout(r, 0));
    expect(reactionsAdded.filter((r) => r.name === 'thinking_face').map((r) => r.ts).sort()).toEqual(
      ['1.1', '1.2', '1.3'],
    );

    const callModel: CallModel = async () => ({ role: 'assistant', content: 'hi' });
    await startOrQueue(web, callModel, 'sys', input);

    expect(
      reactionsRemoved.filter((r) => r.name === 'thinking_face').map((r) => r.ts).sort(),
    ).toEqual(['1.1', '1.2', '1.3']);
  });

  test('clearThinking removes 🤔 when kickoffTurn throws before startOrQueue', async () => {
    const { web, reactionsAdded, reactionsRemoved } = makeWebStub();
    // Simulate the handler path: markThinking lands, then kickoffTurn throws
    // (e.g. model/home resolution fails) before startOrQueue ever runs — the
    // handler's catch calls clearThinking so nothing is orphaned.
    markThinking(web, 'k1', 'C', '2.2');
    await new Promise((r) => setTimeout(r, 0));
    expect(reactionsAdded.some((r) => r.ts === '2.2' && r.name === 'thinking_face')).toBe(true);

    await clearThinking(web, 'k1');
    expect(reactionsRemoved.some((r) => r.ts === '2.2' && r.name === 'thinking_face')).toBe(true);

    // Idempotent: a second clear (e.g. startOrQueue's finally if it had run)
    // removes nothing more.
    reactionsRemoved.length = 0;
    await clearThinking(web, 'k1');
    expect(reactionsRemoved.length).toBe(0);
  });
});
