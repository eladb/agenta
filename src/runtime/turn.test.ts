import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallModel, Message } from '../model/gateway';
import { newEventId, nowIso, record } from '../persistence/events';
import { readEvents } from '../persistence/store';
import { runTurn } from './turn';

function makeWebStub(): {
  // biome-ignore lint/suspicious/noExplicitAny: stub mimics WebClient surface used by turn.ts
  web: any;
  posts: Array<{ text: string }>;
  edits: Array<{ ts: string; text: string }>;
  deletes: Array<{ ts: string }>;
  reactionsAdded: Array<{ ts: string; name: string }>;
  reactionsRemoved: Array<{ ts: string; name: string }>;
} {
  const posts: Array<{ text: string }> = [];
  const edits: Array<{ ts: string; text: string }> = [];
  const deletes: Array<{ ts: string }> = [];
  const reactionsAdded: Array<{ ts: string; name: string }> = [];
  const reactionsRemoved: Array<{ ts: string; name: string }> = [];
  let nextTs = 0;
  const web = {
    chat: {
      postMessage: mock(async (args: { text: string }) => {
        nextTs += 1;
        posts.push({ text: args.text });
        return { ok: true, ts: `TS${nextTs}` };
      }),
      update: mock(async (args: { ts: string; text: string }) => {
        edits.push({ ts: args.ts, text: args.text });
        return { ok: true };
      }),
      delete: mock(async (args: { ts: string }) => {
        deletes.push({ ts: args.ts });
        return { ok: true };
      }),
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
  return { web, posts, edits, deletes, reactionsAdded, reactionsRemoved };
}

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'agenta-turn-'));
  process.env.AGENTA_DATA_DIR = dataDir;
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.AGENTA_DATA_DIR;
});

const input = { channel: 'C', threadTs: '1.0', threadKey: 'k1' };

