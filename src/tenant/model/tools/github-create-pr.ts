// Create a GitHub pull request from a unified-diff patch the agent
// staged in the sandbox. The bot host handles everything that needs a
// GitHub credential — clone, branch, apply, push, PR — so no token
// ever reaches the sandbox.
//
// Flow per invocation:
//   1. Read the patch out of the sandbox via the existing /read endpoint.
//   2. mkdtemp on the bot host; clone <repo> @ <base> (depth 1, tokenized URL).
//   3. checkout -b <head_branch>, git apply, git add -A, git commit.
//   4. git push origin <head_branch> (tokenized URL — never SSH).
//   5. POST /repos/<repo>/pulls and return the PR URL.
//   6. rm -rf the tempdir (try/finally).
//
// The token used throughout is process.env.GITHUB_TOKEN (Fly secret on
// the bot host). It needs `repo` (classic) or `contents:write` +
// `pull_requests:write` (fine-grained) on the target repo.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile as sandboxReadFile } from '../../sandbox';
import type { Tool } from './types';

type SubmoduleUpdate = { path: string; sha: string };

type Args = {
  repo: string;
  base: string;
  head_branch: string;
  title: string;
  body: string;
  patch_path: string;
  commit_message: string;
  draft: boolean;
  submodule_updates: SubmoduleUpdate[];
};

function parseArgs(raw: unknown): Args {
  const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const repo = a.repo;
  const head = a.head_branch;
  const title = a.title;
  const patchPath = a.patch_path;
  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error('repo is required, format "owner/name"');
  }
  if (typeof head !== 'string' || head.length === 0) throw new Error('head_branch is required');
  if (typeof title !== 'string' || title.length === 0) throw new Error('title is required');
  if (typeof patchPath !== 'string' || patchPath.length === 0) {
    throw new Error('patch_path is required (path inside the sandbox)');
  }
  const submodule_updates: SubmoduleUpdate[] = [];
  if (a.submodule_updates !== undefined) {
    if (!Array.isArray(a.submodule_updates)) {
      throw new Error('submodule_updates must be an array');
    }
    for (const entry of a.submodule_updates) {
      const e = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
      if (typeof e.path !== 'string' || e.path.length === 0) {
        throw new Error('submodule_updates[].path must be a non-empty string');
      }
      if (typeof e.sha !== 'string' || !/^[0-9a-f]{40}$/.test(e.sha)) {
        throw new Error(
          `submodule_updates[].sha must be a 40-char lowercase hex SHA (got ${JSON.stringify(e.sha)})`,
        );
      }
      submodule_updates.push({ path: e.path, sha: e.sha });
    }
  }
  return {
    repo,
    base: typeof a.base === 'string' && a.base.length > 0 ? a.base : 'main',
    head_branch: head,
    title,
    body: typeof a.body === 'string' ? a.body : '',
    patch_path: patchPath,
    commit_message:
      typeof a.commit_message === 'string' && a.commit_message.length > 0
        ? a.commit_message
        : title,
    draft: a.draft === true,
    submodule_updates,
  };
}

type RunResult = { code: number; stdout: string; stderr: string };

// Run a command, optionally piping stdin. Resolves (never rejects) with
// captured streams so the caller can render git's own error verbatim.
function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; stdin?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env });
    } catch (err) {
      reject(new Error(`spawn ${cmd} failed: ${(err as Error).message}`));
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
    opts.signal?.addEventListener('abort', onAbort);
    child.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort);
      reject(new Error(`${cmd} spawn failed: ${err.message}`));
    });
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (opts.stdin !== undefined) {
      child.stdin?.end(opts.stdin);
    }
  });
}

function fail(stage: string, r: RunResult): never {
  const msg = r.stderr.trim() || r.stdout.trim() || `(exit ${r.code})`;
  throw new Error(`${stage} failed (exit ${r.code}): ${msg}`);
}

