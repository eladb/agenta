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
  mimetype?: string;
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
  payload: { slack_ts: string; text: string };
};

export type AgentaEvent =
  | SlackMessageEvent
  | SlackEditEvent
  | SlackDeleteEvent
  | AssistantMessageEvent;

export function newEventId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export async function record(event: AgentaEvent): Promise<void> {
  await appendEvent(event.thread_key, event);
}
