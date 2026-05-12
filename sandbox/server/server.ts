// In-container HTTP API for the agenta sandbox.
//
// All bot↔sandbox communication goes through this server so the bot can
// eventually talk to a sandbox on a remote machine. Endpoints — all require
// `Authorization: Bearer $SANDBOX_TOKEN`:
//
//   POST /exec   { command }                      -> SSE stream
//   POST /read   { path, offset?, limit? }        -> JSON DockerResult
//   POST /write  { path, content }                -> JSON DockerResult
//   POST /edit   { path, old_string, new_string } -> JSON DockerResult
//   POST /grep   { pattern, path?, glob? }        -> JSON DockerResult
//   POST /glob   { pattern, path? }               -> JSON DockerResult
//   POST /ls     { path? }                        -> JSON DockerResult
//   GET  /health                                  -> 200 "ok"
//
// On /exec disconnect, the spawned child is SIGTERM'd. uncaughtException is
// caught so a per-request bug doesn't kill the whole process (which would
// trigger Docker Desktop's auto-restart with a fresh host port).

import { spawn } from 'node:child_process';
import {
  mkdir,
  readFile as fsReadFile,
  readdir,
  stat,
  writeFile as fsWriteFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const PORT = Number(process.env.SANDBOX_PORT ?? 9000);
const TOKEN = process.env.SANDBOX_TOKEN;
const WORKSPACE = '/workspace';

if (!TOKEN || TOKEN.length < 16) {
  console.error('SANDBOX_TOKEN env var is required (min 16 chars)');
  process.exit(1);
}

process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection:', err);
});

function authorized(req: Request): boolean {
  return req.headers.get('authorization') === `Bearer ${TOKEN}`;
}

function resolveWorkspacePath(p: string): string {
  return isAbsolute(p) ? p : resolve(WORKSPACE, p);
}

type Result = { exitCode: number; stdout: string; stderr: string };

function ok(stdout = ''): Response {
  return Response.json({ exitCode: 0, stdout, stderr: '' } satisfies Result);
}

function fail(stderr: string, exitCode = 1): Response {
  return Response.json({ exitCode, stdout: '', stderr } satisfies Result);
}

