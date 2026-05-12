import { readFile } from '../../sandbox/docker';
import { truncate } from './helpers';
import type { Tool } from './types';

const READ_CAP = 16 * 1024;

export const readFileTool: Tool = {
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
  describe: (args) => {
    const a = args as { path?: unknown; offset?: unknown; limit?: unknown } | null;
    const path = typeof a?.path === 'string' ? a.path : '?';
    const off = typeof a?.offset === 'number' ? a.offset : undefined;
    const lim = typeof a?.limit === 'number' ? a.limit : undefined;
    if (off !== undefined || lim !== undefined) {
      const start = off ?? 1;
      const end = lim !== undefined ? start + lim - 1 : '…';
      return `read ${path}:${start}-${end}`;
    }
    return `read ${path}`;
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
    return truncate(res.stdout, READ_CAP, 'file');
  },
};
