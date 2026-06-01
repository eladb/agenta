import { editFile } from '../../sandbox';
import { strArg } from './helpers';
import type { Tool } from './types';

export const editFileTool: Tool = {
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
  requiresSandbox: true,
  describe: (args) => `edit ${strArg(args, 'path') ?? '?'}`,
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
};
