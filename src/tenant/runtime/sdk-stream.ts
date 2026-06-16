// SDK-stream → Slack-display mapper (#303, Phase 1 of #282).
//
// `runTurn`/`runStreamingTurn` drive the bespoke harness loop. This module is
// the SDK-harness equivalent of `runStreamingTurn`'s render loop: it consumes
// the Claude Agent SDK's `query()` message stream and maps each frame onto the
// same Slack streaming primitives (`startStream`/`appendStream`/`stopStream`)
// + the same `stream-chunks.ts` chunk builders, so an SDK turn renders
// identically to a bespoke one. The mapping was proven end-to-end against a
// real sandbox in `scripts/spike-282-slack.ts`; this generalizes it.
//
// Design: `consumeSdkStream` is intentionally pure-ish. It takes (a) the SDK
// message stream and (b) a small `SlackStreamDriver` (the imperative
// startStream/appendStream/stopStream calls live in the driver, behind a
// stub-friendly seam) + (c) a `record`-style `onEvent` callback for JSONL
// persistence. That keeps the frame→chunk mapping unit-testable with a
// synthetic stream and a stub driver — same approach as `turn-stream.test.ts`.
//
// SDK frame → display mapping (mirrors runStreamingTurn):
//   - assistant `tool_use` block       → task card in_progress (id = tool_use.id)
//   - assistant interim `text` (when    → 💬 note card (plan mode) / markdown
//     the same message also has a tool)    (text mode)
//   - `user` message tool_result block  → flip the matching card complete/error,
//                                          clean bash output into details/output
//   - `result` (success)                → final markdown reply + finalize
//     (feedback buttons + AI disclaimer); plan header collapses to "✅ Done"
//   - `result` (error) / abort          → flip active card to error, stream a
//                                          legible body, ALWAYS finalize

import type { MarkdownTextChunk, TaskUpdateChunk } from '@slack/types';
import {
  finalBlocks,
  markdownChunks,
  type TaskStatus,
  taskRow,
  truncateField,
} from './stream-chunks';

// Humanized tool labels for the rotating plan header. The model-emitted tool
// names are MCP-namespaced (`mcp__agenta__bash`); we strip the prefix before
// looking up a friendly verb. Mirrors turn.ts:PRETTY_TOOL_LABELS (kept local
// so we don't touch turn.ts).
const PRETTY_TOOL_LABELS: Record<string, string> = {
  bash: 'Running command',
  web_search: 'Searching the web',
  read_page: 'Reading a page',
  read_file: 'Reading file',
  write_file: 'Writing file',
  edit_file: 'Editing file',
  get_current_time: 'Checking time',
  fetch_url: 'Fetching URL',
  share_file: 'Sharing file',
  ask_user: 'Asking',
  list_dir: 'Listing directory',
  grep: 'Searching files',
  glob: 'Finding files',
};

// Strip the `mcp__agenta__` (or any `mcp__<server>__`) prefix the SDK puts on
// in-process MCP tool names so labels + persisted JSONL use the bare tool name
// (matching the bespoke harness, which never saw the prefix).
export function bareToolName(name: string): string {
  const m = name.match(/^mcp__[^_]+(?:_[^_]+)*__(.+)$/);
  if (m?.[1]) return m[1];
  // Fallback: handle the common `mcp__agenta__<name>` shape even if the server
  // name contains underscores by splitting on the last `__`.
  const idx = name.lastIndexOf('__');
  return idx >= 0 ? name.slice(idx + 2) : name;
}

function prettyToolLabel(bareName: string): string {
  return PRETTY_TOOL_LABELS[bareName] ?? bareName;
}

// A short describe()-style title for a tool card. The bespoke harness uses each
// Tool's own describe(); here we don't have the registry in scope cheaply and
// the SDK gives us parsed input, so we render a compact, readable title per
// well-known tool. Falls back to "<name>" for unknown tools.
export function toolCardTitle(bareName: string, input: unknown): string {
  const args = (input ?? {}) as Record<string, unknown>;
  switch (bareName) {
    case 'bash': {
      const cmd = typeof args.command === 'string' ? args.command : '';
      return truncateField(`$ ${cmd}`);
    }
    case 'read_file': {
      const p = typeof args.path === 'string' ? args.path : '';
      return truncateField(`read ${p}`);
    }
    case 'write_file': {
      const p = typeof args.path === 'string' ? args.path : '';
      return truncateField(`write ${p}`);
    }
    case 'edit_file': {
      const p = typeof args.path === 'string' ? args.path : '';
      return truncateField(`edit ${p}`);
    }
    case 'list_dir': {
      const p = typeof args.path === 'string' ? args.path : '.';
      return truncateField(`ls ${p}`);
    }
    case 'fetch_url': {
      const u = typeof args.url === 'string' ? args.url : '';
      return truncateField(`fetch ${u}`);
    }
    default:
      return prettyToolLabel(bareName);
  }
}

