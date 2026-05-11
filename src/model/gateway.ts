export type TextPart = { type: 'text'; text: string };
export type ImageUrlPart = { type: 'image_url'; image_url: { url: string } };
export type ContentPart = TextPart | ImageUrlPart;

export type Message = {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
};

export type CallModel = (messages: Message[], signal?: AbortSignal) => Promise<string>;

export type ModelConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens?: number;
};

export function createCallModel(config: ModelConfig): CallModel {
  return async (messages, signal) => {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        max_tokens: config.maxTokens ?? 4096,
      }),
      signal,
    });
    if (!res.ok) {
      throw new Error(`model HTTP ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new Error('model returned empty content');
    return content;
  };
}
