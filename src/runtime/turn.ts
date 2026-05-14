import type { WebClient } from '@slack/web-api';
import { log } from '../log';
import { buildMessages } from '../model/context';
import type { CallModel, Message, ToolCall } from '../model/gateway';
import { invokeTool, TOOL_DEFS, TOOLS } from '../model/tools';
import { newEventId, nowIso, record } from '../persistence/events';
import { ensureContainer, isSandboxReady, syncAttachmentsToSandbox } from '../sandbox';
import { deleteMessage, editMessage, postInThread } from '../slack/post';
import { redact } from './redact';

export type TurnInput = {
  channel: string;
  threadTs: string;
  threadKey: string;
};

const ARGS_PREVIEW_LEN = 80;
const LIVE_PREVIEW_LEN = 150;
const LIVE_EDIT_INTERVAL_MS = 800;

// Visual conventions for an intermediate round message:
//   - `→ {text}` at the top, only when the model emitted reasoning text
//   - bash blocks shown as fenced code (` ``` `) for monospace + multi-line output
//   - other tools shown as inline code (`tool args`) + a `→ result` follow-up
//   - status lines (provisioning workspace, attachments synced) shown as
//     plain italics so they read as informational, not equal weight to tools
// When the model emits no reasoning text, the header is omitted entirely —
// the round message is just the tool's rendering. No `thinking…` persists.
//
// Final replies (no tool_calls) post as a fresh plain message — no marker.
const HEADER_MARKER = '→ ';
const PLACEHOLDER = 'Thinking…';

function toolLabel(tc: ToolCall): string {
  // Short human-readable label from the tool's own describe(). Falls back
  // to a raw name(args) form if no describer is registered or it throws.
  const tool = TOOLS[tc.function.name];
  if (tool?.describe) {
    try {
      const parsed = tc.function.arguments.length > 0 ? JSON.parse(tc.function.arguments) : {};
      const desc = tool.describe(parsed);
      if (desc) return desc;
    } catch {
      // fall through
    }
  }
  const a = tc.function.arguments;
  const args = a.length > ARGS_PREVIEW_LEN ? `${a.slice(0, ARGS_PREVIEW_LEN - 1)}…` : a;
  return `${tc.function.name}(${args})`;
}

function liveLine(preview: string): string {
  // Collapse newlines so the live preview stays single-line inside the bash
  // code fence. No leading indent — we're already inside a code block.
  const flat = preview.replace(/[\r\n]+/g, ' ⏎ ').slice(-LIVE_PREVIEW_LEN);
  return flat;
}

function renderRound(headerText: string, lines: string[]): string {
  // headerText empty + no lines = the pre-model placeholder.
  if (headerText.length === 0 && lines.length === 0) return PLACEHOLDER;
  const parts: string[] = [];
  if (headerText.length > 0) {
    parts.push(`${HEADER_MARKER}${headerText}`);
    if (lines.length > 0) parts.push(''); // blank line between header and tool blocks
  }
  parts.push(...lines);
  return parts.join('\n');
}

// Push a blank separator before a new logical block if the current trailing
// entry isn't already blank — keeps tool blocks visually separated.
function pushSeparator(lines: string[]): void {
  if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
}

