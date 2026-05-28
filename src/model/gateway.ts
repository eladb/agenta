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
  // Bedrock branch (#new): `bedrock://<region>` base_urls invoke Bedrock's
  // native Anthropic Messages endpoint with a long-term API key (bearer
  // token in AWS_BEARER_TOKEN_BEDROCK or equivalent). Wire format differs
  // from OpenAI-compat: body uses Anthropic's `system` + `messages` shape
  // with `tool_use` / `tool_result` content blocks; tools schema is
  // `{name, description, input_schema}` not `{type, function:{…}}`. We
  // translate on send and reverse on receive so the rest of the codebase
  // continues to deal in OpenAI-shape Messages.
  if (config.baseUrl.startsWith('bedrock://')) {
    return createBedrockCallModel(config);
  }
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

// =============================================================================
// Bedrock branch — native Anthropic Messages API on AWS Bedrock with a
// long-term API key (bearer token). Documented at
// https://docs.aws.amazon.com/bedrock/latest/userguide/inference-invoke.html
// and https://docs.anthropic.com/en/api/claude-on-amazon-bedrock.
//
// `config.baseUrl` shape: `bedrock://<region>` (e.g. `bedrock://us-east-1`).
// `config.model` must be a Bedrock inference-profile id, e.g.
// `us.anthropic.claude-opus-4-7` — raw foundation-model ids like
// `anthropic.claude-opus-4-7` are rejected by the API with "on-demand
// throughput isn't supported".
// =============================================================================

type AnthropicTextBlock = { type: 'text'; text: string };
type AnthropicImageBlock = {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
};
type AnthropicDocumentBlock = {
  type: 'document';
  source: { type: 'base64'; media_type: string; data: string };
};
type AnthropicToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown };
type AnthropicToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
};
type AnthropicBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicDocumentBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;
type AnthropicMessage = { role: 'user' | 'assistant'; content: AnthropicBlock[] };

type BedrockRequest = {
  anthropic_version: 'bedrock-2023-05-31';
  max_tokens: number;
  system?: string;
  messages: AnthropicMessage[];
  tools?: Array<{ name: string; description: string; input_schema: object }>;
};

type BedrockResponse = {
  content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
  stop_reason?: string;
};

// Parse a `data:<media>;base64,<payload>` URL. Anthropic Bedrock only
// accepts inline base64 sources, so URLs without a data: prefix are an
// error at this boundary rather than a silent fall-through.
function decodeDataUrl(url: string): { mediaType: string; data: string } {
  const m = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new Error(`bedrock: only data: URLs are supported, got ${url.slice(0, 40)}…`);
  return { mediaType: m[1] as string, data: m[2] as string };
}

