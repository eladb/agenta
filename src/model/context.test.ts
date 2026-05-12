import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent } from '../persistence/store';
import { buildMessages } from './context';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agenta-ctx-'));
  process.env.AGENTA_DATA_DIR = dir;
});

afterEach(() => {
  delete process.env.AGENTA_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

function writeAttachment(threadKey: string, name: string, bytes: Uint8Array | string): void {
  const attachDir = join(dir, threadKey, 'attachments');
  mkdirSync(attachDir, { recursive: true });
  writeFileSync(join(attachDir, name), bytes);
}

describe('buildMessages', () => {
  it('returns just the system prompt for an empty thread', async () => {
    const m = await buildMessages('empty', 'you are a bot');
    expect(m).toEqual([{ role: 'system', content: 'you are a bot' }]);
  });

  it('projects slack/message events as user and assistant/message as assistant, in order', async () => {
    await appendEvent('t', {
      source: 'slack',
      type: 'message',
      payload: { slack_ts: '1', text: 'hello' },
    });
    await appendEvent('t', {
      source: 'assistant',
      type: 'message',
      payload: { slack_ts: '2', text: 'hi there' },
    });
    await appendEvent('t', {
      source: 'slack',
      type: 'message',
      payload: { slack_ts: '3', text: 'who are you' },
    });
    const m = await buildMessages('t', 'sys');
    expect(m).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
      { role: 'user', content: 'who are you' },
    ]);
  });

  it('skips edit and delete events', async () => {
    await appendEvent('t', {
      source: 'slack',
      type: 'message',
      payload: { slack_ts: '1', text: 'hello' },
    });
    await appendEvent('t', {
      source: 'slack',
      type: 'edit',
      payload: { slack_ts: '1', new_text: 'hi' },
    });
    await appendEvent('t', {
      source: 'slack',
      type: 'delete',
      payload: { slack_ts: '1' },
    });
    const m = await buildMessages('t', 'sys');
    expect(m).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('inlines an image attachment as an image_url data URI', async () => {
    const imgBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeAttachment('t', 'F1-shot.png', imgBytes);
    await appendEvent('t', {
      source: 'slack',
      type: 'message',
      payload: {
        slack_ts: '1',
        text: 'what is this',
        files: [
          {
            file_id: 'F1',
            name: 'shot.png',
            mimetype: 'image/png',
            local_path: 'attachments/F1-shot.png',
          },
        ],
      },
    });
    const m = await buildMessages('t', 'sys');
    expect(m).toHaveLength(2);
    expect(m[1]?.role).toBe('user');
    const parts = m[1]?.content as Array<{
      type: string;
      text?: string;
      image_url?: { url: string };
    }>;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: 'text', text: 'what is this' });
    expect(parts[1]?.type).toBe('image_url');
    const url = parts[1]?.image_url?.url ?? '';
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('inlines a PDF attachment as an image_url data URI with application/pdf', async () => {
    writeAttachment('t', 'F2-doc.pdf', new TextEncoder().encode('%PDF-1.4 stub'));
    await appendEvent('t', {
      source: 'slack',
      type: 'message',
      payload: {
        slack_ts: '1',
        text: '',
        files: [
          {
            file_id: 'F2',
            name: 'doc.pdf',
            mimetype: 'application/pdf',
            local_path: 'attachments/F2-doc.pdf',
          },
        ],
      },
    });
    const m = await buildMessages('t', 'sys');
    const parts = m[1]?.content as Array<{ type: string; image_url?: { url: string } }>;
    expect(parts).toHaveLength(1); // no text part when text is empty
    expect(parts[0]?.type).toBe('image_url');
    expect(parts[0]?.image_url?.url.startsWith('data:application/pdf;base64,')).toBe(true);
  });

  it('inlines a small text file as a text content part', async () => {
    writeAttachment('t', 'F3-notes.txt', 'hello from a text file');
    await appendEvent('t', {
      source: 'slack',
      type: 'message',
      payload: {
        slack_ts: '1',
        text: 'look at this',
        files: [
          {
            file_id: 'F3',
            name: 'notes.txt',
            mimetype: 'text/plain',
            local_path: 'attachments/F3-notes.txt',
          },
        ],
      },
    });
    const m = await buildMessages('t', 'sys');
    const parts = m[1]?.content as Array<{ type: string; text?: string }>;
    expect(parts[0]).toEqual({ type: 'text', text: 'look at this' });
    expect(parts[1]?.type).toBe('text');
    expect(parts[1]?.text).toContain('[attached file: notes.txt]');
    expect(parts[1]?.text).toContain('hello from a text file');
  });

  it('truncates large text files at 20KB', async () => {
    const big = 'a'.repeat(30 * 1024);
    writeAttachment('t', 'F4-big.txt', big);
    await appendEvent('t', {
      source: 'slack',
      type: 'message',
      payload: {
        slack_ts: '1',
        text: '',
        files: [
          {
            file_id: 'F4',
            name: 'big.txt',
            mimetype: 'text/plain',
            local_path: 'attachments/F4-big.txt',
          },
        ],
      },
    });
    const m = await buildMessages('t', 'sys');
    const parts = m[1]?.content as Array<{ type: string; text?: string }>;
    expect(parts[0]?.text).toContain('…[truncated');
    expect(parts[0]?.text?.length).toBeLessThan(big.length);
  });

  it('emits a placeholder for unknown / unsupported types', async () => {
    writeAttachment('t', 'F5-blob.bin', new Uint8Array([0, 1, 2, 3]));
    await appendEvent('t', {
      source: 'slack',
      type: 'message',
      payload: {
        slack_ts: '1',
        text: '',
        files: [
          {
            file_id: 'F5',
            name: 'blob.bin',
            mimetype: 'application/octet-stream',
            local_path: 'attachments/F5-blob.bin',
          },
        ],
      },
    });
    const m = await buildMessages('t', 'sys');
    const parts = m[1]?.content as Array<{ type: string; text?: string }>;
    expect(parts[0]).toEqual({
      type: 'text',
      text: '[attached: blob.bin (application/octet-stream) — not passed to model]',
    });
  });

  it('keeps string content (not array) for messages with no files', async () => {
    await appendEvent('t', {
      source: 'slack',
      type: 'message',
      payload: { slack_ts: '1', text: 'just text', files: [] },
    });
    const m = await buildMessages('t', 'sys');
    expect(m[1]?.content).toBe('just text');
  });

  it('synthesizes a stub tool message for orphan tool_calls (no recorded tool_result)', async () => {
    // Simulates a turn that crashed after recording the assistant + tool_call
    // but before invokeTool / tool_result were persisted. The assistant
    // tool_calls -> tool message invariant the model API requires must still
    // hold on reconstruction; otherwise the next turn's request is rejected.
    await appendEvent('t', {
      source: 'slack',
      type: 'message',
      payload: { slack_ts: '1', text: 'time?' },
    });
    await appendEvent('t', {
      event_id: 'a_orphan',
      source: 'assistant',
      type: 'message',
      payload: { slack_ts: '1.1', text: '' },
    });
    await appendEvent('t', {
      source: 'assistant',
      type: 'tool_call',
      payload: {
        parent_event_id: 'a_orphan',
        tool_call_id: 'call_orphan',
        name: 'get_current_time',
        arguments_json: '{}',
      },
    });
    // No tool_result event for call_orphan.

    const m = await buildMessages('t', 'sys');
    expect(m).toHaveLength(4);
    const a = m[2];
    if (a?.role !== 'assistant') throw new Error('expected assistant');
    expect(a.tool_calls).toHaveLength(1);
    const stub = m[3];
    if (stub?.role !== 'tool') throw new Error('expected synthesized tool msg');
    expect(stub.tool_call_id).toBe('call_orphan');
    expect(stub.content).toMatch(/not recorded/);
  });

  it('reattaches tool_calls to their parent assistant message and emits role:tool messages', async () => {
    await appendEvent('t', {
      source: 'slack',
      type: 'message',
      payload: { slack_ts: '1', text: 'what time is it?' },
    });
    await appendEvent('t', {
      event_id: 'a1',
      source: 'assistant',
      type: 'message',
      payload: { slack_ts: '1.1', text: '' },
    });
    await appendEvent('t', {
      source: 'assistant',
      type: 'tool_call',
      payload: {
        parent_event_id: 'a1',
        tool_call_id: 'call_1',
        name: 'get_current_time',
        arguments_json: '{}',
      },
    });
    await appendEvent('t', {
      source: 'assistant',
      type: 'tool_result',
      payload: { tool_call_id: 'call_1', content: '2026-01-01T00:00:03Z' },
    });
    await appendEvent('t', {
      event_id: 'a2',
      source: 'assistant',
      type: 'message',
      payload: { slack_ts: '1.1', text: 'it is 2026-01-01' },
    });

    const messages = await buildMessages('t', 'sys');

    expect(messages).toHaveLength(5);
    expect(messages[1]).toEqual({ role: 'user', content: 'what time is it?' });
    const a1 = messages[2];
    if (a1?.role !== 'assistant') throw new Error('expected assistant at [2]');
    expect(a1.content).toBeNull();
    expect(a1.tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'get_current_time', arguments: '{}' } },
    ]);
    expect(messages[3]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: '2026-01-01T00:00:03Z',
    });
    const a2 = messages[4];
    if (a2?.role !== 'assistant') throw new Error('expected assistant at [4]');
    expect(a2.content).toBe('it is 2026-01-01');
    expect(a2.tool_calls).toBeUndefined();
  });
});
