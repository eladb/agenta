import { writeFile } from '../../sandbox';
import type { Tool } from './types';

const WRITE_CAP = 64 * 1024;

export const writeFileTool: Tool = {
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
  describe: (args) => {
    const a = args as { path?: unknown; content?: unknown } | null;
    const path = typeof a?.path === 'string' ? a.path : '?';
    const len = typeof a?.content === 'string' ? a.content.length : 0;
    return `write ${path} (${len} chars)`;
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
    if (content.length > WRITE_CAP) {
      throw new Error(`write_file: content exceeds ${WRITE_CAP} char limit`);
    }
    const res = await writeFile(ctx.threadKey, path, content, signal);
    if (res.exitCode !== 0) {
      throw new Error((res.stderr || res.stdout).trim() || `write exited ${res.exitCode}`);
    }
    return `wrote ${content.length} chars to ${path}`;
  },
};