export function translateToBedrock(messages: Message[]): {
  system?: string;
  messages: AnthropicMessage[];
} {
  let system: string | undefined;
  const out: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      // Anthropic puts system as a top-level field, not in messages[].
      // Multiple system messages in the input collapse with blank-line joins.
      system = system === undefined ? m.content : `${system}\n\n${m.content}`;
      continue;
    }
    if (m.role === 'user') {
      const blocks: AnthropicBlock[] =
        typeof m.content === 'string'
          ? [{ type: 'text', text: m.content }]
          : m.content.map((p): AnthropicBlock => {
              if (p.type === 'text') return { type: 'text', text: p.text };
              const { mediaType, data } = decodeDataUrl(p.image_url.url);
              if (mediaType === 'application/pdf') {
                return {
                  type: 'document',
                  source: { type: 'base64', media_type: mediaType, data },
                };
              }
              return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
            });
      // Drop empty text blocks — Bedrock rejects { type:'text', text:'' } with
      // HTTP 400 (#223). Layer 1 (context.ts) already skips empty no-file
      // user messages, but guard here too so no source can sneak an empty
      // block through.
      const nonEmpty = blocks.filter((b) => !(b.type === 'text' && b.text === ''));
      // A user turn with nothing left after filtering must not be pushed (and
      // must not be merged into a prior user turn) — an empty content array is
      // also invalid.
      if (nonEmpty.length === 0) continue;
      // Merge consecutive same-role messages — Anthropic requires
      // strictly alternating user/assistant turns.
      const last = out[out.length - 1];
      if (last && last.role === 'user') last.content.push(...nonEmpty);
      else out.push({ role: 'user', content: nonEmpty });
      continue;
    }
    if (m.role === 'assistant') {
      const blocks: AnthropicBlock[] = [];
      if (typeof m.content === 'string' && m.content.length > 0) {
        blocks.push({ type: 'text', text: m.content });
      }
      for (const tc of m.tool_calls ?? []) {
        // Parse the JSON-encoded arguments string back into an object.
        // Malformed JSON becomes an empty object so we don't 400 the whole
        // call — the model will see its own bad tool_use and self-correct.
        let input: unknown = {};
        try {
          input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          input = {};
        }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
      // Anthropic forbids empty assistant content AND rejects an empty text
      // block ({ type:'text', text:'' } → HTTP 400, #223). A zero-block
      // assistant turn (content:null/'' with no tool_calls) shouldn't occur
      // mid-history given Layer 1 + the orphan-tool_call guards; if it does,
      // skip it rather than emit an empty text block. The trailing-assistant
      // strip below handles the interrupted-turn recovery case.
      if (blocks.length === 0) continue;
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    // role === 'tool' — Anthropic embeds these as tool_result blocks
    // inside a user turn. The API requires tool_result blocks in the user
    // turn IMMEDIATELY after the assistant turn containing the tool_use.
    //
    // In OpenAI format, a user message can appear between an assistant's
    // tool_calls and its tool results (mid-turn steering). In Anthropic
    // format that's invalid — tool_results must come first. We handle
    // this by prepending the tool_result into the existing user turn
    // (before any text blocks) when one already exists after the last
    // assistant turn, or by creating a fresh user turn otherwise.
    const block: AnthropicToolResultBlock = {
      type: 'tool_result',
      tool_use_id: m.tool_call_id,
      content: m.content,
    };
    const last = out[out.length - 1];
    if (last && last.role === 'user') {
      // Find the insertion point: after existing tool_result blocks but
      // before any text/image/document blocks. This ensures tool_results
      // cluster at the front of the user turn (satisfying the API) while
      // user text from steering follows.
      let insertIdx = 0;
      while (insertIdx < last.content.length && last.content[insertIdx]?.type === 'tool_result') {
        insertIdx++;
      }
      last.content.splice(insertIdx, 0, block);
    } else {
      out.push({ role: 'user', content: [block] });
    }
  }
  // Bedrock does not support assistant message prefill — strip a trailing
  // assistant message (can appear when recovering an interrupted turn whose
  // last recorded event was an assistant text with no tool_calls).
  while (out.length > 0 && out[out.length - 1]?.role === 'assistant') {
    out.pop();
  }
  return { system, messages: out };
}

export function translateFromBedrock(resp: BedrockResponse): AssistantMessage {
  let text = '';
  const tool_calls: ToolCall[] = [];
  for (const block of resp.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') {
      text += block.text;
    } else if (block.type === 'tool_use' && block.id && block.name) {
      tool_calls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }
  const content: string | null = text.length > 0 ? text : null;
  if (content === null && tool_calls.length === 0) {
    throw new Error('bedrock returned empty content and no tool_use blocks');
  }
  return tool_calls.length > 0
    ? { role: 'assistant', content, tool_calls }
    : { role: 'assistant', content: content as string };
}

function createBedrockCallModel(config: ModelConfig): CallModel {
  const region = config.baseUrl.slice('bedrock://'.length);
  if (region.length === 0) {
    throw new Error(`bedrock base_url must be bedrock://<region>, got ${config.baseUrl}`);
  }
  const endpoint = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(config.model)}/invoke`;
  return async (messages, opts) => {
    const apiKey = config.apiKey ?? (config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined);
    if (!apiKey) {
      throw new Error(
        config.apiKeyEnv
          ? `model api key env ${config.apiKeyEnv} is unset at call time`
          : 'model api key is unset',
      );
    }
    const { system, messages: amsgs } = translateToBedrock(messages);
    const body: BedrockRequest = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: config.maxTokens ?? 4096,
      messages: amsgs,
    };
    if (system !== undefined) body.system = system;
    if (opts?.tools && opts.tools.length > 0) {
      body.tools = opts.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
    }
    log.info('gateway', `→ ${config.model} via bedrock ${region}`);
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: opts?.signal,
    });
    if (!res.ok) {
      throw new Error(`model HTTP ${res.status}: ${await res.text()}`);
    }
    const responseText = await res.text();
    let json: BedrockResponse;
    try {
      json = JSON.parse(responseText);
    } catch (err) {
      const preview = responseText.length > 200 ? `${responseText.slice(0, 200)}…` : responseText;
      throw new Error(
        `model JSON parse failed (${(err as Error).message}); body preview: ${JSON.stringify(preview)}`,
      );
    }
    return translateFromBedrock(json);
  };
}
