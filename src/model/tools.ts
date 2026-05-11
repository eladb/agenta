import type { ToolDef } from './gateway';

export type Tool = {
  def: ToolDef;
  invoke: (args: unknown, signal?: AbortSignal) => Promise<string>;
};

const FETCH_BODY_CAP = 8 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

export const TOOLS: Record<string, Tool> = {
  get_current_time: {
    def: {
      type: 'function',
      function: {
        name: 'get_current_time',
        description: 'Returns the current UTC time as an ISO-8601 string.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    invoke: async () => new Date().toISOString(),
  },

  fetch_url: {
    def: {
      type: 'function',
      function: {
        name: 'fetch_url',
        description: 'HTTP GET the given URL and return the response body (truncated to 8 KB).',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string', description: 'The URL to GET' } },
          required: ['url'],
          additionalProperties: false,
        },
      },
    },
    invoke: async (args, signal) => {
      const url = (args as { url?: unknown } | null)?.url;
      if (typeof url !== 'string' || url.length === 0) {
        throw new Error('fetch_url: missing or invalid url');
      }
      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      signal?.addEventListener('abort', onAbort);
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(url, { method: 'GET', signal: controller.signal });
        const text = await res.text();
        const body =
          text.length > FETCH_BODY_CAP
            ? `${text.slice(0, FETCH_BODY_CAP)}\n…[truncated ${text.length - FETCH_BODY_CAP} chars]`
            : text;
        return `HTTP ${res.status}\n\n${body}`;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    },
  },
};

export const TOOL_DEFS: ToolDef[] = Object.values(TOOLS).map((t) => t.def);

export async function invokeTool(
  name: string,
  argumentsJson: string,
  signal?: AbortSignal,
): Promise<{ content: string; error: boolean }> {
  const tool = TOOLS[name];
  if (!tool) return { content: `error: unknown tool '${name}'`, error: true };
  let args: unknown;
  try {
    args = argumentsJson.length > 0 ? JSON.parse(argumentsJson) : {};
  } catch (err) {
    return { content: `error: invalid JSON arguments: ${(err as Error).message}`, error: true };
  }
  try {
    const content = await tool.invoke(args, signal);
    return { content, error: false };
  } catch (err) {
    return { content: `error: ${(err as Error).message}`, error: true };
  }
}