async function handleExec(req: Request): Promise<Response> {
  const body = (await req.json()) as { command?: unknown };
  const command = body.command;
  if (typeof command !== 'string' || command.length === 0) {
    return new Response('missing command', { status: 400 });
  }

  const child = spawn('bash', ['-lc', command], {
    cwd: WORKSPACE,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      let closed = false;
      const send = (kind: string, payload: object): void => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ kind, ...payload })}\n\n`));
        } catch {
          closed = true;
        }
      };
      const finish = (): void => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      child.stdout?.on('data', (chunk: Buffer) =>
        send('stdout', { chunk: chunk.toString('utf8') }),
      );
      child.stderr?.on('data', (chunk: Buffer) =>
        send('stderr', { chunk: chunk.toString('utf8') }),
      );
      child.on('error', (err) => {
        send('exit', { exitCode: -1, error: err.message });
        finish();
      });
      child.on('close', (code) => {
        send('exit', { exitCode: code ?? -1 });
        finish();
      });

      const onAbort = (): void => {
        child.kill('SIGTERM');
      };
      req.signal.addEventListener('abort', onAbort);
      child.on('close', () => req.signal.removeEventListener('abort', onAbort));
    },
    cancel() {
      child.kill('SIGTERM');
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

async function handleRead(req: Request): Promise<Response> {
  const body = (await req.json()) as { path?: unknown; offset?: unknown; limit?: unknown };
  if (typeof body.path !== 'string' || body.path.length === 0) {
    return new Response('missing path', { status: 400 });
  }
  const offset = typeof body.offset === 'number' ? Math.max(1, Math.floor(body.offset)) : 1;
  const limit = typeof body.limit === 'number' ? Math.max(0, Math.floor(body.limit)) : undefined;
  const full = resolveWorkspacePath(body.path);
  try {
    const content = await fsReadFile(full, 'utf8');
    if (offset === 1 && limit === undefined) return ok(content);
    const lines = content.split('\n');
    const start = offset - 1;
    const end = limit === undefined ? lines.length : Math.min(lines.length, start + limit);
    return ok(lines.slice(start, end).join('\n'));
  } catch (err) {
    return fail((err as Error).message);
  }
}

async function handleWrite(req: Request): Promise<Response> {
  const body = (await req.json()) as { path?: unknown; content?: unknown };
  if (typeof body.path !== 'string' || body.path.length === 0) {
    return new Response('missing path', { status: 400 });
  }
  if (typeof body.content !== 'string') {
    return new Response('missing content', { status: 400 });
  }
  const full = resolveWorkspacePath(body.path);
  try {
    await mkdir(dirname(full), { recursive: true });
    await fsWriteFile(full, body.content, 'utf8');
    return ok();
  } catch (err) {
    return fail((err as Error).message);
  }
}

async function handleEdit(req: Request): Promise<Response> {
  const body = (await req.json()) as {
    path?: unknown;
    old_string?: unknown;
    new_string?: unknown;
  };
  if (typeof body.path !== 'string' || body.path.length === 0) {
    return new Response('missing path', { status: 400 });
  }
  if (typeof body.old_string !== 'string' || body.old_string.length === 0) {
    return new Response('missing old_string', { status: 400 });
  }
  if (typeof body.new_string !== 'string') {
    return new Response('missing new_string', { status: 400 });
  }
  const full = resolveWorkspacePath(body.path);
  let content: string;
  try {
    content = await fsReadFile(full, 'utf8');
  } catch (err) {
    return fail((err as Error).message);
  }
  // Count occurrences without overlapping; Claude Code's rule: exactly one.
  let occurrences = 0;
  let idx = content.indexOf(body.old_string);
  while (idx !== -1) {
    occurrences++;
    idx = content.indexOf(body.old_string, idx + body.old_string.length);
    if (occurrences > 1) break;
  }
  if (occurrences === 0) {
    return fail('old_string not found in file');
  }
  if (occurrences > 1) {
    return fail('old_string is not unique; provide more surrounding context');
  }
  const updated = content.replace(body.old_string, body.new_string);
  try {
    await fsWriteFile(full, updated, 'utf8');
  } catch (err) {
    return fail((err as Error).message);
  }
  return ok(`edited ${body.path}`);
}

function runRg(args: string[]): Promise<Result> {
  return new Promise((resolve, reject) => {
    const proc = spawn('rg', args, {
      cwd: WORKSPACE,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    proc.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
  });
}

async function handleGrep(req: Request): Promise<Response> {
  const body = (await req.json()) as { pattern?: unknown; path?: unknown; glob?: unknown };
  if (typeof body.pattern !== 'string' || body.pattern.length === 0) {
    return new Response('missing pattern', { status: 400 });
  }
  const args = ['--line-number', '--color=never', '--max-columns', '500'];
  if (typeof body.glob === 'string' && body.glob.length > 0) {
    args.push('-g', body.glob);
  }
  args.push('--', body.pattern);
  if (typeof body.path === 'string' && body.path.length > 0) {
    args.push(body.path);
  }
  const r = await runRg(args);
  if (r.exitCode === 1 && r.stderr.length === 0) return ok('');
  return Response.json(r satisfies Result);
}

async function handleGlob(req: Request): Promise<Response> {
  const body = (await req.json()) as { pattern?: unknown; path?: unknown };
  if (typeof body.pattern !== 'string' || body.pattern.length === 0) {
    return new Response('missing pattern', { status: 400 });
  }
  const args = ['--files', '--color=never', '-g', body.pattern];
  if (typeof body.path === 'string' && body.path.length > 0) {
    args.push('--', body.path);
  }
  const r = await runRg(args);
  if (r.exitCode === 1 && r.stderr.length === 0) return ok('');
  return Response.json(r satisfies Result);
}

async function handleLs(req: Request): Promise<Response> {
  const body = (await req.json()) as { path?: unknown };
  const target =
    typeof body.path === 'string' && body.path.length > 0
      ? resolveWorkspacePath(body.path)
      : WORKSPACE;
  try {
    const names = await readdir(target);
    names.sort();
    const lines: string[] = [];
    for (const name of names.slice(0, 500)) {
      const full = join(target, name);
      try {
        const s = await stat(full);
        if (s.isDirectory()) lines.push(`d  ${'-'.padStart(10)}  ${name}/`);
        else if (s.isFile()) lines.push(`f  ${String(s.size).padStart(10)}  ${name}`);
        else lines.push(`?  ${'-'.padStart(10)}  ${name}`);
      } catch {
        lines.push(`?  ${'-'.padStart(10)}  ${name}`);
      }
    }
    if (names.length > 500) lines.push(`… ${names.length - 500} more entries (truncated)`);
    return ok(lines.join('\n'));
  } catch (err) {
    return fail((err as Error).message);
  }
}

Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  async fetch(req): Promise<Response> {
    try {
      const url = new URL(req.url);
      if (url.pathname === '/health') return new Response('ok');
      if (!authorized(req)) return new Response('unauthorized', { status: 401 });
      if (req.method !== 'POST') return new Response('not found', { status: 404 });
      switch (url.pathname) {
        case '/exec':
          return handleExec(req);
        case '/read':
          return handleRead(req);
        case '/write':
          return handleWrite(req);
        case '/edit':
          return handleEdit(req);
        case '/grep':
          return handleGrep(req);
        case '/glob':
          return handleGlob(req);
        case '/ls':
          return handleLs(req);
        default:
          return new Response('not found', { status: 404 });
      }
    } catch (err) {
      console.error('handler error:', err);
      return new Response((err as Error).message ?? 'internal error', { status: 500 });
    }
  },
});

console.log(`sandbox-server listening on :${PORT}`);
