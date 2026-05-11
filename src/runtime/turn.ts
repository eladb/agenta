import type { WebClient } from '@slack/web-api';
import { log } from '../log';
import { buildMessages } from '../model/context';
import type { CallModel, Message, ToolCall } from '../model/gateway';
import { invokeTool, TOOL_DEFS } from '../model/tools';
import { newEventId, nowIso, record } from '../persistence/events';
import { editMessage, postInThread } from '../slack/post';
import { redact } from './redact';

export type TurnInput = {
  channel: string;
  threadTs: string;
  threadKey: string;
};

const ARGS_PREVIEW_LEN = 80;

function formatToolBullet(tc: ToolCall): string {
  const a = tc.function.arguments;
  const args = a.length > ARGS_PREVIEW_LEN ? `${a.slice(0, ARGS_PREVIEW_LEN - 1)}…` : a;
  return `• tool: ${tc.function.name}(${args})`;
}

export async function runTurn(
  web: WebClient,
  callModel: CallModel,
  systemPrompt: string,
  input: TurnInput,
  signal?: AbortSignal,
): Promise<void> {
  const checklistTs = await postInThread(web, input.channel, input.threadTs, 'thinking...');
  const lines: string[] = ['• calling model'];
  const updateChecklist = (): Promise<void> =>
    editMessage(web, input.channel, checklistTs, lines.join('\n')).catch(() => {});

  try {
    await updateChecklist();
    const messages: Message[] = await buildMessages(input.threadKey, systemPrompt);

    while (true) {
      const response = await callModel(messages, { tools: TOOL_DEFS, signal });

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

        const result = await invokeTool(tc.function.name, tc.function.arguments, signal);

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

      lines.push('• calling model');
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
