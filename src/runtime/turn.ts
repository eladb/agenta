import type { WebClient } from '@slack/web-api';
import { log } from '../log';
import { buildMessages } from '../model/context';
import type { CallModel, Message, ToolCall } from '../model/gateway';
import { invokeTool, TOOL_DEFS, TOOLS } from '../model/tools';
import { newEventId, nowIso, record } from '../persistence/events';
import { editMessage, postInThread } from '../slack/post';
import { redact } from './redact';

export type TurnInput = {
  channel: string;
  threadTs: string;
  threadKey: string;
};

const ARGS_PREVIEW_LEN = 80;
const LIVE_PREVIEW_LEN = 150;
const LIVE_EDIT_INTERVAL_MS = 800;
const THINKING_LINE = '• thinking…';

// Pop the trailing thinking… placeholder if present. The line is ephemeral:
// shown while we wait for the model, removed as soon as the next concrete
// step (tool bullet or final reply) lands. So the final checklist doesn't
// accumulate "thinking" lines between iterations.
function popThinking(lines: string[]): void {
  if (lines[lines.length - 1] === THINKING_LINE) lines.pop();
}

function formatToolBullet(tc: ToolCall): string {
  // Prefer the tool's own describe() — short, human-readable, e.g. "$ ls -la"
  // instead of `bash({"command":"ls -la"})`. Falls back to the raw JSON when
  // no describer is registered or it throws on weird args.
  const tool = TOOLS[tc.function.name];
  if (tool?.describe) {
    try {
      const parsed = tc.function.arguments.length > 0 ? JSON.parse(tc.function.arguments) : {};
      const desc = tool.describe(parsed);
      if (desc) return `• ${desc}`;
    } catch {
      // fall through to raw
    }
  }
  const a = tc.function.arguments;
  const args = a.length > ARGS_PREVIEW_LEN ? `${a.slice(0, ARGS_PREVIEW_LEN - 1)}…` : a;
  return `• tool: ${tc.function.name}(${args})`;
}

function liveLine(preview: string): string {
  // Collapse newlines so the checklist stays single-line per tool.
  const flat = preview.replace(/[\r\n]+/g, ' ⏎ ').slice(-LIVE_PREVIEW_LEN);
  return `   ${flat}`;
}

export async function runTurn(
  web: WebClient,
  callModel: CallModel,
  systemPrompt: string,
  input: TurnInput,
  signal?: AbortSignal,
): Promise<void> {
  const checklistTs = await postInThread(web, input.channel, input.threadTs, THINKING_LINE);
  const lines: string[] = [THINKING_LINE];
  const updateChecklist = (): Promise<void> =>
    editMessage(web, input.channel, checklistTs, lines.join('\n')).catch(() => {});

  try {
    const messages: Message[] = await buildMessages(input.threadKey, systemPrompt);

    while (true) {
      const response = await callModel(messages, { tools: TOOL_DEFS, signal });
      popThinking(lines);

      const assistantEventId = newEventId();
      const text = response.content ?? '';
      await record({
        event_id: assistantEventId,
        thread_key: input.threadKey,
        source: 'assistant',
        type: 'message',
        ts: nowIso(),
        ingested_at: nowIso(),
        payload: { slack_ts: checklistTs, text },
      });

      const toolCalls = response.tool_calls ?? [];

      if (toolCalls.length === 0) {
        const reply = text.length > 0 ? text : '(empty reply)';
        await editMessage(web, input.channel, checklistTs, reply);
        log.info('turn', `[${input.threadKey}] replied (${reply.length} chars)`);
        return;
      }

      messages.push({ role: 'assistant', content: response.content, tool_calls: toolCalls });

      for (const tc of toolCalls) {
        lines.push(formatToolBullet(tc));
        await updateChecklist();

        // Live-preview slot for bash. Other tools complete fast enough that
        // streaming doesn't help; they don't add a preview line.
        const isBash = tc.function.name === 'bash';
        const liveIdx = isBash ? lines.length : -1;
        if (liveIdx >= 0) {
          lines.push('   …');
          await updateChecklist();
        }
        let liveBuffer = '';
        let flushTimer: ReturnType<typeof setTimeout> | undefined;
        const scheduleFlush = (): void => {
          if (flushTimer || liveIdx < 0) return;
          flushTimer = setTimeout(() => {
            flushTimer = undefined;
            lines[liveIdx] = liveLine(liveBuffer);
            void updateChecklist();
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

        const result = await invokeTool(
          tc.function.name,
          tc.function.arguments,
          {
            threadKey: input.threadKey,
            onProgress,
            web,
            channel: input.channel,
            threadTs: input.threadTs,
          },
          signal,
        );

        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = undefined;
        }
        if (liveIdx >= 0) {
          // Replace the live preview with a one-line summary (e.g. "→ exit: 0").
          const firstLine = result.content.split('\n')[0] ?? '';
          lines[liveIdx] = `   → ${firstLine}`;
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

      lines.push(THINKING_LINE);
      await updateChecklist();
    }
  } catch (err) {
    if (signal?.aborted) {
      await editMessage(web, input.channel, checklistTs, 'stopped').catch(() => {});
      log.info('turn', `[${input.threadKey}] stopped`);
      return;
    }
    const msg = redact((err as Error).message ?? String(err));
    log.error('turn', `[${input.threadKey}] model call failed`, msg);
    await editMessage(web, input.channel, checklistTs, `error: ${msg}`).catch(() => {});
  }
}
