import type { AgentaEvent } from '../persistence/events';
import { readEvents } from '../persistence/store';
import type { Message } from './gateway';

// Convert the persistent event stream into OpenAI-format messages.
// Only message events contribute right now (slack -> user, assistant -> assistant);
// edit/delete events are persisted but not yet projected into context.
export async function buildMessages(threadKey: string, systemPrompt: string): Promise<Message[]> {
  const events = await readEvents<AgentaEvent>(threadKey);
  const messages: Message[] = [{ role: 'system', content: systemPrompt }];
  for (const e of events) {
    if (e.source === 'slack' && e.type === 'message') {
      messages.push({ role: 'user', content: e.payload.text });
    } else if (e.source === 'assistant' && e.type === 'message') {
      messages.push({ role: 'assistant', content: e.payload.text });
    }
  }
  return messages;
}
