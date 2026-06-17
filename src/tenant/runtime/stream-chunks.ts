// Pure chunk mappers for the Slack streaming display (#285).
//
// These turn agenta's loop primitives (a tool call, a tool result, a reply
// body) into Slack streaming chunks. They are deliberately pure — no Slack
// calls, no I/O — so the bulk of the rendering logic is unit-testable with a
// plain stubbed `web`. The stream driver (sdk-stream.ts) owns the imperative
// startStream/appendStream/stopStream calls and the per-turn `ts`; these
// functions just shape payloads.
//
// Naming note (easy to trip on): `task_update` is the CHUNK `type` for a
// timeline row (renders as a task card). The driver opens the stream WITHOUT
// `task_display_mode`, lazily on the first emitted chunk: the #285 spike
// confirmed task_update chunks render as task cards in plain text mode too, so
// a markdown-only turn streams with no leading task row (no placeholder
// "Thinking…" chip) and tool turns open on the real tool's row. (Under an
// explicit `task_display_mode: 'timeline'` the first chunk MUST be a
// task_update row — which is exactly the chip we want to avoid.)

import type { MarkdownTextChunk, TaskUpdateChunk } from '@slack/types';

// Slack caps individual `task_update` chunk string fields; we truncate
// title/details/output to stay well under the limit. The append-side
// markdown body is chunked separately (see MARKDOWN_CHUNK_MAX).
export const TASK_FIELD_MAX = 256;
export const MARKDOWN_CHUNK_MAX = 12_000;

export type TaskStatus = 'pending' | 'in_progress' | 'complete' | 'error';

// Truncate a string to `max` chars with a trailing ellipsis. Pure; safe on
// undefined (returns undefined) so callers can pass optional fields through.
export function truncateField(s: string, max: number = TASK_FIELD_MAX): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

// Build (or update) a single timeline row. The `id` is stable across the
// in_progress → complete/error transition so Slack rewrites the same row
// rather than appending a new one — that stability is the whole point of the
// timeline rendering. Optional details/output are truncated to the field cap.
export function taskRow(args: {
  id: string;
  title: string;
  status: TaskStatus;
  details?: string;
  output?: string;
}): TaskUpdateChunk {
  const row: TaskUpdateChunk = {
    type: 'task_update',
    id: args.id,
    title: truncateField(args.title),
    status: args.status,
  };
  if (args.details !== undefined) row.details = truncateField(args.details);
  if (args.output !== undefined) row.output = truncateField(args.output);
  return row;
}

// Map a tool call (label + optional args preview) to an in_progress row.
// `id` is the tool_call_id so the later completion row reuses it.
export function toolStartRow(args: {
  id: string;
  label: string;
  argsPreview?: string;
}): TaskUpdateChunk {
  return taskRow({
    id: args.id,
    title: args.label,
    status: 'in_progress',
    ...(args.argsPreview !== undefined && args.argsPreview.length > 0
      ? { details: args.argsPreview }
      : {}),
  });
}

// Map a tool result back onto the same row id. `error` flips the status;
// the first line of the result is surfaced as the row output (truncated).
export function toolEndRow(args: {
  id: string;
  label: string;
  output: string;
  error: boolean;
}): TaskUpdateChunk {
  const firstLine = args.output.split('\n')[0] ?? '';
  return taskRow({
    id: args.id,
    title: args.label,
    status: args.error ? 'error' : 'complete',
    output: firstLine,
  });
}

// Split a long markdown body into ≤MARKDOWN_CHUNK_MAX-char strings. Returns
// [] for empty/whitespace-only input so callers can skip an empty append.
// Splits on hard char boundaries (no token/markdown awareness) — fine for a
// final-answer body where we just need to respect the API ceiling.
export function chunkMarkdown(text: string, max: number = MARKDOWN_CHUNK_MAX): string[] {
  if (text.length === 0) return [];
  if (text.length <= max) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += max) {
    out.push(text.slice(i, i + max));
  }
  return out;
}

// Map a chunked markdown body to markdown_text append chunks.
export function markdownChunks(
  text: string,
  max: number = MARKDOWN_CHUNK_MAX,
): MarkdownTextChunk[] {
  return chunkMarkdown(text, max).map((t) => ({ type: 'markdown_text', text: t }));
}

// The action_id the feedback buttons + the block_actions handler agree on.
export const FEEDBACK_ACTION_ID = 'turn_feedback';

// Static disclaimer shown on every finalized streaming message.
export const AI_DISCLAIMER = '_AI-generated; may be inaccurate._';

// biome-ignore lint/suspicious/noExplicitAny: block-kit shapes are loosely typed across the web-api surface
type Block = any;

// The final-message blocks: feedback buttons (context_actions) + the
// AI disclaimer (context). Passed to stopStream as a single `blocks` chunk.
export function finalBlocks(): Block[] {
  return [
    {
      type: 'context_actions',
      elements: [
        {
          type: 'feedback_buttons',
          action_id: FEEDBACK_ACTION_ID,
          positive_button: { text: { type: 'plain_text', text: 'Good' }, value: 'up' },
          negative_button: { text: { type: 'plain_text', text: 'Bad' }, value: 'down' },
        },
      ],
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: AI_DISCLAIMER }],
    },
  ];
}
