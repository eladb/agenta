// Shared plumbing for the `salto_*` tools (one per `salto-cloud` deployment
// subcommand). All run on the bot host (not the sandbox), so process.env
// already has SALTO_API_TOKEN — the binary picks it up automatically.

import { spawn } from 'node:child_process';

const SALTO_CLI_BIN = 'salto-cloud';
const OUTPUT_CAP = 16 * 1024;

export type SaltoRun = { stdout: string; stderr: string; code: number };

// Spawn salto-cloud with the supplied args. SALTO_API_TOKEN is read from
// process.env at invoke time and passed through unchanged. SIGTERM on abort.
// Resolves (never rejects) with the captured streams + exit code; the caller
// decides whether a non-zero exit is an error condition.
export async function runSaltoCloud(args: string[], signal?: AbortSignal): Promise<SaltoRun> {
  if (!process.env.SALTO_API_TOKEN || process.env.SALTO_API_TOKEN.length === 0) {
    throw new Error('SALTO_API_TOKEN is not set in the bot environment');
  }
  return new Promise<SaltoRun>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(SALTO_CLI_BIN, args, { env: process.env });
    } catch (err) {
      reject(new Error(`failed to spawn ${SALTO_CLI_BIN}: ${(err as Error).message}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf-8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf-8');
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
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}

// Cap the combined output so a chatty CLI run can't blow past the model's
// context. Same shape regardless of exit code so the model can parse it.
export function formatSaltoResult(r: SaltoRun): string {
  const body = `exit ${r.code}\n--- stdout ---\n${r.stdout.trimEnd()}\n--- stderr ---\n${r.stderr.trimEnd()}`;
  return body.length > OUTPUT_CAP
    ? `${body.slice(0, OUTPUT_CAP)}\n…[truncated ${body.length - OUTPUT_CAP} chars]`
    : body;
}

// Identification args (`-i <deployment-id>` OR `-b <branch-name>`) are
// shared by every subcommand except `create`. Validate exactly one is
// present and return the corresponding CLI flag pair.
export function deploymentIdentifierArgs(args: unknown): string[] {
  const a = (args && typeof args === 'object' ? args : {}) as {
    deployment_id?: unknown;
    branch_name?: unknown;
  };
  const id = typeof a.deployment_id === 'string' && a.deployment_id.length > 0 ? a.deployment_id : undefined;
  const branch = typeof a.branch_name === 'string' && a.branch_name.length > 0 ? a.branch_name : undefined;
  if (!id && !branch) {
    throw new Error('provide either deployment_id or branch_name');
  }
  if (id && branch) {
    throw new Error('provide only one of deployment_id or branch_name (not both)');
  }
  return id ? ['-i', id] : ['-b', branch as string];
}

// Describe-line summary of which deployment was targeted, e.g. for the
// Slack tool checklist: "id=dep_123" or "branch=feat-x".
export function deploymentIdentifierLabel(args: unknown): string {
  const a = (args && typeof args === 'object' ? args : {}) as {
    deployment_id?: unknown;
    branch_name?: unknown;
  };
  if (typeof a.deployment_id === 'string' && a.deployment_id.length > 0) {
    return `id=${a.deployment_id}`;
  }
  if (typeof a.branch_name === 'string' && a.branch_name.length > 0) {
    return `branch=${a.branch_name}`;
  }
  return '?';
}

// Shared JSONSchema fragment for the deployment-identifier args. Pulled
// into every tool that accepts them so the model sees the same shape.
export const DEPLOYMENT_IDENTIFIER_PROPERTIES = {
  deployment_id: {
    type: 'string',
    description: 'ID of the deployment (mutually exclusive with branch_name)',
  },
  branch_name: {
    type: 'string',
    description: 'Branch name attached to the deployment (mutually exclusive with deployment_id)',
  },
} as const;
