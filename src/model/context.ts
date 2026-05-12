import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentaEvent, AttachmentRef, ToolCallEvent } from '../persistence/events';
import { readEvents, threadDir } from '../persistence/store';
import type { ContentPart, Message, ToolCall } from './gateway';

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const TEXT_MIMES = new Set([
  'text/plain',
  'text/markdown',
  'text/html',
  'text/csv',
  'text/xml',
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/x-yaml',
  'application/yaml',
  'application/toml',
]);
const TEXT_BYTE_CAP = 20 * 1024;

// Convert the persistent event stream into OpenAI-format messages.
// Slack messages with attachments produce multipart `content` arrays:
//   - image/* (png/jpeg/gif/webp): inline as image_url data URI
//   - application/pdf: inline as image_url data URI (Anthropic OpenAI-compat path)
//   - text/* and text-ish application/*: inlined into a text part, capped at 20KB
//   - anything else: a `[attached: name (mime) — not passed to model]` placeholder
export async function buildMessages(threadKey: string, systemPrompt: string): Promise<Message[]> {
  const events = await readEvents<AgentaEvent>(threadKey);
  // Index tool_call events by parent assistant message event_id so each
  // assistant 'message' can re-attach its tool_calls in original order.
  const toolCallsByParent = new Map<string, ToolCallEvent[]>();
  for (const e of events) {
    if (e.source === 'assistant' && e.type === 'tool_call') {
      const list = toolCallsByParent.get(e.payload.parent_event_id);
      if (list) list.push(e);
      else toolCallsByParent.set(e.payload.parent_event_id, [e]);
    }
  }

  // tool_result events keyed by tool_call_id — used both to skip emitting
  // duplicate role:tool messages from the main loop and to detect orphan
  // tool_calls (recorded request, no matching result — happens if a turn
  // crashed mid-execution). Orphans get a synthetic error tool message so
  // the assistant tool_calls -> tool message invariant the model API
  // requires is never violated on reconstruction.
  const toolResultIds = new Set<string>();
  for (const e of events) {
    if (e.source === 'assistant' && e.type === 'tool_result') {
      toolResultIds.add(e.payload.tool_call_id);
    }
  }

  const messages: Message[] = [{ role: 'system', content: systemPrompt }];
  for (const e of events) {
    if (e.source === 'slack' && e.type === 'message') {
      const text = e.payload.text;
      const files = e.payload.files ?? [];
      if (files.length === 0) {
        messages.push({ role: 'user', content: text });
      } else {
        const parts: ContentPart[] = [];
        if (text.length > 0) parts.push({ type: 'text', text });
        for (const f of files) {
          parts.push(await fileToContentPart(threadKey, f));
        }
        messages.push({ role: 'user', content: parts });
      }
    } else if (e.source === 'assistant' && e.type === 'message') {
      const tcs = toolCallsByParent.get(e.event_id);
      const tool_calls: ToolCall[] | undefined = tcs?.map((tc) => ({
        id: tc.payload.tool_call_id,
        type: 'function',
        function: { name: tc.payload.name, arguments: tc.payload.arguments_json },
      }));
      const content = e.payload.text.length > 0 ? e.payload.text : tool_calls ? null : '';
      messages.push(
        tool_calls ? { role: 'assistant', content, tool_calls } : { role: 'assistant', content },
      );
      // Synthesize a tool message for any tool_call that never got a recorded
      // tool_result, immediately after its parent assistant message.
      if (tcs) {
        for (const tc of tcs) {
          if (!toolResultIds.has(tc.payload.tool_call_id)) {
            messages.push({
              role: 'tool',
              tool_call_id: tc.payload.tool_call_id,
              content: 'error: tool result not recorded',
            });
          }
        }
      }
    } else if (e.source === 'assistant' && e.type === 'tool_result') {
      messages.push({
        role: 'tool',
        tool_call_id: e.payload.tool_call_id,
        content: e.payload.content,
      });
    }
    // tool_call events are folded into their parent assistant message above.
  }
  return messages;
}

async function fileToContentPart(threadKey: string, f: AttachmentRef): Promise<ContentPart> {
  const fullPath = join(threadDir(threadKey), f.local_path);
  if (IMAGE_MIMES.has(f.mimetype) || f.mimetype === 'application/pdf') {
    const buf = await readFile(fullPath);
    const b64 = buf.toString('base64');
    return { type: 'image_url', image_url: { url: `data:${f.mimetype};base64,${b64}` } };
  }
  if (TEXT_MIMES.has(f.mimetype) || f.mimetype.startsWith('text/')) {
    const buf = await readFile(fullPath);
    const truncated =
      buf.byteLength > TEXT_BYTE_CAP
        ? `${buf.subarray(0, TEXT_BYTE_CAP).toString('utf-8')}\n…[truncated ${buf.byteLength - TEXT_BYTE_CAP} bytes]`
        : buf.toString('utf-8');
    return { type: 'text', text: `[attached file: ${f.name}]\n\n${truncated}` };
  }
  return {
    type: 'text',
    text: `[attached: ${f.name} (${f.mimetype}) — not passed to model]`,
  };
}