// HTTPS clone URL with the token spliced into the userinfo segment. Same
// pattern as src/runtime/home-refresh.ts:spliceToken — the token never
// touches the working tree's git config (we use a one-shot URL).
function tokenizedUrl(repo: string, token: string): string {
  // Token is passed as the "user" half of basic auth; "x-access-token" is
  // a conventional placeholder GitHub accepts for PATs.
  return `https://x-access-token:${encodeURIComponent(token)}@github.com/${repo}.git`;
}

export const githubCreatePr: Tool = {
  def: {
    type: 'function',
    function: {
      name: 'github_create_pr',
      description:
        'Create a GitHub pull request. The patch lives at patch_path inside the sandbox (write the unified-diff output of `git diff` or `git diff <base>..HEAD` to that path first). The bot clones the target repo, applies the patch, commits, pushes a new branch, and opens the PR — no GitHub credentials reach the sandbox. Returns the PR URL on success. Fails fast if head_branch already exists on the remote, or if the patch does not apply cleanly against <base>.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Target repo in `owner/name` form' },
          base: {
            type: 'string',
            description: 'Branch to open the PR against (default: "main")',
          },
          head_branch: {
            type: 'string',
            description:
              'New branch the PR is opened from. Must not already exist on the remote. Conventionally `claude/<short-slug>`.',
          },
          title: { type: 'string', description: 'PR title' },
          body: { type: 'string', description: 'PR body (GitHub-flavored markdown)' },
          patch_path: {
            type: 'string',
            description:
              'Path inside the sandbox to a unified-diff patch file. Generate it via `git diff <base>..HEAD > /tmp/pr.patch` after committing locally, or `git diff > /tmp/pr.patch` for uncommitted edits.',
          },
          commit_message: {
            type: 'string',
            description: 'Commit message for the patch (default: title)',
          },
          draft: { type: 'boolean', description: 'Open as draft PR' },
          submodule_updates: {
            type: 'array',
            description:
              'Optional submodule gitlink bumps. `git apply` cannot update gitlinks from a unified diff, so submodule-pointer changes must be passed here. Each entry runs `git update-index --cacheinfo 160000 <sha> <path>` after the patch applies. The submodule must already be registered in the base tree; the submodule itself is NOT cloned. If the only change is a submodule bump, `patch_path` may point at an empty file.',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'Submodule path relative to repo root' },
                sha: {
                  type: 'string',
                  description: '40-char lowercase hex commit SHA to point the submodule at',
                },
              },
              required: ['path', 'sha'],
              additionalProperties: false,
            },
          },
        },
        required: ['repo', 'head_branch', 'title', 'patch_path'],
        additionalProperties: false,
      },
    },
  },
  requiresSandbox: true,
  describe: (raw) => {
    const a = (raw && typeof raw === 'object' ? raw : {}) as {
      repo?: unknown;
      head_branch?: unknown;
    };
    const repo = typeof a.repo === 'string' ? a.repo : '?';
    const head = typeof a.head_branch === 'string' ? a.head_branch : '?';
    return `github PR ${repo} from ${head}`;
  },
  invoke: async (raw, ctx, signal) => {
    const args = parseArgs(raw);

    const token = process.env.GITHUB_TOKEN;
    if (!token || token.length === 0) {
      throw new Error('GITHUB_TOKEN is not set in the bot environment');
    }

    // Pull the patch out of the sandbox. /read returns the full file (no
    // bot-side cap); the only cap is whatever the sandbox can fit in
    // memory, which is fine for any sane diff.
    const read = await sandboxReadFile(ctx.threadKey, args.patch_path, {}, signal);
    if (read.exitCode !== 0) {
      throw new Error(`could not read patch at ${args.patch_path}: ${read.stderr || read.stdout}`);
    }
    const patch = read.stdout;
    if (patch.trim().length === 0 && args.submodule_updates.length === 0) {
      throw new Error(
        `patch at ${args.patch_path} is empty and no submodule_updates provided — nothing to commit`,
      );
    }

    const dir = mkdtempSync(join(tmpdir(), 'agenta-pr-'));
    const work = join(dir, 'work');
    const url = tokenizedUrl(args.repo, token);

    try {
      // 1. Shallow clone of just the base branch.
      const cloned = await run(
        'git',
        ['clone', '--depth', '1', '--branch', args.base, '--quiet', url, work],
        { signal },
      );
      if (cloned.code !== 0) fail('git clone', cloned);

      // 2. Fail fast if the head branch already exists on the remote —
      //    surprising overwrites are worse than a clear error.
      const lsRemote = await run('git', ['ls-remote', '--heads', 'origin', args.head_branch], {
        cwd: work,
        signal,
      });
      if (lsRemote.code === 0 && lsRemote.stdout.trim().length > 0) {
        throw new Error(
          `branch ${args.head_branch} already exists on ${args.repo}. Pick a unique name and retry.`,
        );
      }

      // 3. Create the branch, apply the patch.
      const branch = await run('git', ['checkout', '-b', args.head_branch, '--quiet'], {
        cwd: work,
        signal,
      });
      if (branch.code !== 0) fail('git checkout', branch);

      // git apply reads the patch from stdin. --whitespace=nowarn keeps
      // mixed-tab/space patches from blowing up on a strict default.
      // Skip apply entirely if the patch is whitespace-only (submodule-only PR).
      if (patch.trim().length > 0) {
        const applied = await run('git', ['apply', '--whitespace=nowarn'], {
          cwd: work,
          stdin: patch,
          signal,
        });
        if (applied.code !== 0) fail('git apply', applied);
      }

      // 3b. Apply submodule gitlink bumps. `git apply` doesn't handle
      //     gitlink (mode 160000) updates from a unified diff, so the
      //     agent passes those out-of-band. Each update-index runs
      //     against the index directly — no submodule checkout needed.
      for (const sub of args.submodule_updates) {
        const upd = await run(
          'git',
          ['update-index', '--cacheinfo', `160000,${sub.sha},${sub.path}`],
          { cwd: work, signal },
        );
        if (upd.code !== 0) fail(`git update-index ${sub.path}`, upd);
      }

      // 4. Commit. Identity is local to this one-shot clone, doesn't
      //    touch global git config.
      const added = await run('git', ['add', '-A'], { cwd: work, signal });
      if (added.code !== 0) fail('git add', added);

      const commit = await run(
        'git',
        [
          '-c',
          'user.name=agenta',
          '-c',
          'user.email=agenta@nanabot.me',
          'commit',
          '-m',
          args.commit_message,
          '--quiet',
        ],
        { cwd: work, signal },
      );
      if (commit.code !== 0) fail('git commit', commit);

      // 5. Push the branch over HTTPS using the tokenized origin URL.
      const pushed = await run('git', ['push', '--quiet', 'origin', args.head_branch], {
        cwd: work,
        signal,
      });
      if (pushed.code !== 0) fail('git push', pushed);

      // 6. Open the PR via the REST API. Returning the PR's html_url
      //    keeps the contract small.
      const apiRes = await fetch(`https://api.github.com/repos/${args.repo}/pulls`, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: args.title,
          body: args.body,
          head: args.head_branch,
          base: args.base,
          draft: args.draft,
        }),
        signal,
      });
      const apiText = await apiRes.text();
      if (!apiRes.ok) {
        throw new Error(`GitHub /pulls HTTP ${apiRes.status}: ${apiText}`);
      }
      const pr = JSON.parse(apiText) as { html_url?: string; number?: number };
      if (!pr.html_url) throw new Error(`GitHub /pulls returned no html_url: ${apiText}`);
      return pr.html_url;
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort; tmpdir cleanup failures shouldn't mask the actual result
      }
    }
  },
};

// Exported for unit tests so they can exercise pure validation logic
// without hitting fs/git/network.
export const _internal = { parseArgs, tokenizedUrl };
