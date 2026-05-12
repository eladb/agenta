import { runBash } from '../sandbox/docker';
import type { ToolDef } from './gateway';

// Context passed to every tool invocation. Tools that don't need it (e.g.
// get_current_time) just ignore it. The bash tool needs threadKey to pick
// the right per-thread sandbox container.
export type ToolContext = { threadKey: string };

export type Tool = {
  def: ToolDef;
  invoke: (args: unknown, ctx: ToolContext, signal?: AbortSignal) => Promise<string>;
};

const FETCH_BODY_CAP = 8 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const BASH_OUTPUT_CAP = 16 * 1024;

function truncate(s: string, cap: number, label: string): string {
  if (s.length <= cap) return s;
  return `${s.slice(0, cap)}\n…[${label} truncated, ${s.length - cap} more chars]`;
}

export function formatBashResult({
  stdout,
  stderr,
  exitCode,
}: {
  stdout: string;
  stderr: string;
  exitCode: number;
}): string {
  const parts: string[] = [`exit: ${exitCode}`];
  if (stdout.length > 0)
    parts.push(`--- stdout ---\n${truncate(stdout, BASH_OUTPUT_CAP, 'stdout')}`);
  if (stderr.length > 0)
    parts.push(`--- stderr ---\n${truncate(stderr, BASH_OUTPUT_CAP, 'stderr')}`);
  return parts.join('\n');
}

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
    invoke: async (args, _ctx, signal) => {
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

  bash: {
    def: {
      type: 'function',
      function: {
        name: 'bash',
        description:
          "Execute a bash command in this thread's sandbox container. Returns exit code, stdout, and stderr. State (files, cwd) is per-thread and persists across calls.",
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: 'The bash command to run (passed to `bash -lc`).',
            },
          },
          required: ['command'],
          additionalProperties: false,
        },
      },
    },
    invoke: async (args, ctx, signal) => {
      const command = (args as { command?: unknown } | null)?.command;
      if (typeof command !== 'string' || command.length === 0) {
        throw new Error('bash: missing or invalid command');
      }
      const result = await runBash(ctx.threadKey, command, signal);
      return formatBashResult(result);
    },
  },
};

export const TOOL_DEFS: ToolDef[] = Object.values(TOOLS).map((t) => t.def);

export async function invokeTool(
  name: string,
  argumentsJson: string,
  ctx: ToolContext,
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
    const content = await tool.invoke(args, ctx, signal);
    return { content, error: false };
  } catch (err) {
    return { content: `error: ${(err as Error).message}`, error: true };
  }
}
