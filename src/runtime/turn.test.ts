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
    // Single-message-per-turn: the live message is created on first
    // tool render and EDITED to the final reply. No fresh post for
    // the final.
    const lastEdit = edits[edits.length - 1]?.text;
    expect(lastEdit).toBe('the time is now');
    // Final reply is plain — no leading arrow marker.
    expect(lastEdit?.startsWith('→')).toBe(false);
    // At least one intermediate edit contains the tool's describe() label.
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

    // No pre-model placeholder is posted any more — the 🤔 reaction is
    // the "I'm working on it" signal. The first thing in the thread is
    // the round-1 message itself, with the tool's label as plain text
    // (no bullet, no backticks, no leading "thinking…").
    expect(posts[0]?.text.includes('thinking')).toBe(false);
    expect(posts[0]?.text).toContain('get current time');
    expect(posts[0]?.text.includes('• ')).toBe(false);
    expect(posts[0]?.text.includes('`')).toBe(false);

    // Single-message-per-turn: final reply is an EDIT to the live
    // message (no new post, no delete).
    const lastEdit = edits[edits.length - 1]?.text;
    expect(lastEdit).toBe('final reply');
    expect(lastEdit?.startsWith('→')).toBe(false);
    expect(deletes.length).toBe(0);
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

    // Single-message-per-turn: final reply is an EDIT to the live
    // message that was lazy-created during tool processing.
    expect(edits[edits.length - 1]?.text).toBe('I cannot do that, sorry');

    const events = await readEvents<{ type: string; payload: Record<string, unknown> }>('k1');
    const trs = events.filter((e) => e.type === 'tool_result');
    expect(trs).toHaveLength(1);
    expect(trs[0]?.payload.error).toBe(true);
    expect(trs[0]?.payload.content).toMatch(/unknown tool/);
  });

  test('no "waiting for workspace…" line for tools that do not require the sandbox', async () => {
    const { web, edits } = makeWebStub();
    const callModel: CallModel = async () => ({
      role: 'assistant',
      content: 'done',
    });
    await runTurn(web, callModel, 'sys', input);
    // The model returned a final reply with no tool_calls, so we never even
    // reach the per-tool loop. Sanity check: no workspace-status bullet anywhere.
    expect(edits.some((e) => e.text.includes('waiting for workspace'))).toBe(false);
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
    expect(edits.some((e) => e.text.includes('waiting for workspace'))).toBe(false);
    expect(edits.some((e) => e.text.includes('provisioning workspace'))).toBe(false);
    expect(edits.some((e) => e.text.includes('workspace ready'))).toBe(false);
  });

  test('abort signal during second model call edits the live message to "stopped"', async () => {
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

    // Single-message-per-turn: the live message survives across
    // iterations, so on abort during iteration 2 we edit it to
    // "stopped" (no fresh post).
    expect(edits.some((e) => e.text === 'stopped')).toBe(true);
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
    const { web, edits, posts } = makeWebStub();
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

    // The would-be-final text was rendered into the live message as
    // an italic intermediate. Because the live message didn't exist
    // yet (no tools ran), it gets lazy-POSTED with the italic form
    // here, then EDITED to the final reply on the next iteration.
    const sawIntermediate =
      posts.some((p) => p.text.includes('almost-final answer here')) ||
      edits.some((e) => e.text.includes('almost-final answer here'));
    expect(sawIntermediate).toBe(true);
    // The actual final after steering is the last edit on the live
    // message.
    const finalEdit = edits[edits.length - 1]?.text;
    expect(finalEdit).toBe('final after steering');
    // No clean final POST: the live message is edited in place.
    expect(posts.some((p) => p.text === 'final after steering')).toBe(false);
  });

  test('steering ignores /stop and /delete commands', async () => {
    const { web } = makeWebStub();
    let n = 0;
    let secondCallMessages: Message[] | undefined;
    const callModel: CallModel = async (messages) => {
      n++;
      if (n === 1) {
        // Two messages land mid-turn: a /stop command and a steering one.
        // The command should be filtered (it's handled by handler.ts);
        // the steering text should be injected.
        await record({
          event_id: newEventId(),
          thread_key: 'k1',
          source: 'slack',
          type: 'message',
          ts: nowIso(),
          ingested_at: nowIso(),
          payload: { slack_event_id: 'E1', slack_ts: '3.0', user: 'U2', text: '/stop' },
        });
        await record({
          event_id: newEventId(),
          thread_key: 'k1',
          source: 'slack',
          type: 'message',
          ts: nowIso(),
          ingested_at: nowIso(),
          payload: {
            slack_event_id: 'E2',
            slack_ts: '3.1',
            user: 'U2',
            text: 'really do X',
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
      return { role: 'assistant', content: 'ok' };
    };

    await runTurn(web, callModel, 'sys', input);

    const userTexts = (secondCallMessages ?? [])
      .filter((m) => m.role === 'user' && typeof m.content === 'string')
      .map((m) => m.content as string);
    expect(userTexts.some((t) => t.includes('really do X'))).toBe(true);
    expect(userTexts.some((t) => t === '/stop')).toBe(false);
  });

  test('multiple mid-turn messages: all injected, all reacted, all cleared', async () => {
    const { web, reactionsAdded, reactionsRemoved } = makeWebStub();
    let n = 0;
    const callModel: CallModel = async () => {
      n++;
      if (n === 1) {
        // Three steering messages land during iteration 1.
        for (const slack_ts of ['9.1', '9.2', '9.3']) {
          await record({
            event_id: newEventId(),
            thread_key: 'k1',
            source: 'slack',
            type: 'message',
            ts: nowIso(),
            ingested_at: nowIso(),
            payload: {
              slack_event_id: `E-${slack_ts}`,
              slack_ts,
              user: 'U2',
              text: `update ${slack_ts}`,
            },
          });
        }
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

    for (const ts of ['9.1', '9.2', '9.3']) {
      expect(reactionsAdded.some((r) => r.ts === ts && r.name === 'wheel')).toBe(true);
      expect(reactionsRemoved.some((r) => r.ts === ts && r.name === 'wheel')).toBe(true);
    }
  });

  test('reactions are cleared on abort path', async () => {
    const { web, reactionsAdded, reactionsRemoved } = makeWebStub();
    // Originating message so a thinking reaction lands.
    await record({
      event_id: newEventId(),
      thread_key: 'k1',
      source: 'slack',
      type: 'message',
      ts: nowIso(),
      ingested_at: nowIso(),
      payload: {
        slack_event_id: 'Ev-orig',
        slack_ts: '4.4',
        user: 'U1',
        text: 'long task please',
      },
    });
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
              id: 't1',
              type: 'function',
              function: { name: 'get_current_time', arguments: '{}' },
            },
          ],
        };
      }
      // Hang the second call until aborted.
      await new Promise<void>((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
      return { role: 'assistant', content: 'unreached' };
    };

    const run = runTurn(web, callModel, 'sys', input, controller.signal);
    await new Promise((r) => setTimeout(r, 30));
    controller.abort();
    await run;

    // Thinking reaction was added on the originating message and then
    // removed in the finally block, even though the turn was aborted.
    expect(reactionsAdded.some((r) => r.ts === '4.4' && r.name === 'thinking_face')).toBe(true);
    expect(reactionsRemoved.some((r) => r.ts === '4.4' && r.name === 'thinking_face')).toBe(true);
  });
});
