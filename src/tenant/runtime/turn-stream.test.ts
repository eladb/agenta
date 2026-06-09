// Tests for the `task_update` streaming display style (#285). The Slack
// streaming API is stubbed — no real network — so we assert on the chunk
// payloads our render loop hands to startStream/appendStream/stopStream.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallModel } from '../model/gateway';
import { newEventId, nowIso, record } from '../persistence/events';
import { FEEDBACK_ACTION_ID } from './stream-chunks';
import { runTurn } from './turn';

type Chunk = { type: string; [k: string]: unknown };

function makeStreamWebStub(): {
  // biome-ignore lint/suspicious/noExplicitAny: stub mimics the WebClient surface used by the stream path
  web: any;
  starts: Array<Record<string, unknown>>;
  appends: Chunk[];
  stops: Array<{ blocks: unknown[] }>;
  posts: Array<{ text: string; blocks?: unknown }>;
  reactionsAdded: Array<{ ts: string; name: string }>;
  reactionsRemoved: Array<{ ts: string; name: string }>;
} {
  const starts: Array<Record<string, unknown>> = [];
  const appends: Chunk[] = [];
  const stops: Array<{ blocks: unknown[] }> = [];
  const posts: Array<{ text: string; blocks?: unknown }> = [];
  const reactionsAdded: Array<{ ts: string; name: string }> = [];
  const reactionsRemoved: Array<{ ts: string; name: string }> = [];
  const web = {
    chat: {
      startStream: mock(async (args: Record<string, unknown>) => {
        starts.push(args);
        const initial = (args.chunks as Chunk[] | undefined) ?? [];
        for (const c of initial) appends.push(c);
        return { ok: true, ts: 'STREAM1' };
      }),
      appendStream: mock(async (args: { chunks: Chunk[] }) => {
        for (const c of args.chunks) appends.push(c);
        return { ok: true };
      }),
      stopStream: mock(async (args: { chunks: Array<{ blocks?: unknown[] }> }) => {
        const blocks = args.chunks?.[0]?.blocks ?? [];
        stops.push({ blocks });
        return { ok: true };
      }),
      postMessage: mock(async (args: { text: string; blocks?: unknown }) => {
        posts.push({ text: args.text, blocks: args.blocks });
        return { ok: true, ts: `ASK${posts.length}` };
      }),
      update: mock(async () => ({ ok: true })),
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
  return { web, starts, appends, stops, posts, reactionsAdded, reactionsRemoved };
}

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'agenta-turnstream-'));
  process.env.AGENTA_DATA_DIR = dataDir;
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.AGENTA_DATA_DIR;
});

const input = {
  channel: 'C',
  threadTs: '1.0',
  threadKey: 'k1',
  recipientUserId: 'U1',
  recipientTeamId: 'T1',
};

function firstChunkOf(appends: Chunk[]): Chunk | undefined {
  return appends[0];
}

