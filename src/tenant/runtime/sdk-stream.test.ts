// Unit tests for the SDK-stream → display mapper (#303). We feed
// `consumeSdkStream` a synthetic Claude Agent SDK message stream (the same
// frame shapes the real `query()` emits) plus a recording stub driver +
// recorder, and assert on the emitted Slack chunks + persisted-event calls.
// Same style as turn-stream.test.ts, but the input is the SDK stream rather
// than a stubbed callModel.

import { describe, expect, test } from 'bun:test';
import {
  bareToolName,
  consumeSdkStream,
  type SdkStreamRecorder,
  type SlackStreamDriver,
  toolCardFields,
} from './sdk-stream';
import { FEEDBACK_ACTION_ID } from './stream-chunks';

type Chunk = { type: string; [k: string]: unknown };

function makeDriverStub(): {
  driver: SlackStreamDriver;
  planOpens: string[];
  planTitles: string[];
  appended: Chunk[];
  finals: unknown[][];
} {
  const planOpens: string[] = [];
  const planTitles: string[] = [];
  const appended: Chunk[] = [];
  const finals: unknown[][] = [];
  let opened = false;
  const driver: SlackStreamDriver = {
    ensurePlan: async (title) => {
      if (opened) return;
      opened = true;
      planOpens.push(title);
      // Mirror the real driver: opening a plan leads with a plan_update chunk.
      appended.push({ type: 'plan_update', title });
    },
    setPlanTitle: async (title) => {
      planTitles.push(title);
      appended.push({ type: 'plan_update', title });
    },
    append: async (chunks) => {
      for (const c of chunks) appended.push(c as Chunk);
    },
    finalize: async (blocks) => {
      finals.push(blocks);
    },
  };
  return { driver, planOpens, planTitles, appended, finals };
}

function makeRecorderStub(): {
  recorder: SdkStreamRecorder;
  assistantTexts: string[];
  toolCalls: Array<{ id: string; name: string; argumentsJson: string }>;
  toolResults: Array<{ id: string; content: string; error: boolean }>;
} {
  const assistantTexts: string[] = [];
  const toolCalls: Array<{ id: string; name: string; argumentsJson: string }> = [];
  const toolResults: Array<{ id: string; content: string; error: boolean }> = [];
  const recorder: SdkStreamRecorder = {
    onAssistantText: async (text) => {
      assistantTexts.push(text);
    },
    onToolCall: async (call) => {
      toolCalls.push(call);
    },
    onToolResult: async (result) => {
      toolResults.push(result);
    },
  };
  return { recorder, assistantTexts, toolCalls, toolResults };
}

// biome-ignore lint/suspicious/noExplicitAny: synthetic SDK frames
async function* streamOf(frames: any[]): AsyncIterable<any> {
  for (const f of frames) yield f;
}

const SID = 'sess-abc';