describe('runTurn with tools', () => {
  test('happy path: tool_call -> tool execution -> final reply', async () => {
    const { web, edits, posts } = makeWebStub();
    let n = 0;
    const callModel: CallModel = async (messages) => {
      n++;
      if (n === 1) {
        // Second-to-last must be the user message; we shouldn't see a tool message yet.
        expect(messages.some((m) => m.role === 'tool')).toBe(false);
        return {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_x',
              type: 'function',
              function: { name: 'get_current_time', arguments: '{}' },
            },
          ],
        };
      }
      // Second call: the tool message must be present.
      const tool = messages.find((m) => m.role === 'tool');
      expect(tool).toBeDefined();
      return { role: 'assistant', content: 'the time is now' };
    };

    await runTurn(web, callModel, 'sys', input);

    expect(n).toBe(2);
    // Final reply is posted as a fresh clean message (no 💭 marker).
    const lastPost = posts[posts.length - 1]?.text;
    expect(lastPost).toBe('the time is now');
    // Final reply is plain — no leading arrow marker.
    expect(lastPost?.startsWith('→')).toBe(false);
    // At least one intermediate edit contains the tool's describe() label
    // as plain text (no bullet, no backticks under the new layout).
    expect(edits.some((e) => e.text.includes('get current time'))).toBe(true);

    const events = await readEvents<{
      source: string;
      type: string;
      event_id?: string;
      payload: Record<string, unknown>;
    }>('k1');
    // 2 assistant messages + 1 tool_call + 1 tool_result
    expect(events.filter((e) => e.type === 'message' && e.source === 'assistant')).toHaveLength(2);
    const tcs = events.filter((e) => e.type === 'tool_call');
    expect(tcs).toHaveLength(1);
    expect(tcs[0]?.payload.name).toBe('get_current_time');
    expect(tcs[0]?.payload.tool_call_id).toBe('call_x');
    const trs = events.filter((e) => e.type === 'tool_result');
    expect(trs).toHaveLength(1);
    expect(trs[0]?.payload.tool_call_id).toBe('call_x');
    expect(typeof trs[0]?.payload.content).toBe('string');
    // tool_call.parent_event_id matches the first assistant message event_id
    const firstAssistant = events.find((e) => e.type === 'message' && e.source === 'assistant');
    expect(tcs[0]?.payload.parent_event_id).toBe(firstAssistant?.event_id);
  });

  test('rolling rounds: arrow placeholder, tool block, clean final post', async () => {
    const { web, edits, posts, deletes } = makeWebStub();
    let n = 0;
    const callModel: CallModel = async () => {
      n++;
      if (n === 1) {
        return {
          role: 'assistant',
          content: null, // no reasoning text → header should NOT persist
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'get_current_time', arguments: '{}' },
            },
          ],
        };
      }
      return { role: 'assistant', content: 'final reply' };
    };

    await runTurn(web, callModel, 'sys', input);

    // First post is the round-1 placeholder: italicized 'thinking…'.
    // mdToMrkdwn converts the standard *italic* form to Slack's _italic_.
    expect(posts[0]?.text).toBe('_thinking…_');

    // When the model emits no reasoning text, the placeholder is REPLACED
    // by the tool rendering — no stranded "thinking…" line above the tool.
    // The tool appears as plain text (no bullet, no backticks).
    const toolEdit = edits.find((e) => e.text.includes('get current time'));
    expect(toolEdit).toBeDefined();
    expect(toolEdit?.text.includes('thinking')).toBe(false);
    expect(toolEdit?.text.includes('• ')).toBe(false);
    expect(toolEdit?.text.includes('`')).toBe(false);

    // Final reply is posted as a fresh plain message (no arrow marker) and
    // the in-flight placeholder was deleted.
    const lastPost = posts[posts.length - 1]?.text;
    expect(lastPost).toBe('final reply');
    expect(lastPost?.startsWith('→')).toBe(false);
    expect(deletes.length).toBeGreaterThan(0);
  });

  test('multiple tool_calls in one response are executed in order', async () => {
    const { web } = makeWebStub();
    let n = 0;
    const callModel: CallModel = async (messages) => {
      n++;
      if (n === 1) {
        return {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_a',
              type: 'function',
              function: { name: 'get_current_time', arguments: '{}' },
            },
            {
              id: 'call_b',
              type: 'function',
              function: { name: 'get_current_time', arguments: '{}' },
            },
          ],
        };
      }
      // Second call must see BOTH tool messages, in order.
      const toolMsgs = messages.filter((m) => m.role === 'tool');
      expect(toolMsgs).toHaveLength(2);
      if (toolMsgs[0]?.role !== 'tool' || toolMsgs[1]?.role !== 'tool') throw new Error('not tool');
      expect(toolMsgs[0].tool_call_id).toBe('call_a');
      expect(toolMsgs[1].tool_call_id).toBe('call_b');
      return { role: 'assistant', content: 'done' };
    };

    await runTurn(web, callModel, 'sys', input);

    const events = await readEvents<{ type: string; payload: Record<string, unknown> }>('k1');
    const tcs = events.filter((e) => e.type === 'tool_call');
    const trs = events.filter((e) => e.type === 'tool_result');
    expect(tcs).toHaveLength(2);
    expect(trs).toHaveLength(2);
    // Order in JSONL: call_a's tool_call, call_a's tool_result, call_b's tool_call, call_b's tool_result.
    const seq = events
      .filter((e) => e.type === 'tool_call' || e.type === 'tool_result')
      .map((e) => `${e.type}:${e.payload.tool_call_id}`);
    expect(seq).toEqual([
      'tool_call:call_a',
      'tool_result:call_a',
      'tool_call:call_b',
      'tool_result:call_b',
    ]);
  });

  test('tool execution error is recorded and the loop recovers', async () => {
    const { web, edits, posts } = makeWebStub();
    let n = 0;
    const callModel: CallModel = async (messages) => {
      n++;
      if (n === 1) {
        return {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_err',
              type: 'function',
              // Unknown tool -> invokeTool returns an error result.
              function: { name: 'does_not_exist', arguments: '{}' },
            },
          ],
        };
      }
      const toolMsg = messages.find((m) => m.role === 'tool');
      if (toolMsg?.role !== 'tool') throw new Error('expected tool msg');
      expect(toolMsg.content).toMatch(/unknown tool/);
      return { role: 'assistant', content: 'I cannot do that, sorry' };
    };

    await runTurn(web, callModel, 'sys', input);

    // Final reply lands as a fresh post (not an edit) after the tool error.
    expect(posts[posts.length - 1]?.text).toBe('I cannot do that, sorry');

    const events = await readEvents<{ type: string; payload: Record<string, unknown> }>('k1');
    const trs = events.filter((e) => e.type === 'tool_result');
    expect(trs).toHaveLength(1);
    expect(trs[0]?.payload.error).toBe(true);
    expect(trs[0]?.payload.content).toMatch(/unknown tool/);
  });

  test('no "provisioning workspace…" line for tools that do not require the sandbox', async () => {
    const { web, edits } = makeWebStub();
    const callModel: CallModel = async () => ({
      role: 'assistant',
      content: 'done',
    });
    await runTurn(web, callModel, 'sys', input);
    // The model returned a final reply with no tool_calls, so we never even
    // reach the per-tool loop. Sanity check: no provisioning bullet anywhere.
    expect(edits.some((e) => e.text.includes('provisioning workspace'))).toBe(false);
  });

  test('non-sandbox tools (get_current_time) skip the sandbox-provisioning UI', async () => {
    const { web, edits } = makeWebStub();
    let n = 0;
    const callModel: CallModel = async () => {
      n++;
      if (n === 1) {
        return {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'get_current_time', arguments: '{}' },
            },
          ],
        };
      }
      return { role: 'assistant', content: 'time is now' };
    };

    await runTurn(web, callModel, 'sys', input);
    // get_current_time has no `requiresSandbox` flag, so the turn must not
    // surface a workspace status line at any point.
    expect(edits.some((e) => e.text.includes('provisioning workspace'))).toBe(false);
    expect(edits.some((e) => e.text.includes('workspace ready'))).toBe(false);
  });

  test('abort signal during second model call edits checklist to "stopped"', async () => {
    const { web, edits } = makeWebStub();
    const controller = new AbortController();
    let n = 0;
    const callModel: CallModel = async (_messages, opts) => {
      n++;
      if (n === 1) {
        return {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'get_current_time', arguments: '{}' },
            },
          ],
        };
      }
      // Second call hangs until aborted.
      await new Promise<void>((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
      return { role: 'assistant', content: 'unreached' };
    };

    const run = runTurn(web, callModel, 'sys', input, controller.signal);
    // Let the first model call + tool execution complete.
    await new Promise((r) => setTimeout(r, 30));
    controller.abort();
    await run;

    expect(edits[edits.length - 1]?.text).toBe('stopped');
  });

  test('steering: mid-turn user message is injected before the next model call', async () => {
    const { web } = makeWebStub();
    let n = 0;
    let secondCallMessages: Message[] | undefined;
    const callModel: CallModel = async (messages) => {
      n++;
      if (n === 1) {
        // Simulate a user mention landing AFTER the initial buildMessages /
        // consumed-set snapshot but BEFORE the next iteration. Recording
        // into JSONL is exactly what handler.ts does for incoming Slack
        // messages, so this matches production wiring.
        await record({
          event_id: newEventId(),
          thread_key: 'k1',
          source: 'slack',
          type: 'message',
          ts: nowIso(),
          ingested_at: nowIso(),
          payload: {
            slack_event_id: 'Ev-mid',
            slack_ts: '2.0',
            user: 'U2',
            text: 'actually wait — output JSON instead',
          },
        });
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
      secondCallMessages = messages;
      return { role: 'assistant', content: 'ok, returning JSON' };
    };

    let consumedSignals = 0;
    await runTurn(web, callModel, 'sys', input, undefined, () => {
      consumedSignals += 1;
    });

    expect(secondCallMessages).toBeDefined();
    // The steering message landed in the messages array as a `user` role
    // entry, after the tool flow from iteration 1.
    expect(
      secondCallMessages?.some(
        (m) =>
          m.role === 'user' &&
          typeof m.content === 'string' &&
          m.content.includes('actually wait'),
      ),
    ).toBe(true);
    // The bot signaled to session.ts that a mid-turn mention was consumed.
    expect(consumedSignals).toBeGreaterThan(0);
  });

  test('reactions: thinking_face on the originating message, removed on turn end', async () => {
    const { web, reactionsAdded, reactionsRemoved } = makeWebStub();
    // Pre-record the originating slack mention so the turn finds a
    // message to react on.
    await record({
      event_id: newEventId(),
      thread_key: 'k1',
      source: 'slack',
      type: 'message',
      ts: nowIso(),
      ingested_at: nowIso(),
      payload: {
        slack_event_id: 'Ev-orig',
        slack_ts: '1.5',
        user: 'U1',
        text: 'hi',
      },
    });
    const callModel: CallModel = async () => ({ role: 'assistant', content: 'hello' });

    await runTurn(web, callModel, 'sys', input);

    expect(reactionsAdded.some((r) => r.ts === '1.5' && r.name === 'thinking_face')).toBe(true);
    expect(reactionsRemoved.some((r) => r.ts === '1.5' && r.name === 'thinking_face')).toBe(true);
  });

  test('reactions: steering wheel on injected mid-turn messages', async () => {
    const { web, reactionsAdded, reactionsRemoved } = makeWebStub();
    let n = 0;
    const callModel: CallModel = async () => {
      n++;
      if (n === 1) {
        // Inject a mid-turn user message during iteration 1.
        await record({
          event_id: newEventId(),
          thread_key: 'k1',
          source: 'slack',
          type: 'message',
          ts: nowIso(),
          ingested_at: nowIso(),
          payload: {
            slack_event_id: 'Ev-mid',
            slack_ts: '7.7',
            user: 'U2',
            text: 'also do X',
          },
        });
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

    await runTurn(web, callModel, 'sys', input);

    expect(reactionsAdded.some((r) => r.ts === '7.7' && r.name === 'wheel')).toBe(true);
    expect(reactionsRemoved.some((r) => r.ts === '7.7' && r.name === 'wheel')).toBe(true);
  });

  test('steering on no-tool-calls path: would-be-final becomes intermediate, loop continues', async () => {
    const { web, posts } = makeWebStub();
    let n = 0;
    const callModel: CallModel = async () => {
      n++;
      if (n === 1) {
        // Model thinks it's done — but inject a steering message just
        // before this response is delivered, so the turn should NOT post
        // a clean final reply.
        await record({
          event_id: newEventId(),
          thread_key: 'k1',
          source: 'slack',
          type: 'message',
          ts: nowIso(),
          ingested_at: nowIso(),
          payload: {
            slack_event_id: 'Ev-mid',
            slack_ts: '2.0',
            user: 'U2',
            text: 'wait, also do X',
          },
        });
        return { role: 'assistant', content: 'almost-final answer here' };
      }
      return { role: 'assistant', content: 'final after steering' };
    };

    await runTurn(web, callModel, 'sys', input);

    // The almost-final text should NOT have been posted as a clean final
    // message — only the post-steering reply is.
    const cleanFinals = posts.filter((p) => p.text === 'almost-final answer here');
    expect(cleanFinals.length).toBe(0);
    // The actual final after steering is posted clean.
    const finalPost = posts[posts.length - 1]?.text;
    expect(finalPost).toBe('final after steering');
  });
});
