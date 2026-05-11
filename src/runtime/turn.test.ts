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
    // At least one intermediate edit contains the tool bullet.
    expect(edits.some((e) => e.text.includes('• tool: get_current_time'))).toBe(true);

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
