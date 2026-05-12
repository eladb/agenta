import { appendEvent } from './store';

type Base = {
  event_id: string;
  thread_key: string;
  ts: string;
  ingested_at: string;
  causal_parent_ids?: string[];
};

export type AttachmentRef = {
  file_id: string;
  name: string;
  mimetype: string; // detected from file contents at ingest, never from extension
  local_path: string;
};

export type SlackMessageEvent = Base & {
  source: 'slack';
  type: 'message';
  payload: {
    slack_event_id?: string;
    slack_ts: string;
    user: string;
    text: string;
    files?: AttachmentRef[];
  };
};

export type SlackEditEvent = Base & {
  source: 'slack';
  type: 'edit';
  payload: {
    slack_ts: string;
    new_text: string;
    previous_text?: string;
  };
};

export type SlackDeleteEvent = Base & {
  source: 'slack';
  type: 'delete';
  payload: { slack_ts: string };
};

export type AssistantMessageEvent = Base & {
  source: 'assistant';
  type: 'message';
  payload: {
    slack_ts: string;
    text: string;
    // Files the assistant uploaded via the share_file tool. Mirrors the
    // SlackMessageEvent.files shape so the JSONL stays consistent. Note:
    // OpenAI/Anthropic compat doesn't allow image content on assistant
    // messages, so buildMessages currently doesn't project these back into
    // the model's context — they're for archival + future re-injection as
    // synthetic user content if we ever need it.
    files?: AttachmentRef[];
  };
};

// Recorded when the model requests a tool. Linked back to the assistant
// `message` event it came from via parent_event_id, so buildMessages can
// reattach tool_calls to the right assistant message on reconstruction.
export type ToolCallEvent = Base & {
  source: 'assistant';
  type: 'tool_call';
  payload: {
    parent_event_id: string;
    tool_call_id: string;
    name: string;
    arguments_json: string;
  };
};

export type ToolResultEvent = Base & {
  source: 'assistant';
  type: 'tool_result';
  payload: {
    tool_call_id: string;
    content: string;
    error?: boolean;
  };
};

export type AgentaEvent =
  | SlackMessageEvent
  | SlackEditEvent
  | SlackDeleteEvent
  | AssistantMessageEvent
  | ToolCallEvent
  | ToolResultEvent;

export function newEventId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export async function record(event: AgentaEvent): Promise<void> {
  await appendEvent(event.thread_key, event);
}
