import { spawn } from 'node:child_process';
import type { Tool } from './types';

// Generic passthrough to the `salto-cloud` CLI on the bot host. One tool
// instead of N typed wrappers per subcommand: the CLI's own help text and
// argv contract are the agent-facing interface. SALTO_API_TOKEN comes from
// the bot environment (Fly secret); it's not passed via args.
//
// Scope: every command exposed by `salto-cloud` (v1.4.4 ships only the
// `deployment` tree — show/preview/deploy/validate/sync, plus
// create/update subcommands). New subcommands added in future CLI
// releases work automatically without code changes here.
//
// All deployment subcommands identify the deployment server-side
// (`-i <id>`, `-b <branch-name>`, or `-u <pr-url>`); no local workspace
// files are required, which is why the tool lives on the bot side.

const SALTO_CLI_BIN = 'salto-cloud';
const OUTPUT_CAP = 16 * 1024;

export const saltoCli: Tool = {
  def: {
    type: 'function',
    function: {
      name: 'salto_cli',
      description:
        'Run the salto-cloud CLI on the bot host with the given args. SALTO_API_TOKEN is supplied via the bot environment automatically — do NOT pass `-t` / `--api-token` in args. Discover commands with args=["--help"] or args=["deployment","--help"]. Currently exposes the `deployment` tree (show, preview, deploy, validate, sync, create from-{pull-request,deployments,source-environment}, update from-pull-request). All subcommands identify the deployment server-side via -i/-b/-u; no local workspace files are needed.',
      parameters: {
        type: 'object',
        properties: {
          args: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Args passed verbatim to salto-cloud. Examples: ["--help"], ["deployment","show","-i","dep_abc"], ["deployment","preview","-b","my-branch"].',
          },
        },
        required: ['args'],
        additionalProperties: false,
      },
    },
  },
  describe: (raw) => {
    const a = (raw && typeof raw === 'object' ? raw : {}) as { args?: unknown };
    if (!Array.isArray(a.args) || a.args.length === 0) return 'salto-cloud (no args)';
    const flat = a.args.filter((x) => typeof x === 'string').join(' ');
    return `salto-cloud ${flat.length > 60 ? `${flat.slice(0, 60)}…` : flat}`;
  },
  invoke: async (raw, _ctx, signal) => {
    const a = (raw && typeof raw === 'object' ? raw : {}) as { args?: unknown };
    if (!Array.isArray(a.args)) throw new Error('args (string[]) is required');
    const argv: string[] = [];
    for (const x of a.args) {
      if (typeof x !== 'string') throw new Error('every entry in args must be a string');
      argv.push(x);
    }
    if (!process.env.SALTO_API_TOKEN || process.env.SALTO_API_TOKEN.length === 0) {
      throw new Error('SALTO_API_TOKEN is not set in the bot environment');
    }
    return new Promise<string>((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(SALTO_CLI_BIN, argv, { env: process.env });
      } catch (err) {
        reject(new Error(`failed to spawn ${SALTO_CLI_BIN}: ${(err as Error).message}`));
        return;
      }
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => {
        const chunk = d.toString('utf-8');
        stdout += chunk;
        ctx.onProgress?.({ kind: 'stdout', text: chunk });
      });
      child.stderr?.on('data', (d: Buffer) => {
        const chunk = d.toString('utf-8');
        stderr += chunk;
        ctx.onProgress?.({ kind: 'stderr', text: chunk });
      });
      const onAbort = (): void => {
        child.kill('SIGTERM');
      };
      signal?.addEventListener('abort', onAbort);
      child.on('error', (err) => {
        signal?.removeEventListener('abort', onAbort);
        reject(new Error(`${SALTO_CLI_BIN} spawn failed: ${err.message}`));
      });
      child.on('close', (code) => {
        signal?.removeEventListener('abort', onAbort);
        const body = `exit ${code ?? -1}\n--- stdout ---\n${stdout.trimEnd()}\n--- stderr ---\n${stderr.trimEnd()}`;
        resolve(
          body.length > OUTPUT_CAP
            ? `${body.slice(0, OUTPUT_CAP)}\n…[truncated ${body.length - OUTPUT_CAP} chars]`
            : body,
        );
      });
    });
  },
};