// Clean a finished tool's result text into card fields (details/output),
// mirroring turn.ts:toolCardFields (which is private to turn.ts, so we keep an
// equivalent here). bash gets special handling: stdout/stderr in details, exit
// code as the output bullet, model-oriented "--- stdout ---" markers stripped.
export function toolCardFields(
  bareName: string,
  content: string,
  error: boolean,
): { details?: string; output?: string } {
  if (bareName === 'bash') {
    const exit = content.match(/^exit: (-?\d+)/)?.[1];
    const body = content
      .replace(/^exit: -?\d+\n?/, '')
      .replace(/--- stdout ---\n?/g, '')
      .replace(/--- stderr ---\n?/g, '\n⚠ stderr:\n')
      .trim();
    return {
      details: body.length > 0 ? body : undefined,
      output: exit !== undefined ? `exit: ${exit}` : undefined,
    };
  }
  return { details: content.length > 0 ? content : error ? 'error' : undefined };
}

// ---------------------------------------------------------------------------
// Slack stream driver — the imperative startStream/appendStream/stopStream
// surface, isolated behind an interface so the mapper is unit-testable with a
// stub. The default impl (below) wraps a WebClient; tests pass a recording stub.
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: chunk union spans plan_update + task_update + markdown_text + blocks
type Chunk = any;

export type SlackStreamDriver = {
  // Open the stream in PLAN mode with an initial rotating header. Idempotent:
  // only the first call opens it; later calls no-op.
  ensurePlan: (title: string) => Promise<void>;
  // Update the rotating plan header (no-op outside plan mode / before open).
  setPlanTitle: (title: string) => Promise<void>;
  // Append chunks, opening the stream in plain TEXT mode on first use.
  append: (chunks: Chunk[]) => Promise<void>;
  // Finalize: stopStream with the feedback buttons + disclaimer blocks.
  // No-op if the stream never opened.
  finalize: (blocks: ReturnType<typeof finalBlocks>) => Promise<void>;
};

// JSONL persistence hooks. The mapper calls these as it observes assistant
// messages / tool calls / tool results so the SDK turn keeps debug-thread +
// recovery working (matching what runStreamingTurn records).
export type SdkStreamRecorder = {
  onAssistantText: (text: string) => Promise<void>;
  onToolCall: (call: { id: string; name: string; argumentsJson: string }) => Promise<void>;
  onToolResult: (result: { id: string; content: string; error: boolean }) => Promise<void>;
};

// The result of consuming a stream — surfaced so the turn can persist the SDK
// session id (for resume) and know whether the turn finished cleanly.
export type SdkStreamOutcome = {
  // The SDK session id captured from the `system/init` (or any) frame — used to
  // resume the conversation on the next turn.
  sessionId?: string;
  // The final reply text (result.subtype === 'success'). Undefined on error.
  finalText?: string;
  // True if the turn ended via the `result` frame (vs. stream exhaustion).
  completed: boolean;
};

// A minimal structural view of the SDK message stream frames we map. The real
// SDKMessage union is huge; we read only these fields and ignore the rest.
// biome-ignore lint/suspicious/noExplicitAny: we read a structural subset of the SDK frame union
type SdkFrame = any;

