import { grep as grepDocker } from '../../sandbox';
import { oneLine, strArg, truncate } from './helpers';
import type { Tool } from './types';

const OUTPUT_CAP = 16 * 1024;

export const grep: Tool = {
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
          path: { type: 'string', description: 'Path to search under (defaults to /workspace).' },
          glob: { type: 'string', description: 'Glob to filter files, e.g. "**/*.py". Optional.' },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
  },
  describe: (args) => {
    const pat = strArg(args, 'pattern') ?? '?';
    const g = strArg(args, 'glob');
    const p = strArg(args, 'path');
    const where = g ? ` in ${g}` : p ? ` in ${p}` : '';
    return oneLine(`grep "${pat}"${where}`);
  },
  invoke: async (args, ctx, signal) => {
    const a = args as { pattern?: unknown; path?: unknown; glob?: unknown } | null;
    if (typeof a?.pattern !== 'string' || a.pattern.length === 0) {
      throw new Error('grep: missing or invalid pattern');
    }
    const opts: { path?: string; glob?: string } = {};
    if (typeof a.path === 'string') opts.path = a.path;
    if (typeof a.glob === 'string') opts.glob = a.glob;
    const res = await grepDocker(ctx.threadKey, a.pattern, opts, signal);
    if (res.exitCode !== 0) {
      throw new Error((res.stderr || res.stdout).trim() || `grep exited ${res.exitCode}`);
    }
    return truncate(res.stdout || '(no matches)', OUTPUT_CAP, 'grep');
  },
};
