// Per-session git smart-HTTP server. The bot owns one of these per active
// session and binds it to 127.0.0.1 on a random port — the WS tunnel
// (ws-tunnel.ts) routes the sandbox's TCP connections into this server.
//
// Each request spawns `git http-backend` as a CGI subprocess. We set
// `core.hooksPath` via `GIT_CONFIG_*` env vars so the agenta pre-receive
// policy (refs/heads/agenta/sessions/<thread_key> only, fast-forward only)
// runs without writing into the customer repo's hook tree.
//
// Loopback-only — no external auth layer; sandbox-side reachability is
// gated by the WS Bearer auth on the tunnel.

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { basename, dirname } from 'node:path';
import { log } from '../../shared/log';

export type StartGitServerOpts = {
  // Absolute path to a non-bare git working tree on the bot host. The
  // server exports ONLY this repo: any URL that doesn't match
  // `/<basename>.git/...` is rejected with 404.
  repoPath: string;
  // The single ref a push is allowed to update. Forwarded to the
  // pre-receive hook via AGENTA_ALLOWED_REF.
  allowedRef: string;
  // Directory containing the agenta pre-receive script. Wired into
  // git-http-backend via core.hooksPath.
  hooksDir: string;
};

export type GitServerHandle = {
  port: number;
  stop: () => Promise<void>;
};

// git-http-backend speaks CGI: stdout is "status?\nheaders\n\nbody". We
// parse it into a Bun-compatible Response.
function parseCgi(stdout: Buffer): { status: number; headers: Headers; body: Buffer } {
  // Find the blank line separating headers from body. \r\n\r\n is what
  // git emits; tolerate plain \n\n too.
  let sep = stdout.indexOf('\r\n\r\n');
  let sepLen = 4;
  if (sep === -1) {
    sep = stdout.indexOf('\n\n');
    sepLen = 2;
  }
  if (sep === -1) {
    return { status: 200, headers: new Headers(), body: stdout };
  }
  const head = stdout.subarray(0, sep).toString('utf8');
  const body = stdout.subarray(sep + sepLen);
  let status = 200;
  const headers = new Headers();
  for (const line of head.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === 'status') {
      const m = /^(\d+)/.exec(value);
      if (m) status = Number(m[1]);
      continue;
    }
    headers.append(name, value);
  }
  return { status, headers, body };
}

// Drain stdout/stderr of a spawned process into Buffers and resolve on
// close.
function collect(
  child: ChildProcessWithoutNullStreams,
  stdin: Buffer | undefined,
): Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }> {
  return new Promise((resolve, reject) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err),
      });
    });
    if (stdin && stdin.length > 0) child.stdin.write(stdin);
    child.stdin.end();
  });
}

export async function startGitServer(opts: StartGitServerOpts): Promise<GitServerHandle> {
  const projectRoot = dirname(opts.repoPath);
  const repoName = basename(opts.repoPath);
  // The sandbox-side remote URL is `http://localhost:6000/<repo>.git`, but
  // git-http-backend wants PATH_INFO that resolves to a directory under
  // GIT_PROJECT_ROOT. For a non-bare repo at `<projectRoot>/<repoName>`
  // that means PATH_INFO must NOT carry the `.git` suffix (otherwise
  // http-backend looks up `<repoName>.git/.git` and 404s). We accept both
  // `/<repo>.git/<endpoint>` and `/<repo>/<endpoint>` from the client and
  // rewrite to the suffix-less form before spawning.
  const PATH_RE = new RegExp(
    `^/${escapeRegex(repoName)}(?:\\.git)?/(info/refs|git-upload-pack|git-receive-pack)$`,
  );

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req): Promise<Response> {
      let url: URL;
      try {
        url = new URL(req.url);
      } catch {
        return new Response('bad request', { status: 400 });
      }
      try {
        if (req.method !== 'GET' && req.method !== 'POST') {
          return new Response('method not allowed', { status: 405 });
        }
        if (!PATH_RE.test(url.pathname)) {
          return new Response('not found', { status: 404 });
        }
        // Per-request CGI invocation. http-backend handles upload-pack /
        // receive-pack dispatch based on PATH_INFO + QUERY_STRING.
        // Strip a `.git` suffix from the leading segment so http-backend
        // resolves the non-bare repo at `<projectRoot>/<repoName>`.
        const pathInfo = url.pathname.replace(
          new RegExp(`^/${escapeRegex(repoName)}\\.git/`),
          `/${repoName}/`,
        );
        const env: Record<string, string> = {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          GIT_PROJECT_ROOT: projectRoot,
          GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: pathInfo,
          REQUEST_METHOD: req.method,
          QUERY_STRING: url.search.startsWith('?') ? url.search.slice(1) : url.search,
          // Pin core.hooksPath via GIT_CONFIG_* so the agenta pre-receive
          // policy runs without touching the customer repo's hook tree.
          // Also force http.receivepack on so non-bare repos accept
          // pushes (the default for non-bare is to refuse; we don't want
          // every customer repo to need this in its own config).
          GIT_CONFIG_COUNT: '2',
          GIT_CONFIG_KEY_0: 'core.hooksPath',
          GIT_CONFIG_VALUE_0: opts.hooksDir,
          GIT_CONFIG_KEY_1: 'http.receivepack',
          GIT_CONFIG_VALUE_1: 'true',
          AGENTA_ALLOWED_REF: opts.allowedRef,
        };
        if (req.method === 'POST') {
          const ct = req.headers.get('content-type');
          if (ct) env.CONTENT_TYPE = ct;
          const cl = req.headers.get('content-length');
          if (cl) env.CONTENT_LENGTH = cl;
        }
        const child = spawn('git', ['http-backend'], {
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const stdin = req.method === 'POST' ? Buffer.from(await req.arrayBuffer()) : undefined;
        const result = await collect(child, stdin);
        if (result.exitCode !== 0) {
          log.warn(
            'git-server',
            `git http-backend exit ${result.exitCode}: ${result.stderr.toString('utf8')}`,
          );
          return new Response(result.stderr, { status: 500 });
        }
        const { status, headers, body } = parseCgi(result.stdout);
        return new Response(body, { status, headers });
      } catch (err) {
        log.warn('git-server', `handler error: ${(err as Error).message}`);
        return new Response((err as Error).message, { status: 500 });
      }
    },
    error(err) {
      log.error('git-server', `request handler error: ${(err as Error).message}`);
      return new Response('Internal Server Error', { status: 500 });
    },
  });

  return {
    port: server.port,
    async stop() {
      await server.stop();
    },
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