// Consume the SDK `query()` message stream, driving the Slack display + JSONL
// persistence. Pure w.r.t. Slack/IO — all side effects go through `driver` +
// `recorder`, both injectable. Returns the captured session id + final text.
//
// `displayStyle === 'task_update'` drives the full plan rendering (primary).
// For 'verbose'/'pretty' a simpler text rendering is used (v1): interim text +
// the final answer stream as markdown, tools render as compact task rows. The
// streaming-API path is the same; only the plan-vs-text framing differs.
export async function consumeSdkStream(
  stream: AsyncIterable<SdkFrame>,
  driver: SlackStreamDriver,
  recorder: SdkStreamRecorder,
  displayStyle: 'verbose' | 'pretty' | 'task_update' = 'task_update',
  signal?: AbortSignal,
): Promise<SdkStreamOutcome> {
  const usePlan = displayStyle === 'task_update';
  let sessionId: string | undefined;
  let toolsRan = 0;
  let noteSeq = 0;
  let activeRowId: string | undefined;
  let finalText: string | undefined;
  let completed = false;
  let finalized = false;

  // tool_use_id → card title, so the completing tool_result reuses the title.
  const cardTitle = new Map<string, string>();

  const finalize = async (): Promise<void> => {
    if (finalized) return;
    finalized = true;
    await driver.finalize(finalBlocks());
  };

  // Interim assistant reasoning text (emitted alongside a tool call) → a 💬 note
  // card in the plan, or a markdown chunk in text mode.
  const emitReasoning = async (text: string): Promise<void> => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    if (usePlan) {
      noteSeq += 1;
      await driver.append([
        taskRow({
          id: `note-${noteSeq}`,
          title: `💬 ${trimmed.replace(/\s+/g, ' ')}`,
          status: 'complete',
        }),
      ]);
    } else {
      await driver.append(markdownChunks(trimmed));
    }
  };

  try {
    for await (const frame of stream as AsyncIterable<SdkFrame>) {
      if (typeof frame?.session_id === 'string' && sessionId === undefined) {
        sessionId = frame.session_id;
      }

      if (frame?.type === 'assistant') {
        const blocks: SdkFrame[] = frame.message?.content ?? [];
        const hasTool = blocks.some((b) => b?.type === 'tool_use');
        // Persist the assistant text (matches runStreamingTurn's assistant
        // `message` record). Only one text record per assistant frame.
        const textBlock = blocks.find((b) => b?.type === 'text' && typeof b.text === 'string');
        const assistantText = (textBlock?.text as string | undefined)?.trim() ?? '';
        if (assistantText.length > 0) {
          await recorder.onAssistantText(assistantText);
        }
        for (const b of blocks) {
          // interim reasoning text alongside a tool call → note card
          if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim() && hasTool) {
            if (usePlan) await driver.ensurePlan('Working…');
            await emitReasoning(b.text);
          }
          if (b?.type === 'tool_use') {
            const bare = bareToolName(String(b.name ?? ''));
            const title = toolCardTitle(bare, b.input);
            cardTitle.set(b.id, title);
            toolsRan += 1;
            activeRowId = b.id;
            if (usePlan) {
              await driver.ensurePlan('Working…');
              await driver.setPlanTitle(`${prettyToolLabel(bare)}…`);
            }
            await driver.append([
              taskRow({ id: b.id, title, status: 'in_progress' as TaskStatus }),
            ]);
            await recorder.onToolCall({
              id: b.id,
              name: bare,
              argumentsJson: JSON.stringify(b.input ?? {}),
            });
          }
        }
      } else if (frame?.type === 'user') {
        const blocks: SdkFrame[] = frame.message?.content ?? [];
        for (const b of blocks) {
          if (b?.type === 'tool_result') {
            const id = b.tool_use_id as string;
            const title = cardTitle.get(id) ?? 'tool';
            const out = Array.isArray(b.content)
              ? b.content.map((c: SdkFrame) => (typeof c?.text === 'string' ? c.text : '')).join('')
              : String(b.content ?? '');
            const isError = b.is_error === true;
            const bare = bareNameFromTitle(title);
            const card = toolCardFields(bare, out, isError);
            await driver.append([
              taskRow({
                id,
                title,
                status: isError ? 'error' : 'complete',
                ...(card.details !== undefined ? { details: card.details } : {}),
                ...(card.output !== undefined ? { output: card.output } : {}),
              }),
            ]);
            activeRowId = undefined;
            await recorder.onToolResult({ id, content: out, error: isError });
          }
        }
      } else if (frame?.type === 'result') {
        completed = true;
        if (usePlan && toolsRan > 0) {
          await driver.setPlanTitle(`✅ Done — ${toolsRan} step${toolsRan === 1 ? '' : 's'}`);
        }
        if (frame.subtype === 'success') {
          const result: string = typeof frame.result === 'string' ? frame.result : '';
          finalText = result;
          const reply = result.length > 0 ? result : '(empty reply)';
          await recorder.onAssistantText(reply);
          await driver.append(markdownChunks(reply));
        } else {
          // Error result — surface a legible body, flip the active card.
          const detail = String(frame.subtype ?? 'error');
          if (activeRowId) {
            await driver.append([
              taskRow({ id: activeRowId, title: 'error', status: 'error', output: detail }),
            ]);
          }
          if (usePlan) await driver.setPlanTitle('⚠️ Error');
          await driver.append(markdownChunks(`error: ${detail}`));
        }
        await finalize();
      }
    }
  } catch (err) {
    if (signal?.aborted) {
      if (activeRowId) {
        await driver
          .append([
            taskRow({ id: activeRowId, title: 'stopped', status: 'error', output: 'stopped' }),
          ])
          .catch(() => {});
      }
      if (usePlan) await driver.setPlanTitle('■ Stopped').catch(() => {});
      await driver.append(markdownChunks('stopped')).catch(() => {});
      await finalize();
      return { sessionId, finalText, completed };
    }
    const msg = (err as Error).message ?? String(err);
    if (activeRowId) {
      await driver
        .append([
          taskRow({ id: activeRowId, title: 'error', status: 'error', output: truncateField(msg) }),
        ])
        .catch(() => {});
    }
    if (usePlan) await driver.setPlanTitle('⚠️ Error').catch(() => {});
    await driver.append(markdownChunks(`error: ${msg}`)).catch(() => {});
    await finalize();
    return { sessionId, finalText, completed };
  }

  // Defensive: close the stream if the loop exited without a `result` frame.
  await finalize();
  return { sessionId, finalText, completed };
}

