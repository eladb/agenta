import { glob as globDocker } from '../../sandbox';
import { oneLine, strArg, truncate } from './helpers';
import type { Tool } from './types';

const OUTPUT_CAP = 16 * 1024;

export const glob: Tool = {
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
          path: { type: 'string', description: 'Path to search under (defaults to /workspace).' },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
  },
  describe: (args) => {
    const pat = strArg(args, 'pattern') ?? '?';
    const p = strArg(args, 'path');
    return oneLine(p ? `glob ${pat} in ${p}` : `glob ${pat}`);
  },
  invoke: async (args, ctx, signal) => {
    const a = args as { pattern?: unknown; path?: unknown } | null;
    if (typeof a?.pattern !== 'string' || a.pattern.length === 0) {
      throw new Error('glob: missing or invalid pattern');
    }
    const opts: { path?: string } = {};
    if (typeof a.path === 'string') opts.path = a.path;
    const res = await globDocker(ctx.threadKey, a.pattern, opts, signal);
    if (res.exitCode !== 0) {
      throw new Error((res.stderr || res.stdout).trim() || `glob exited ${res.exitCode}`);
    }
    return truncate(res.stdout || '(no files)', OUTPUT_CAP, 'glob');
  },
};
