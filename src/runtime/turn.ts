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

// Visual marker for intermediate ("in progress") thread messages. Final
// replies post without it, so the user can distinguish a step-along-the-way
// from the actual answer.
const IN_PROGRESS_MARKER = '💭 ';
const PLACEHOLDER_TEXT = 'thinking…';

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
  // Collapse newlines so each tool's preview stays single-line.
  const flat = preview.replace(/[\r\n]+/g, ' ⏎ ').slice(-LIVE_PREVIEW_LEN);
  return `   ${flat}`;
}

function renderRound(headerText: string, lines: string[]): string {
  // Round message = leading marker + header text, then a blank line, then
  // each bullet/preview line in order. If no bullets yet, just the header.
  const head = `${IN_PROGRESS_MARKER}${headerText}`;
  if (lines.length === 0) return head;
  return `${head}\n\n${lines.join('\n')}`;
}

export async function runTurn(
  web: WebClient,
  callModel: CallModel,
  systemPrompt: string,
  input: TurnInput,
  signal?: AbortSignal,
): Promise<void> {
  // The "live" message tracks ONLY the current round. When the next round
  // begins (model returns more text + tool calls), we leave this message
  // frozen and post a new one. When the final reply lands, we post it as
  // a fresh clean message and delete any in-flight placeholder.
  let liveTs: string | undefined;
  let liveHeader = PLACEHOLDER_TEXT;
  let liveLines: string[] = [];

  const repaint = (): Promise<void> => {
    if (!liveTs) return Promise.resolve();
    return editMessage(web, input.channel, liveTs, renderRound(liveHeader, liveLines)).catch(
      () => {},
    );
  };

  // Post the round-1 placeholder up front so the user sees something land
  // in the thread the instant they mention the bot. If the model replies
  // directly (no tool calls), we delete this and post the clean final.
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

      // No tool calls → this is the final reply. Drop the placeholder/
      // last-intermediate live message and post a clean final.
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

      // Has tool calls → start a new round. The current liveTs already
      // exists (placeholder for the first iteration, or pre-posted for
      // subsequent iterations below). Stamp this round's header on it.
      liveHeader = text.length > 0 ? text : PLACEHOLDER_TEXT;
      liveLines = [];
      await repaint();

      messages.push({ role: 'assistant', content: response.content, tool_calls: toolCalls });

      for (const tc of toolCalls) {
        // Lazy sandbox provisioning. If this tool touches the sandbox and
        // we haven't provisioned yet in this process, surface a status
        // line BEFORE the tool bullet so the chronology in the round
        // matches what actually happened.
        const tool = TOOLS[tc.function.name];
        let provisionError: string | undefined;
        if (tool?.requiresSandbox && !isSandboxReady(input.threadKey)) {
          const provIdx = liveLines.length;
          liveLines.push('• provisioning workspace…');
          await repaint();
          try {
            await ensureContainer(input.threadKey);
            liveLines[provIdx] = '• workspace ready';
          } catch (err) {
            const msg = (err as Error).message;
            provisionError = msg;
            liveLines[provIdx] = `• workspace provisioning failed: ${msg}`;
          }
          await repaint();
        }

        // After provisioning, push ingested Slack attachments into the
        // sandbox so tools can read them. Idempotent + cached.
        if (tool?.requiresSandbox && !provisionError) {
          try {
            const { synced } = await syncAttachmentsToSandbox(input.threadKey);
            if (synced > 0) {
              liveLines.push(`• synced ${synced} attachment(s) to workspace`);
              await repaint();
            }
          } catch (err) {
            log.warn('turn', `[${input.threadKey}] attachment sync failed`, err);
          }
        }

        const bulletIdx = liveLines.length;
        liveLines.push(formatToolBullet(tc));
        await repaint();

        // Live-preview slot for bash. Other tools complete fast enough
        // that streaming doesn't help; they don't add a preview line.
        const isBash = tc.function.name === 'bash';
        const liveIdx = isBash ? liveLines.length : -1;
        if (liveIdx >= 0) {
          liveLines.push('   …');
          await repaint();
        }
        let liveBuffer = '';
        let flushTimer: ReturnType<typeof setTimeout> | undefined;
        const scheduleFlush = (): void => {
          if (flushTimer || liveIdx < 0) return;
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
                // The "checklist message" that ask_user renders blocks on is
                // the current round's live message. Falls back to threadTs
                // if for some reason there isn't a live one.
                checklistTs: liveTs ?? input.threadTs,
              },
              signal,
            );

        // Show the user's answer inline on the ask_user bullet so the
        // resolved choice stays visible after the ask blocks are cleared.
        if (tc.function.name === 'ask_user' && !result.error) {
          liveLines[bulletIdx] = `${liveLines[bulletIdx]} → ${result.content}`;
        }

        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = undefined;
        }
        if (liveIdx >= 0) {
          const firstLine = result.content.split('\n')[0] ?? '';
          liveLines[liveIdx] = `   → ${firstLine}`;
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

      // End of this round. Repaint one last time so the frozen message
      // shows its final state, then post a fresh placeholder for the
      // NEXT round before we call the model again.
      await repaint();
      liveHeader = PLACEHOLDER_TEXT;
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
