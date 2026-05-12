import { runBash } from '../../sandbox/docker';
import { oneLine, strArg, truncate } from './helpers';
import type { Tool } from './types';

const OUTPUT_CAP = 16 * 1024;

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
  if (stdout.length > 0) parts.push(`--- stdout ---\n${truncate(stdout, OUTPUT_CAP, 'stdout')}`);
  if (stderr.length > 0) parts.push(`--- stderr ---\n${truncate(stderr, OUTPUT_CAP, 'stderr')}`);
  return parts.join('\n');
}

export const bash: Tool = {
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
  describe: (args) => {
    const cmd = strArg(args, 'command');
    return cmd ? oneLine(`$ ${cmd}`) : '$ (missing command)';
  },
  invoke: async (args, ctx, signal) => {
    const command = strArg(args, 'command');
    if (!command) throw new Error('bash: missing or invalid command');
    const onChunk = ctx.onProgress
      ? (kind: 'stdout' | 'stderr', chunk: string): void => ctx.onProgress?.({ kind, text: chunk })
      : undefined;
    const result = await runBash(ctx.threadKey, command, signal, onChunk);
    return formatBashResult(result);
  },
};