// We key tool-card field cleaning on the bare tool name, but at tool_result
// time we only kept the rendered title. The title for bash starts with "$ ", so
// recover "bash" from it; everything else uses generic cleaning anyway.
function bareNameFromTitle(title: string): string {
  if (title.startsWith('$ ')) return 'bash';
  return '';
}

// ---------------------------------------------------------------------------
// Default WebClient-backed driver (used in production by runSdkTurn). Mirrors
// the imperative stream helpers in runStreamingTurn so the on-wire behavior is
// identical. Kept here (not in turn.ts) so we don't touch the bespoke harness.
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: web-api stream method shapes are loose at the call boundary
type LooseWeb = any;

export function makeWebStreamDriver(
  web: LooseWeb,
  channel: string,
  threadTs: string,
  recipientUserId?: string,
  recipientTeamId?: string,
): SlackStreamDriver {
  let streamTs: string | undefined;
  let planMode = false;

  const recipient = (args: Record<string, unknown>): Record<string, unknown> => {
    if (recipientTeamId) args.recipient_team_id = recipientTeamId;
    if (recipientUserId) args.recipient_user_id = recipientUserId;
    return args;
  };

  return {
    ensurePlan: async (title) => {
      if (streamTs) return;
      planMode = true;
      const args = recipient({
        channel,
        thread_ts: threadTs,
        task_display_mode: 'plan',
        chunks: [{ type: 'plan_update', title: truncateField(title) }],
      });
      const res = await web.chat.startStream(args);
      streamTs = res?.ts;
    },
    setPlanTitle: async (title) => {
      if (!planMode || !streamTs) return;
      await web.chat
        .appendStream({
          channel,
          ts: streamTs,
          chunks: [{ type: 'plan_update', title: truncateField(title) }],
        })
        .catch(() => {});
    },
    append: async (chunks) => {
      if (chunks.length === 0) return;
      if (!streamTs) {
        const args = recipient({ channel, thread_ts: threadTs, chunks });
        const res = await web.chat.startStream(args);
        streamTs = res?.ts;
        return;
      }
      await web.chat.appendStream({ channel, ts: streamTs, chunks }).catch(() => {});
    },
    finalize: async (blocks) => {
      if (!streamTs) return;
      await web.chat
        .stopStream({ channel, ts: streamTs, chunks: [{ type: 'blocks', blocks }] })
        .catch(() => {});
    },
  };
}

// Re-export chunk types for tests that assert on the shapes.
export type { MarkdownTextChunk, TaskUpdateChunk };