export async function runTurn(
  web: WebClient,
  callModel: CallModel,
  systemPrompt: string,
  input: TurnInput,
  signal?: AbortSignal,
): Promise<void> {
  // "Live" message tracks ONLY the current round. When the next round
  // begins (model returns more text + tool calls), we leave this message
  // frozen and post a new one. When the final reply lands, we post it as
  // a fresh clean message and delete any in-flight placeholder.
  let liveTs: string | undefined;
  let liveHeader = '';
  let liveLines: string[] = [];

  const repaint = (): Promise<void> => {
    if (!liveTs) return Promise.resolve();
    return editMessage(web, input.channel, liveTs, renderRound(liveHeader, liveLines)).catch(
      () => {},
    );
  };

  // Initial placeholder so the user sees something land the moment they
  // mention the bot. Gets overwritten by the first round's content.
  liveTs = await postInThread(
    web,
    input.channel,
    input.threadTs,
    renderRound(liveHeader, liveLines),
  );

  try {
    const messages: Message[] = await buildMessages(input.threadKey, systemPrompt);

    while (true) {
      const response = await callModel(messages, { tools: TOOL_DEFS, signal });

      const assistantEventId = newEventId();
      const text = response.content ?? '';
      const toolCalls = response.tool_calls ?? [];

      await record({
        event_id: assistantEventId,
        thread_key: input.threadKey,
        source: 'assistant',
        type: 'message',
        ts: nowIso(),
        ingested_at: nowIso(),
        payload: { slack_ts: liveTs ?? '', text },
      });

      // No tool calls → final reply. Drop the placeholder/last live
      // message and post a clean final message in its place.
      if (toolCalls.length === 0) {
        const reply = text.length > 0 ? text : '(empty reply)';
        if (liveTs) {
          await deleteMessage(web, input.channel, liveTs);
          liveTs = undefined;
        }
        await postInThread(web, input.channel, input.threadTs, reply);
        log.info('turn', `[${input.threadKey}] replied (${reply.length} chars)`);
        return;
      }

      // Start of a new round. Set the header (empty if model emitted no
      // reasoning text — we don't want a stranded "thinking…" line
      // sitting above the tool) and reset the lines list.
      liveHeader = text;
      liveLines = [];
      await repaint();

      messages.push({ role: 'assistant', content: response.content, tool_calls: toolCalls });

      for (const tc of toolCalls) {
        // Lazy sandbox provisioning. Surfaced as an italicized status
        // line before the tool that needs it so the chronology lines up.
        const tool = TOOLS[tc.function.name];
        let provisionError: string | undefined;
        if (tool?.requiresSandbox && !isSandboxReady(input.threadKey)) {
          pushSeparator(liveLines);
          const provIdx = liveLines.length;
          liveLines.push('_provisioning workspace…_');
          await repaint();
          try {
            await ensureContainer(input.threadKey);
            // Success: don't persist the status line. The tool block that
            // follows is the meaningful content. Drop the trailing
            // separator too if it was added just for this status line.
            liveLines.splice(provIdx, 1);
            if (
              liveLines.length > 0 &&
              liveLines[liveLines.length - 1] === '' &&
              liveLines.length === provIdx
            ) {
              liveLines.pop();
            }
          } catch (err) {
            const msg = (err as Error).message;
            provisionError = msg;
            liveLines[provIdx] = `_workspace provisioning failed: ${msg}_`;
          }
          await repaint();
        }

        // Lazy attachment sync. Same idempotent helper as before.
        if (tool?.requiresSandbox && !provisionError) {
          try {
            const { synced } = await syncAttachmentsToSandbox(input.threadKey);
            if (synced > 0) {
              liveLines.push(`_synced ${synced} attachment(s) to workspace_`);
              await repaint();
            }
          } catch (err) {
            log.warn('turn', `[${input.threadKey}] attachment sync failed`, err);
          }
        }

        pushSeparator(liveLines);

        // Tool rendering: a label line + a mutable result/preview line
        // underneath, both plain text (no inline-code / fenced backticks).
        // bash gets the live preview behavior; everything else just shows
        // a result placeholder until the tool returns.
        const isBash = tc.function.name === 'bash';
        const label = toolLabel(tc);
        const bulletIdx = liveLines.length;
        liveLines.push(label);
        const liveIdx = liveLines.length;
        liveLines.push('…');
        await repaint();

        let liveBuffer = '';
        let flushTimer: ReturnType<typeof setTimeout> | undefined;
        const scheduleFlush = (): void => {
          if (flushTimer || liveIdx < 0 || !isBash) return;
          flushTimer = setTimeout(() => {
            flushTimer = undefined;
            liveLines[liveIdx] = liveLine(liveBuffer);
            void repaint();
          }, LIVE_EDIT_INTERVAL_MS);
        };
        const onProgress = isBash
          ? (chunk: { kind: 'stdout' | 'stderr'; text: string }): void => {
              liveBuffer = (liveBuffer + chunk.text).slice(-1024);
              scheduleFlush();
            }
          : undefined;

        await record({
          event_id: newEventId(),
          thread_key: input.threadKey,
          source: 'assistant',
          type: 'tool_call',
          ts: nowIso(),
          ingested_at: nowIso(),
          payload: {
            parent_event_id: assistantEventId,
            tool_call_id: tc.id,
            name: tc.function.name,
            arguments_json: tc.function.arguments,
          },
        });

        const result: { content: string; error: boolean } = provisionError
          ? {
              content: `error: workspace not available: ${provisionError}`,
              error: true,
            }
          : await invokeTool(
              tc.function.name,
              tc.function.arguments,
              {
                threadKey: input.threadKey,
                onProgress,
                web,
                channel: input.channel,
                threadTs: input.threadTs,
                checklistTs: liveTs ?? input.threadTs,
              },
              signal,
            );

        // ask_user resolves inline on its label line (no separate result
        // slot — the answer reads naturally next to the question).
        if (tc.function.name === 'ask_user' && !result.error) {
          liveLines[bulletIdx] = `${liveLines[bulletIdx]} → ${result.content}`;
          // drop the unused result slot
          if (liveIdx >= 0 && liveLines[liveIdx] === '…') {
            liveLines.splice(liveIdx, 1);
          }
        } else {
          if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = undefined;
          }
          if (liveIdx >= 0) {
            const firstLine = result.content.split('\n')[0] ?? '';
            liveLines[liveIdx] = `→ ${firstLine}`;
          }
        }

        await record({
          event_id: newEventId(),
          thread_key: input.threadKey,
          source: 'assistant',
          type: 'tool_result',
          ts: nowIso(),
          ingested_at: nowIso(),
          payload: {
            tool_call_id: tc.id,
            content: result.content,
            ...(result.error ? { error: true } : {}),
          },
        });

        messages.push({ role: 'tool', tool_call_id: tc.id, content: result.content });
      }

      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');

      // End of round. Leave this round's message frozen and post a fresh
      // placeholder for the next round.
      await repaint();
      liveHeader = '';
      liveLines = [];
      liveTs = await postInThread(
        web,
        input.channel,
        input.threadTs,
        renderRound(liveHeader, liveLines),
      );
    }
  } catch (err) {
    if (signal?.aborted) {
      if (liveTs) {
        await editMessage(web, input.channel, liveTs, 'stopped').catch(() => {});
      } else {
        await postInThread(web, input.channel, input.threadTs, 'stopped').catch(() => {});
      }
      log.info('turn', `[${input.threadKey}] stopped`);
      return;
    }
    const msg = redact((err as Error).message ?? String(err));
    log.error('turn', `[${input.threadKey}] model call failed`, msg);
    if (liveTs) {
      await editMessage(web, input.channel, liveTs, `error: ${msg}`).catch(() => {});
    } else {
      await postInThread(web, input.channel, input.threadTs, `error: ${msg}`).catch(() => {});
    }
  }
}
