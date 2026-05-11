import type { WebClient } from '@slack/web-api';
import { log } from '../log';
import { buildMessages } from '../model/context';
import type { CallModel } from '../model/gateway';
import { newEventId, nowIso, record } from '../persistence/events';
import { editMessage, postInThread } from '../slack/post';
import { redact } from './redact';

export type TurnInput = {
  channel: string;
  threadTs: string;
  threadKey: string;
};

export async function runTurn(
  web: WebClient,
  callModel: CallModel,
  systemPrompt: string,
  input: TurnInput,
): Promise<void> {
  const checklistTs = await postInThread(web, input.channel, input.threadTs, 'thinking...');
  try {
    await editMessage(web, input.channel, checklistTs, '• calling model');
    const messages = await buildMessages(input.threadKey, systemPrompt);
    const reply = await callModel(messages);
    await editMessage(web, input.channel, checklistTs, reply);
    await record({
      event_id: newEventId(),
      thread_key: input.threadKey,
      source: 'assistant',
      type: 'message',
      ts: nowIso(),
      ingested_at: nowIso(),
      payload: { slack_ts: checklistTs, text: reply },
    });
    log.info('turn', `[${input.threadKey}] replied (${reply.length} chars)`);
  } catch (err) {
    const msg = redact((err as Error).message ?? String(err));
    log.error('turn', `[${input.threadKey}] model call failed`, msg);
    await editMessage(web, input.channel, checklistTs, `error: ${msg}`).catch(() => {});
  }
}
