import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallModel } from '../model/gateway';
import { readEvents } from '../persistence/store';
import { runTurn } from './turn';

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
        return { ok: true, ts: 'TS1' };
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
    const { web, edits } = makeWebStub();
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
    // Final edit should be the reply text.
    expect(edits[edits.length - 1]?.text).toBe('the time is now');
    // At least one intermediate edit contains the tool's describe() bullet.
    expect(edits.some((e) => e.text.includes('• get current time'))).toBe(true);

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

  test('thinking… line is ephemeral: gone before tool bullet, back between tools, gone in final reply', async () => {
    const { web, edits, posts } = makeWebStub();
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
      return { role: 'assistant', content: 'final reply' };
    };

    await runTurn(web, callModel, 'sys', input);

    // Initial post is the thinking line.
    expect(posts[0]?.text).toContain('thinking');

    // No "calling model" anywhere — that's the old text.
    expect(edits.some((e) => e.text.includes('calling model'))).toBe(false);

    // Right after the model returns tool_calls, the thinking line is popped
    // and the tool bullet replaces it. So we expect at least one edit that
    // has the tool bullet but NO thinking line.
    expect(
      edits.some((e) => e.text.includes('• get current time') && !e.text.includes('thinking')),
    ).toBe(true);

    // Between tools and the next model call, thinking is shown again, AFTER
    // the tool bullet.
    expect(
      edits.some((e) => e.text.includes('• get current time') && e.text.endsWith('• thinking…')),
    ).toBe(true);

    // Final edit is just the reply — no checklist artifacts.
    const last = edits[edits.length - 1]?.text;
    expect(last).toBe('final reply');
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
    const { web, edits } = makeWebStub();
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

    expect(edits[edits.length - 1]?.text).toBe('I cannot do that, sorry');

    const events = await readEvents<{ type: string; payload: Record<string, unknown> }>('k1');
    const trs = events.filter((e) => e.type === 'tool_result');
    expect(trs).toHaveLength(1);
    expect(trs[0]?.payload.error).toBe(true);
    expect(trs[0]?.payload.content).toMatch(/unknown tool/);
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
});
