export type TextPart = { type: 'text'; text: string };
export type ImageUrlPart = { type: 'image_url'; image_url: { url: string } };
export type ContentPart = TextPart | ImageUrlPart;

export type ToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

export type SystemMessage = { role: 'system'; content: string };
export type UserMessage = { role: 'user'; content: string | ContentPart[] };
export type AssistantMessage = {
  role: 'assistant';
  content: string | null;
  tool_calls?: ToolCall[];
};
export type ToolMessage = { role: 'tool'; tool_call_id: string; content: string };

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

export type ToolDef = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: object;
  };
};

export type CallOptions = { tools?: ToolDef[]; signal?: AbortSignal };

export type CallModel = (messages: Message[], opts?: CallOptions) => Promise<AssistantMessage>;

export type ModelConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens?: number;
};

export function createCallModel(config: ModelConfig): CallModel {
  return async (messages, opts) => {
    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      max_tokens: config.maxTokens ?? 4096,
    };
    if (opts?.tools && opts.tools.length > 0) body.tools = opts.tools;
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: opts?.signal,
    });
    if (!res.ok) {
      throw new Error(`model HTTP ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{
        message?: { content?: string | null; tool_calls?: ToolCall[] };
      }>;
    };
    const msg = json.choices?.[0]?.message;
    if (!msg) throw new Error('model returned no message');
    const content = msg.content ?? null;
    const tool_calls = msg.tool_calls;
    if (content === null && (!tool_calls || tool_calls.length === 0)) {
      throw new Error('model returned empty content and no tool_calls');
    }
    return tool_calls && tool_calls.length > 0
      ? { role: 'assistant', content, tool_calls }
      : { role: 'assistant', content };
  };
}
