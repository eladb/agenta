import { listDir } from '../../sandbox';
import { strArg } from './helpers';
import type { Tool } from './types';

export const listDirTool: Tool = {
  def: {
    type: 'function',
    function: {
      name: 'list_dir',
      description:
        'List entries in a sandbox directory. Output columns: type (d/f/?), size in bytes, name. Defaults to /workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path (defaults to /workspace).' },
        },
        additionalProperties: false,
      },
    },
  },
  requiresSandbox: true,
  describe: (args) => `list ${strArg(args, 'path') ?? '/workspace'}`,
  invoke: async (args, ctx, signal) => {
    const a = args as { path?: unknown } | null;
    const path = typeof a?.path === 'string' && a.path.length > 0 ? a.path : undefined;
    const res = await listDir(ctx.threadKey, path, signal);
    if (res.exitCode !== 0) {
      throw new Error((res.stderr || res.stdout).trim() || `ls exited ${res.exitCode}`);
    }
    return res.stdout || '(empty directory)';
  },
};
