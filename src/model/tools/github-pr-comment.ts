import type { Tool } from './types';

type Args = {
  repo: string;
  pull_number: number;
  body: string;
  comment_id?: number;
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
  const body = a.body;
  if (typeof body !== 'string' || body.length === 0) {
    throw new Error('body is required (non-empty string)');
  }
  const commentId = a.comment_id;
  const parsedCommentId =
    typeof commentId === 'number' && Number.isInteger(commentId) && commentId > 0
      ? commentId
      : undefined;
  return { repo, pull_number: pullNumber, body, comment_id: parsedCommentId };
}

export const githubPrComment: Tool = {
  def: {
    type: 'function',
    function: {
      name: 'github_pr_comment',
      description:
        'Post or edit a comment on a GitHub pull request. If comment_id is provided, edits the existing comment; otherwise creates a new one. Returns JSON with the comment URL and ID.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Target repo in `owner/name` form' },
          pull_number: { type: 'number', description: 'PR number to comment on' },
          body: { type: 'string', description: 'Comment body (GitHub-flavored markdown)' },
          comment_id: {
            type: 'number',
            description: 'Existing comment ID to edit (omit to create a new comment)',
          },
        },
        required: ['repo', 'pull_number', 'body'],
        additionalProperties: false,
      },
    },
  },
  describe: (raw) => {
    const a = (raw && typeof raw === 'object' ? raw : {}) as {
      repo?: unknown;
      pull_number?: unknown;
      comment_id?: unknown;
    };
    const repo = typeof a.repo === 'string' ? a.repo : '?';
    const pr = typeof a.pull_number === 'number' ? `#${a.pull_number}` : '#?';
    const action = typeof a.comment_id === 'number' ? 'edit comment' : 'comment';
    return `${action} on ${repo}${pr}`;
  },
  invoke: async (raw, _ctx, signal) => {
    const args = parseArgs(raw);

    const token = process.env.GITHUB_TOKEN;
    if (!token || token.length === 0) {
      throw new Error('GITHUB_TOKEN is not set in the bot environment');
    }

    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    };

    let url: string;
    let method: string;
    if (args.comment_id !== undefined) {
      url = `https://api.github.com/repos/${args.repo}/issues/comments/${args.comment_id}`;
      method = 'PATCH';
    } else {
      url = `https://api.github.com/repos/${args.repo}/issues/${args.pull_number}/comments`;
      method = 'POST';
    }

    const res = await fetch(url, {
      method,
      headers,
      body: JSON.stringify({ body: args.body }),
      signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`GitHub ${method} ${url} HTTP ${res.status}: ${text}`);
    }
    const comment = JSON.parse(text) as { html_url?: string; id?: number };
    if (!comment.html_url || !comment.id) {
      throw new Error(`GitHub returned incomplete response: ${text}`);
    }
    return JSON.stringify({ url: comment.html_url, id: comment.id });
  },
};

export const _internal = { parseArgs };
