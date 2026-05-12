import { editFile, glob, grep, listDir, readFile, runBash, writeFile } from '../sandbox/docker';
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
const FILE_READ_CAP = 16 * 1024;
const FILE_WRITE_CAP = 64 * 1024;

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

  read_file: {
    def: {
      type: 'function',
      function: {
        name: 'read_file',
        description:
          'Read a text file from the sandbox. Paths are resolved relative to /workspace. Output is truncated at 16 KB. Use offset+limit (1-indexed line numbers) to read part of a large file.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to the file (absolute or relative).' },
            offset: {
              type: 'integer',
              description: '1-indexed starting line. Defaults to 1.',
              minimum: 1,
            },
            limit: {
              type: 'integer',
              description: 'Max number of lines to read. Defaults to all.',
              minimum: 1,
            },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    invoke: async (args, ctx, signal) => {
      const a = args as { path?: unknown; offset?: unknown; limit?: unknown } | null;
      const path = a?.path;
      if (typeof path !== 'string' || path.length === 0) {
        throw new Error('read_file: missing or invalid path');
      }
      const opts: { offset?: number; limit?: number } = {};
      if (typeof a?.offset === 'number') opts.offset = a.offset;
      if (typeof a?.limit === 'number') opts.limit = a.limit;
      const res = await readFile(ctx.threadKey, path, opts, signal);
      if (res.exitCode !== 0) {
        throw new Error((res.stderr || res.stdout).trim() || `read exited ${res.exitCode}`);
      }
      return truncate(res.stdout, FILE_READ_CAP, 'file');
    },
  },

  edit_file: {
    def: {
      type: 'function',
      function: {
        name: 'edit_file',
        description:
          'Replace exactly one occurrence of old_string with new_string in a text file. Fails if old_string occurs zero times or more than once — include enough surrounding context to make the match unique.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to the file.' },
            old_string: {
              type: 'string',
              description: 'Exact substring to find (must occur exactly once).',
            },
            new_string: { type: 'string', description: 'Replacement string.' },
          },
          required: ['path', 'old_string', 'new_string'],
          additionalProperties: false,
        },
      },
    },
    invoke: async (args, ctx, signal) => {
      const a = args as { path?: unknown; old_string?: unknown; new_string?: unknown } | null;
      if (typeof a?.path !== 'string' || a.path.length === 0) {
        throw new Error('edit_file: missing or invalid path');
      }
      if (typeof a.old_string !== 'string' || a.old_string.length === 0) {
        throw new Error('edit_file: missing or invalid old_string');
      }
      if (typeof a.new_string !== 'string') {
        throw new Error('edit_file: missing or invalid new_string');
      }
      const res = await editFile(ctx.threadKey, a.path, a.old_string, a.new_string, signal);
      if (res.exitCode !== 0) {
        throw new Error((res.stderr || res.stdout).trim() || `edit exited ${res.exitCode}`);
      }
      return res.stdout || `edited ${a.path}`;
    },
  },

  grep: {
    def: {
      type: 'function',
      function: {
        name: 'grep',
        description:
          'Search file contents in the sandbox with ripgrep. Returns "file:line:text" matches. Use the optional glob to limit which files are searched (e.g. "**/*.ts"). Output is truncated at 16 KB.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Regex pattern to search for.' },
            path: {
              type: 'string',
              description: 'Path to search under (defaults to /workspace).',
            },
            glob: {
              type: 'string',
              description: 'Glob to filter files, e.g. "**/*.py". Optional.',
            },
          },
          required: ['pattern'],
          additionalProperties: false,
        },
      },
    },
    invoke: async (args, ctx, signal) => {
      const a = args as { pattern?: unknown; path?: unknown; glob?: unknown } | null;
      if (typeof a?.pattern !== 'string' || a.pattern.length === 0) {
        throw new Error('grep: missing or invalid pattern');
      }
      const opts: { path?: string; glob?: string } = {};
      if (typeof a.path === 'string') opts.path = a.path;
      if (typeof a.glob === 'string') opts.glob = a.glob;
      const res = await grep(ctx.threadKey, a.pattern, opts, signal);
      if (res.exitCode !== 0) {
        throw new Error((res.stderr || res.stdout).trim() || `grep exited ${res.exitCode}`);
      }
      return truncate(res.stdout || '(no matches)', BASH_OUTPUT_CAP, 'grep');
    },
  },

  glob: {
    def: {
      type: 'function',
      function: {
        name: 'glob',
        description:
          'List files matching a glob pattern in the sandbox (uses ripgrep --files). E.g. pattern="**/*.ts". Output is one path per line, truncated at 16 KB.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.md".' },
            path: {
              type: 'string',
              description: 'Path to search under (defaults to /workspace).',
            },
          },
          required: ['pattern'],
          additionalProperties: false,
        },
      },
    },
    invoke: async (args, ctx, signal) => {
      const a = args as { pattern?: unknown; path?: unknown } | null;
      if (typeof a?.pattern !== 'string' || a.pattern.length === 0) {
        throw new Error('glob: missing or invalid pattern');
      }
      const opts: { path?: string } = {};
      if (typeof a.path === 'string') opts.path = a.path;
      const res = await glob(ctx.threadKey, a.pattern, opts, signal);
      if (res.exitCode !== 0) {
        throw new Error((res.stderr || res.stdout).trim() || `glob exited ${res.exitCode}`);
      }
      return truncate(res.stdout || '(no files)', BASH_OUTPUT_CAP, 'glob');
    },
  },

  list_dir: {
    def: {
      type: 'function',
      function: {
        name: 'list_dir',
        description:
          'List entries in a sandbox directory. Output columns: type (d/f/?), size in bytes, name. Defaults to /workspace.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Directory path (defaults to /workspace).',
            },
          },
          additionalProperties: false,
        },
      },
    },
    invoke: async (args, ctx, signal) => {
      const a = args as { path?: unknown } | null;
      const path = typeof a?.path === 'string' && a.path.length > 0 ? a.path : undefined;
      const res = await listDir(ctx.threadKey, path, signal);
      if (res.exitCode !== 0) {
        throw new Error((res.stderr || res.stdout).trim() || `ls exited ${res.exitCode}`);
      }
      return res.stdout || '(empty directory)';
    },
  },

  write_file: {
    def: {
      type: 'function',
      function: {
        name: 'write_file',
        description:
          'Write a text file in the sandbox, overwriting if it exists. Parent directories are created automatically. Maximum content size is 64 KB.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Path to write (absolute or relative to /workspace).',
            },
            content: { type: 'string', description: 'Text content to write.' },
          },
          required: ['path', 'content'],
          additionalProperties: false,
        },
      },
    },
    invoke: async (args, ctx, signal) => {
      const path = (args as { path?: unknown } | null)?.path;
      const content = (args as { content?: unknown } | null)?.content;
      if (typeof path !== 'string' || path.length === 0) {
        throw new Error('write_file: missing or invalid path');
      }
      if (typeof content !== 'string') {
        throw new Error('write_file: missing or invalid content');
      }
      if (content.length > FILE_WRITE_CAP) {
        throw new Error(`write_file: content exceeds ${FILE_WRITE_CAP} char limit`);
      }
      const res = await writeFile(ctx.threadKey, path, content, signal);
      if (res.exitCode !== 0) {
        throw new Error((res.stderr || res.stdout).trim() || `write exited ${res.exitCode}`);
      }
      return `wrote ${content.length} chars to ${path}`;
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
