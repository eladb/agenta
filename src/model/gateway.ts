import { log } from '../log';

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
  // Either `apiKey` (literal) or `apiKeyEnv` (env var name read at every
  // call). The env-name form mirrors how `home.auth_env` works for git
  // PATs/PEMs — the value is never persisted into session.json, only the
  // name is, and the secret is resolved lazily so an unset env at construct
  // time can still recover if the secret is set later.
  apiKey?: string;
  apiKeyEnv?: string;
  baseUrl: string;
  model: string;
  maxTokens?: number;
};

export function createCallModel(config: ModelConfig): CallModel {
  return async (messages, opts) => {
    const apiKey = config.apiKey ?? (config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined);
    if (!apiKey) {
      throw new Error(
        config.apiKeyEnv
          ? `model api key env ${config.apiKeyEnv} is unset at call time`
          : 'model api key is unset',
      );
    }
    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      max_tokens: config.maxTokens ?? 4096,
    };
    if (opts?.tools && opts.tools.length > 0) body.tools = opts.tools;
    log.info('gateway', `→ ${config.model} via ${config.baseUrl}`);
    // OpenRouter recommends these headers (used for ranking/rate-limiting on
    // their free tier). Harmless against Anthropic's native compat endpoint.
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://github.com/eladb/agenta',
        'X-Title': 'agenta',
      },
      body: JSON.stringify(body),
      signal: opts?.signal,
    });
    if (!res.ok) {
      throw new Error(`model HTTP ${res.status}: ${await res.text()}`);
    }
    const responseText = await res.text();
    let json: {
      choices?: Array<{
        message?: { content?: string | null; tool_calls?: ToolCall[] };
      }>;
    };
    try {
      json = JSON.parse(responseText);
    } catch (err) {
      const preview = responseText.length > 200 ? `${responseText.slice(0, 200)}…` : responseText;
      throw new Error(
        `model JSON parse failed (${(err as Error).message}); body preview: ${JSON.stringify(preview)}`,
      );
    }
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
