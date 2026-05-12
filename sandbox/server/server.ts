// In-container HTTP API for the agenta sandbox.
//
// All bot↔sandbox communication goes through this server so the bot can
// eventually talk to a sandbox on a remote machine. Three endpoints, all
// require `Authorization: Bearer $SANDBOX_TOKEN`:
//
//   POST /exec   { command }          -> SSE stream of stdout/stderr/exit
//   POST /read   { path }             -> JSON { exitCode, stdout, stderr }
//   POST /write  { path, content }    -> JSON { exitCode, stderr }
//   GET  /health                      -> 200 "ok"
//
// On request disconnect (`request.signal` aborts), the spawned child is
// killed with SIGTERM so cancellation propagates from the bot.

import { spawn } from 'node:child_process';
import { readFile as fsReadFile, writeFile as fsWriteFile, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

const PORT = Number(process.env.SANDBOX_PORT ?? 9000);
const TOKEN = process.env.SANDBOX_TOKEN;
const WORKSPACE = '/workspace';

if (!TOKEN || TOKEN.length < 16) {
  console.error('SANDBOX_TOKEN env var is required (min 16 chars)');
  process.exit(1);
}

// Don't let any per-request bug take down the whole server (Docker would
// auto-restart it on a new host port, breaking the bot's cached endpoint).
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
  const body = (await req.json()) as { path?: unknown };
  if (typeof body.path !== 'string' || body.path.length === 0) {
    return new Response('missing path', { status: 400 });
  }
  const full = resolveWorkspacePath(body.path);
  try {
    const content = await fsReadFile(full, 'utf8');
    return Response.json({ exitCode: 0, stdout: content, stderr: '' });
  } catch (err) {
    return Response.json({ exitCode: 1, stdout: '', stderr: (err as Error).message });
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
    return Response.json({ exitCode: 0, stdout: '', stderr: '' });
  } catch (err) {
    return Response.json({ exitCode: 1, stdout: '', stderr: (err as Error).message });
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
      if (url.pathname === '/exec' && req.method === 'POST') return handleExec(req);
      if (url.pathname === '/read' && req.method === 'POST') return handleRead(req);
      if (url.pathname === '/write' && req.method === 'POST') return handleWrite(req);
      return new Response('not found', { status: 404 });
    } catch (err) {
      console.error('handler error:', err);
      return new Response((err as Error).message ?? 'internal error', { status: 500 });
    }
  },
});

console.log(`sandbox-server listening on :${PORT}`);
