import type { Tool } from './types';

type Args = {
  repo: string;
  pull_number: number;
  title?: string;
  body?: string;
};

function parseArgs(raw: unknown): Args {
  const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const repo = a.repo;
  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error('repo is required, format "owner/name"');
  }
  const pullNumber = a.pull_number;
  if (typeof pullNumber !== 'number' || !Number.isInteger(pullNumber) || pullNumber <= 0) {
    throw new Error('pull_number is required (positive integer)');
  }
  const title = typeof a.title === 'string' && a.title.length > 0 ? a.title : undefined;
  const body = typeof a.body === 'string' ? a.body : undefined;
  if (title === undefined && body === undefined) {
    throw new Error('at least one of title or body must be provided');
  }
  return { repo, pull_number: pullNumber, title, body };
}

export const githubUpdatePr: Tool = {
  def: {
    type: 'function',
    function: {
      name: 'github_update_pr',
      description:
        "Update a GitHub pull request's title and/or body. Returns the PR URL on success.",
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Target repo in `owner/name` form' },
          pull_number: { type: 'number', description: 'PR number to update' },
          title: { type: 'string', description: 'New PR title (optional)' },
          body: { type: 'string', description: 'New PR body markdown (optional)' },
        },
        required: ['repo', 'pull_number'],
        additionalProperties: false,
      },
    },
  },
  describe: (raw) => {
    const a = (raw && typeof raw === 'object' ? raw : {}) as {
      repo?: unknown;
      pull_number?: unknown;
    };
    const repo = typeof a.repo === 'string' ? a.repo : '?';
    const pr = typeof a.pull_number === 'number' ? `#${a.pull_number}` : '#?';
    return `update PR ${repo}${pr}`;
  },
  invoke: async (raw, _ctx, signal) => {
    const args = parseArgs(raw);

    const token = process.env.GITHUB_TOKEN;
    if (!token || token.length === 0) {
      throw new Error('GITHUB_TOKEN is not set in the bot environment');
    }

    const payload: Record<string, string> = {};
    if (args.title !== undefined) payload.title = args.title;
    if (args.body !== undefined) payload.body = args.body;

    const res = await fetch(
      `https://api.github.com/repos/${args.repo}/pulls/${args.pull_number}`,
      {
        method: 'PATCH',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal,
      },
    );
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`GitHub PATCH /pulls/${args.pull_number} HTTP ${res.status}: ${text}`);
    }
    const pr = JSON.parse(text) as { html_url?: string };
    if (!pr.html_url) throw new Error(`GitHub returned no html_url: ${text}`);
    return pr.html_url;
  },
};

export const _internal = { parseArgs };