describe('runTurn task_update streaming', () => {
  test('opens the stream lazily in text mode with the recipient pair (no chip)', async () => {
    const { web, starts, appends } = makeStreamWebStub();
    const callModel: CallModel = async () => ({ role: 'assistant', content: 'hi there' });
    await runTurn(web, callModel, 'sys', input, undefined, undefined, 'task_update');

    expect(starts).toHaveLength(1);
    const s = starts[0];
    // No task_display_mode — we stream in plain text mode so a conversation
    // turn carries no leading task-row chip. Recipient pair still required.
    expect(s?.task_display_mode).toBeUndefined();
    expect(s?.recipient_team_id).toBe('T1');
    expect(s?.recipient_user_id).toBe('U1');
    // First chunk for a no-tool reply is the markdown body, not a task row.
    const chunks = s?.chunks as Chunk[];
    expect(chunks[0]?.type).toBe('markdown_text');
    // A pure conversation turn emits no task_update row at all.
    expect(appends.some((c) => c.type === 'task_update')).toBe(false);
  });

  test('a no-tool reply streams markdown then stops with feedback + disclaimer', async () => {
    const { web, appends, stops } = makeStreamWebStub();
    const callModel: CallModel = async () => ({ role: 'assistant', content: 'the answer is 42' });
    await runTurn(web, callModel, 'sys', input, undefined, undefined, 'task_update');

    // The final reply went out as a markdown_text chunk.
    const md = appends.find((c) => c.type === 'markdown_text' && c.text === 'the answer is 42');
    expect(md).toBeDefined();

    // stopStream finalized with feedback buttons + disclaimer.
    expect(stops).toHaveLength(1);
    const blocks = stops[0]?.blocks as Array<{ type: string; elements?: any[] }>;
    const ctxActions = blocks.find((b) => b.type === 'context_actions');
    expect(ctxActions).toBeDefined();
    expect(ctxActions?.elements?.[0]?.action_id).toBe(FEEDBACK_ACTION_ID);
    expect(blocks.some((b) => b.type === 'context')).toBe(true);
  });

  test('a tool turn with no reasoning opens on the real tool row (no placeholder)', async () => {
    const { web, appends } = makeStreamWebStub();
    let n = 0;
    const callModel: CallModel = async () => {
      n++;
      if (n === 1) {
        return {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_t',
              type: 'function',
              function: { name: 'get_current_time', arguments: '{}' },
            },
          ],
        };
      }
      return { role: 'assistant', content: 'done' };
    };
    await runTurn(web, callModel, 'sys', input, undefined, undefined, 'task_update');
    // The very first chunk Slack ever sees is the tool's OWN row — there is no
    // synthetic placeholder "Thinking…" row preceding it.
    const first = firstChunkOf(appends);
    expect(first?.type).toBe('task_update');
    expect(first?.id).toBe('call_t');
    expect(first?.status).toBe('in_progress');
    expect(appends.some((c) => c.id === '__thinking__')).toBe(false);
  });

  test('a tool call becomes one row keyed by tool_call_id: in_progress → complete', async () => {
    const { web, appends } = makeStreamWebStub();
    let n = 0;
    const callModel: CallModel = async () => {
      n++;
      if (n === 1) {
        return {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_z',
              type: 'function',
              function: { name: 'get_current_time', arguments: '{}' },
            },
          ],
        };
      }
      return { role: 'assistant', content: 'done' };
    };
    await runTurn(web, callModel, 'sys', input, undefined, undefined, 'task_update');

    const rows = appends.filter((c) => c.type === 'task_update' && c.id === 'call_z');
    // One in_progress open + one terminal row, same id.
    expect(rows.some((r) => r.status === 'in_progress')).toBe(true);
    expect(rows.some((r) => r.status === 'complete')).toBe(true);
    expect(rows.every((r) => r.id === 'call_z')).toBe(true);
  });

  test('a failing tool flips its row to error but the stream still stops', async () => {
    const { web, appends, stops } = makeStreamWebStub();
    let n = 0;
    const callModel: CallModel = async () => {
      n++;
      if (n === 1) {
        return {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_err',
              type: 'function',
              function: { name: 'does_not_exist', arguments: '{}' },
            },
          ],
        };
      }
      return { role: 'assistant', content: 'recovered' };
    };
    await runTurn(web, callModel, 'sys', input, undefined, undefined, 'task_update');

    const errRow = appends.find(
      (c) => c.type === 'task_update' && c.id === 'call_err' && c.status === 'error',
    );
    expect(errRow).toBeDefined();
    // Stream always closes.
    expect(stops).toHaveLength(1);
  });

  test('on model error: active row flips to error, body streamed, stream closed', async () => {
    const { web, appends, stops } = makeStreamWebStub();
    const callModel: CallModel = async () => {
      throw new Error('model exploded');
    };
    await runTurn(web, callModel, 'sys', input, undefined, undefined, 'task_update');

    // A legible error body was streamed.
    expect(
      appends.some((c) => c.type === 'markdown_text' && /model exploded/.test(String(c.text))),
    ).toBe(true);
    // Stream is never left open.
    expect(stops).toHaveLength(1);
  });

  test('ask_user posts its blocks off-stream while a row tracks it', async () => {
    const { web, appends, posts } = makeStreamWebStub();
    let n = 0;
    const callModel: CallModel = async () => {
      n++;
      if (n === 1) {
        return {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'ask1',
              type: 'function',
              function: {
                name: 'ask_user',
                arguments: JSON.stringify({
                  question: 'pick',
                  kind: 'buttons',
                  options: ['a', 'b'],
                }),
              },
            },
          ],
        };
      }
      return { role: 'assistant', content: 'thanks' };
    };

    // Resolve the ask shortly after it registers (simulate a button click via
    // a same-thread resolution). We resolve by thread text through the asks
    // registry import to keep it simple.
    const { resolveByThreadText } = await import('./asks');
    const runP = runTurn(web, callModel, 'sys', input, undefined, undefined, 'task_update');
    // Give the ask a moment to register, then resolve it.
    await new Promise((r) => setTimeout(r, 50));
    resolveByThreadText('k1', 'a');
    await runP;

    // ask_user posted a SEPARATE thread message with interactive blocks
    // (off-stream, not via appendStream).
    const askPost = posts.find((p) => Array.isArray(p.blocks));
    expect(askPost).toBeDefined();
    // The stream shows an "Asking…" row that flips to complete.
    const askRows = appends.filter((c) => c.type === 'task_update' && c.id === 'ask1');
    expect(askRows.some((r) => r.title === 'Asking…')).toBe(true);
    expect(askRows.some((r) => r.status === 'complete')).toBe(true);
  });

  test('does NOT self-add the 🤔 reaction — that is handler-owned (#284)', async () => {
    // The 🤔 reaction is added by the handler (session.ts:markThinking) when a
    // mention commits, for all display styles. The streaming turn must not add
    // its own, or it would double up with the handler's. (Verbose/pretty does
    // the same — see #284.)
    const { web, reactionsAdded } = makeStreamWebStub();
    await record({
      event_id: newEventId(),
      thread_key: 'k1',
      source: 'slack',
      type: 'message',
      ts: nowIso(),
      ingested_at: nowIso(),
      payload: { slack_event_id: 'Ev', slack_ts: '1.5', user: 'U1', text: 'hi' },
    });
    const callModel: CallModel = async () => ({ role: 'assistant', content: 'hello' });
    await runTurn(web, callModel, 'sys', input, undefined, undefined, 'task_update');

    expect(reactionsAdded.some((r) => r.name === 'thinking_face')).toBe(false);
  });

  test('abort during the second model call still closes the stream', async () => {
    const { web, stops } = makeStreamWebStub();
    const controller = new AbortController();
    let n = 0;
    const callModel: CallModel = async (_messages, opts) => {
      n++;
      if (n === 1) {
        return {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'get_current_time', arguments: '{}' } },
          ],
        };
      }
      await new Promise<void>((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
      return { role: 'assistant', content: 'unreached' };
    };

    const run = runTurn(web, callModel, 'sys', input, controller.signal, undefined, 'task_update');
    await new Promise((r) => setTimeout(r, 30));
    controller.abort();
    await run;
    expect(stops).toHaveLength(1);
  });
});