describe('consumeSdkStream — plan mode', () => {
  test('tool_use → in_progress card; tool_result → complete; result → final + finalize', async () => {
    const { driver, planOpens, planTitles, appended, finals } = makeDriverStub();
    const { recorder, assistantTexts, toolCalls, toolResults } = makeRecorderStub();

    const frames = [
      { type: 'system', subtype: 'init', session_id: SID },
      {
        type: 'assistant',
        session_id: SID,
        message: {
          content: [
            { type: 'text', text: 'Let me check the time.' },
            {
              type: 'tool_use',
              id: 'tu1',
              name: 'mcp__agenta__bash',
              input: { command: 'date -u' },
            },
          ],
        },
      },
      {
        type: 'user',
        session_id: SID,
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu1',
              content: [{ type: 'text', text: 'exit: 0\n--- stdout ---\nWed Jun 16\n' }],
            },
          ],
        },
      },
      { type: 'result', subtype: 'success', session_id: SID, result: 'It is Wednesday.' },
    ];

    const outcome = await consumeSdkStream(streamOf(frames), driver, recorder);

    // Session id captured.
    expect(outcome.sessionId).toBe(SID);
    expect(outcome.completed).toBe(true);
    expect(outcome.finalText).toBe('It is Wednesday.');

    // Plan opened, leading with a plan_update chunk.
    expect(planOpens.length).toBeGreaterThan(0);
    expect(appended[0]?.type).toBe('plan_update');

    // Interim reasoning became a 💬 note card (not markdown).
    const note = appended.find((c) => c.type === 'task_update' && String(c.id).startsWith('note-'));
    expect(note).toBeDefined();
    expect(String(note?.title)).toContain('Let me check the time.');

    // The tool rendered as a task card keyed by tool_use id: in_progress → complete.
    const rows = appended.filter((c) => c.type === 'task_update' && c.id === 'tu1');
    expect(rows.some((r) => r.status === 'in_progress')).toBe(true);
    const done = rows.find((r) => r.status === 'complete');
    expect(done).toBeDefined();
    // bash output cleaned: exit bullet + stdout body, markers stripped.
    expect(String(done?.output)).toContain('exit: 0');
    expect(String(done?.details)).toContain('Wed Jun 16');
    expect(String(done?.details)).not.toContain('--- stdout ---');

    // Title shows the command.
    expect(String(rows[0]?.title)).toBe('$ date -u');

    // Header rotated to a Done state at the end.
    expect(planTitles.some((t) => /Done — 1 step\b/.test(t))).toBe(true);

    // Final answer streamed as markdown + finalized with feedback + disclaimer.
    expect(appended.some((c) => c.type === 'markdown_text' && c.text === 'It is Wednesday.')).toBe(
      true,
    );
    expect(finals).toHaveLength(1);
    const blocks = finals[0] as Array<{ type: string; elements?: any[] }>;
    expect(blocks.find((b) => b.type === 'context_actions')?.elements?.[0]?.action_id).toBe(
      FEEDBACK_ACTION_ID,
    );
    expect(blocks.some((b) => b.type === 'context')).toBe(true);

    // JSONL recorder got the assistant text, the tool call, and the tool result.
    expect(assistantTexts).toContain('Let me check the time.');
    expect(assistantTexts).toContain('It is Wednesday.');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ id: 'tu1', name: 'bash' });
    expect(JSON.parse(toolCalls[0]?.argumentsJson ?? '{}')).toEqual({ command: 'date -u' });
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({ id: 'tu1', error: false });
    expect(toolResults[0]?.content).toContain('Wed Jun 16');
  });

  test('a failing tool_result flips the card to error; stream still finalizes', async () => {
    const { driver, appended, finals } = makeDriverStub();
    const { recorder, toolResults } = makeRecorderStub();

    const frames = [
      {
        type: 'assistant',
        session_id: SID,
        message: {
          content: [
            { type: 'tool_use', id: 'tuE', name: 'mcp__agenta__bash', input: { command: 'false' } },
          ],
        },
      },
      {
        type: 'user',
        session_id: SID,
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tuE',
              is_error: true,
              content: [{ type: 'text', text: 'exit: 1' }],
            },
          ],
        },
      },
      { type: 'result', subtype: 'success', session_id: SID, result: 'recovered' },
    ];

    await consumeSdkStream(streamOf(frames), driver, recorder);

    const errRow = appended.find(
      (c) => c.type === 'task_update' && c.id === 'tuE' && c.status === 'error',
    );
    expect(errRow).toBeDefined();
    expect(toolResults[0]?.error).toBe(true);
    expect(finals).toHaveLength(1);
  });
});

describe('consumeSdkStream — text mode (pure conversation)', () => {
  test('no tools → final answer streams as markdown, no plan, finalize', async () => {
    const { driver, planOpens, appended, finals } = makeDriverStub();
    const { recorder, assistantTexts } = makeRecorderStub();

    const frames = [
      { type: 'system', subtype: 'init', session_id: SID },
      { type: 'result', subtype: 'success', session_id: SID, result: 'the answer is 42' },
    ];

    const outcome = await consumeSdkStream(streamOf(frames), driver, recorder);

    expect(planOpens).toHaveLength(0);
    expect(appended.some((c) => c.type === 'plan_update' || c.type === 'task_update')).toBe(false);
    expect(appended.some((c) => c.type === 'markdown_text' && c.text === 'the answer is 42')).toBe(
      true,
    );
    expect(assistantTexts).toContain('the answer is 42');
    expect(finals).toHaveLength(1);
    expect(outcome.finalText).toBe('the answer is 42');
  });
});

describe('consumeSdkStream — error result', () => {
  test('error subtype streams a legible body and finalizes', async () => {
    const { driver, appended, finals } = makeDriverStub();
    const { recorder } = makeRecorderStub();

    const frames = [{ type: 'result', subtype: 'error_max_turns', session_id: SID }];

    await consumeSdkStream(streamOf(frames), driver, recorder);

    expect(
      appended.some((c) => c.type === 'markdown_text' && /error_max_turns/.test(String(c.text))),
    ).toBe(true);
    expect(finals).toHaveLength(1);
  });
});

describe('helpers', () => {
  test('bareToolName strips the mcp__agenta__ prefix', () => {
    expect(bareToolName('mcp__agenta__bash')).toBe('bash');
    expect(bareToolName('mcp__agenta__read_file')).toBe('read_file');
    expect(bareToolName('bash')).toBe('bash');
  });

  test('toolCardFields cleans bash output and exit bullet', () => {
    const out = toolCardFields('bash', 'exit: 0\n--- stdout ---\nhello\n', false);
    expect(out.output).toBe('exit: 0');
    expect(out.details).toBe('hello');
  });

  test('toolCardFields passes through non-bash content as details', () => {
    const out = toolCardFields('read_file', 'file contents here', false);
    expect(out.details).toBe('file contents here');
    expect(out.output).toBeUndefined();
  });
});
