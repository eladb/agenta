import { describe, expect, it } from 'bun:test';
import {
  AI_DISCLAIMER,
  chunkMarkdown,
  FEEDBACK_ACTION_ID,
  finalBlocks,
  MARKDOWN_CHUNK_MAX,
  markdownChunks,
  TASK_FIELD_MAX,
  taskRow,
  truncateField,
} from './stream-chunks';

describe('truncateField', () => {
  it('leaves short strings untouched', () => {
    expect(truncateField('hello')).toBe('hello');
  });

  it('truncates to the field cap with an ellipsis', () => {
    const long = 'x'.repeat(TASK_FIELD_MAX + 50);
    const out = truncateField(long);
    expect(out.length).toBe(TASK_FIELD_MAX);
    expect(out.endsWith('…')).toBe(true);
  });

  it('respects an explicit max', () => {
    expect(truncateField('abcdef', 3)).toBe('ab…');
  });

  it('keeps a string exactly at the cap', () => {
    const exact = 'y'.repeat(TASK_FIELD_MAX);
    expect(truncateField(exact)).toBe(exact);
  });
});

describe('taskRow', () => {
  it('builds a minimal in_progress row', () => {
    const row = taskRow({ id: 'c1', title: 'Thinking', status: 'in_progress' });
    expect(row).toEqual({
      type: 'task_update',
      id: 'c1',
      title: 'Thinking',
      status: 'in_progress',
    });
  });

  it('truncates title/details/output to the cap', () => {
    const big = 'z'.repeat(TASK_FIELD_MAX + 10);
    const row = taskRow({ id: 'c1', title: big, status: 'complete', details: big, output: big });
    expect((row.title ?? '').length).toBe(TASK_FIELD_MAX);
    expect((row.details ?? '').length).toBe(TASK_FIELD_MAX);
    expect((row.output ?? '').length).toBe(TASK_FIELD_MAX);
  });

  it('omits details/output when not provided', () => {
    const row = taskRow({ id: 'c1', title: 't', status: 'pending' });
    expect(row.details).toBeUndefined();
    expect(row.output).toBeUndefined();
  });
});

describe('chunkMarkdown', () => {
  it('returns [] for empty input', () => {
    expect(chunkMarkdown('')).toEqual([]);
  });

  it('returns a single chunk for short input', () => {
    expect(chunkMarkdown('hello')).toEqual(['hello']);
  });

  it('splits input longer than the cap into ≤cap chunks', () => {
    const body = 'a'.repeat(MARKDOWN_CHUNK_MAX * 2 + 5);
    const chunks = chunkMarkdown(body);
    expect(chunks.length).toBe(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MARKDOWN_CHUNK_MAX);
    expect(chunks.join('')).toBe(body);
  });

  it('keeps a body exactly at the cap as one chunk', () => {
    const body = 'b'.repeat(MARKDOWN_CHUNK_MAX);
    expect(chunkMarkdown(body)).toEqual([body]);
  });
});

describe('markdownChunks', () => {
  it('maps to markdown_text chunks', () => {
    const out = markdownChunks('hi');
    expect(out).toEqual([{ type: 'markdown_text', text: 'hi' }]);
  });

  it('produces one chunk per split segment', () => {
    const body = 'c'.repeat(MARKDOWN_CHUNK_MAX + 1);
    const out = markdownChunks(body);
    expect(out.length).toBe(2);
  });

  it('returns [] for empty body', () => {
    expect(markdownChunks('')).toEqual([]);
  });
});

describe('finalBlocks', () => {
  it('includes feedback buttons with the agreed action_id', () => {
    const blocks = finalBlocks();
    const ctxActions = blocks.find((b) => b.type === 'context_actions');
    expect(ctxActions).toBeDefined();
    const fb = ctxActions.elements[0];
    expect(fb.type).toBe('feedback_buttons');
    expect(fb.action_id).toBe(FEEDBACK_ACTION_ID);
    // Spike correction: positive/negative buttons each need text + value.
    expect(fb.positive_button.text).toEqual({ type: 'plain_text', text: 'Good' });
    expect(fb.positive_button.value).toBe('up');
    expect(fb.negative_button.text).toEqual({ type: 'plain_text', text: 'Bad' });
    expect(fb.negative_button.value).toBe('down');
  });

  it('includes the AI disclaimer context block', () => {
    const blocks = finalBlocks();
    const ctx = blocks.find((b) => b.type === 'context');
    expect(ctx).toBeDefined();
    expect(ctx.elements[0]).toEqual({ type: 'mrkdwn', text: AI_DISCLAIMER });
  });
});
