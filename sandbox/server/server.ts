// In-container HTTP API for the agenta sandbox.
//
// All bot↔sandbox communication goes through this server so the bot can
// eventually talk to a sandbox on a remote machine. Endpoints — all require
// `Authorization: Bearer $SANDBOX_TOKEN`:
//
//   POST /exec         { command }                      -> SSE stream
//   POST /read         { path, offset?, limit? }        -> JSON DockerResult
//   POST /read_binary  { path }                         -> JSON DockerResult (stdout = base64)
//   POST /write        { path, content }                -> JSON DockerResult
//   POST /write_binary { path, content_b64 }            -> JSON DockerResult
//   POST /edit         { path, old_string, new_string } -> JSON DockerResult
//   GET  /tunnel       (WebSocket upgrade)              -> stream-multiplex TCP
//                                                          loopback:6000 over
//                                                          binary WS frames
//   GET  /health                                        -> 200 "ok"
//
// On /exec disconnect, the spawned child is SIGTERM'd. uncaughtException is
// caught so a per-request bug doesn't kill the whole process (which would
// trigger Docker Desktop's auto-restart with a fresh host port).

import { spawn } from 'node:child_process';
import { readFile as fsReadFile, writeFile as fsWriteFile, mkdir } from 'node:fs/promises';
import { createServer, type Server as NetServer, type Socket as TcpSocket } from 'node:net';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { ServerWebSocket } from 'bun';

const PORT = Number(process.env.SANDBOX_PORT ?? 9000);
const TOKEN = process.env.SANDBOX_TOKEN;
// Workspace directory: defaults to the sandbox user's home dir (which is
// also the per-thread persistent volume mount for docker/fly providers).
// The ECS provider (#218) overrides via SANDBOX_WORKSPACE_DIR=/efs/<slug>
// so a single shared EFS root + per-thread subdirectory replaces the
// per-thread access points that #213 originally tried to use.
// entrypoint.sh mkdir+chowns the directory before exec'ing the server.
const WORKSPACE = process.env.SANDBOX_WORKSPACE_DIR ?? '/home/sandbox';
// Hard cap on /exec runtime. Long-hanging commands (e.g. `curl` to a blocked
// host waiting on TCP timeout) would otherwise block the model's turn
// indefinitely. The model sees a clean error in stderr and can adjust.
const EXEC_TIMEOUT_MS = Number(process.env.SANDBOX_EXEC_TIMEOUT_MS ?? 60_000);

// Loopback port the /tunnel WS multiplexer binds to inside the sandbox. Git
// inside the sandbox dials http://localhost:6000/<repo>.git — every TCP
// accept is multiplexed across the WS as a new stream so the bot's local
// git HTTP server (on the Mac) serves the request.
const TUNNEL_TCP_PORT = 6000;

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

      // Timeout: send a clear stderr marker, SIGTERM, escalate to SIGKILL.
      const timeoutTimer = setTimeout(() => {
        send('stderr', { chunk: `\n[command timed out after ${EXEC_TIMEOUT_MS}ms]\n` });
        child.kill('SIGTERM');
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // already dead
          }
        }, 2000);
      }, EXEC_TIMEOUT_MS);

      child.on('close', () => {
        clearTimeout(timeoutTimer);
        req.signal.removeEventListener('abort', onAbort);
      });
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

async function handleReadBinary(req: Request): Promise<Response> {
  const body = (await req.json()) as { path?: unknown };
  if (typeof body.path !== 'string' || body.path.length === 0) {
    return new Response('missing path', { status: 400 });
  }
  const full = resolveWorkspacePath(body.path);
  try {
    const buf = await fsReadFile(full);
    return Response.json({ exitCode: 0, stdout: buf.toString('base64'), stderr: '' });
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

async function handleWriteBinary(req: Request): Promise<Response> {
  const body = (await req.json()) as { path?: unknown; content_b64?: unknown };
  if (typeof body.path !== 'string' || body.path.length === 0) {
    return new Response('missing path', { status: 400 });
  }
  if (typeof body.content_b64 !== 'string') {
    return new Response('missing content_b64', { status: 400 });
  }
  const full = resolveWorkspacePath(body.path);
  try {
    const buf = Buffer.from(body.content_b64, 'base64');
    await mkdir(dirname(full), { recursive: true });
    await fsWriteFile(full, buf);
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

// Tunnel state, per active WS connection. The map is keyed on the
// ServerWebSocket itself so we can find the per-connection state from any of
// Bun's WS callbacks. One TCP listener per WS; each accepted TCP connection
// becomes one multiplexed stream identified by a u32 streamId.
type TunnelData = {
  server: NetServer;
  streams: Map<number, TcpSocket>;
  nextStreamId: number;
};
const tunnels = new WeakMap<ServerWebSocket<unknown>, TunnelData>();

// Wire format. 5-byte header:
//   bytes 0..3   streamId (u32 BE)
//   byte  4      type (0 = data, 1 = close)
// Sending data with a fresh streamId implicitly opens a stream — both ends
// allocate a TCP socket on first sight. Close signals end-of-stream from
// either side.
const FRAME_HEADER = 5;
const TYPE_DATA = 0;
const TYPE_CLOSE = 1;

function encodeFrame(streamId: number, type: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, streamId >>> 0, false);
  out[4] = type;
  if (payload.length > 0) out.set(payload, FRAME_HEADER);
  return out;
}

function sendClose(ws: ServerWebSocket<unknown>, streamId: number): void {
  try {
    ws.sendBinary(encodeFrame(streamId, TYPE_CLOSE, new Uint8Array(0)));
  } catch {
    // WS may already be closed.
  }
}

// Start the per-WS TCP listener and wire each accept() up to a fresh streamId
// that frames bytes back through the WS.
function startTunnelListener(ws: ServerWebSocket<unknown>): TunnelData {
  const streams = new Map<number, TcpSocket>();
  const data: TunnelData = { server: createServer(), streams, nextStreamId: 1 };
  data.server.on('connection', (sock) => {
    const id = data.nextStreamId++;
    streams.set(id, sock);
    sock.on('data', (chunk: Buffer) => {
      try {
        ws.sendBinary(encodeFrame(id, TYPE_DATA, new Uint8Array(chunk)));
      } catch {
        sock.destroy();
      }
    });
    sock.on('error', () => {
      streams.delete(id);
      sendClose(ws, id);
    });
    sock.on('close', () => {
      if (streams.delete(id)) sendClose(ws, id);
    });
  });
  data.server.on('error', (err) => {
    console.error('tunnel: listener error:', err);
  });
  // 127.0.0.1 only — the WS auth (Bearer) is the only thing gating access;
  // we don't want this port reachable from outside the sandbox.
  data.server.listen(TUNNEL_TCP_PORT, '127.0.0.1');
  return data;
}

function closeTunnel(ws: ServerWebSocket<unknown>): void {
  const data = tunnels.get(ws);
  if (!data) return;
  tunnels.delete(ws);
  for (const sock of data.streams.values()) {
    sock.destroy();
  }
  data.streams.clear();
  data.server.close();
}

Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  async fetch(req, server): Promise<Response | undefined> {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return new Response('bad request', { status: 400 });
    }
    try {
      if (url.pathname === '/health') return new Response('ok');
      if (!authorized(req)) return new Response('unauthorized', { status: 401 });
      if (url.pathname === '/tunnel') {
        // Bun upgrades the request to a WebSocket and routes subsequent
        // events to the `websocket` handlers below. Return undefined when
        // upgrade succeeds; Bun handles the rest.
        if (server.upgrade(req)) return undefined;
        return new Response('upgrade failed', { status: 400 });
      }
      if (req.method !== 'POST') return new Response('not found', { status: 404 });
      switch (url.pathname) {
        case '/exec':
          return handleExec(req);
        case '/read':
          return handleRead(req);
        case '/read_binary':
          return handleReadBinary(req);
        case '/write':
          return handleWrite(req);
        case '/write_binary':
          return handleWriteBinary(req);
        case '/edit':
          return handleEdit(req);
        default:
          return new Response('not found', { status: 404 });
      }
    } catch (err) {
      console.error('handler error:', err);
      return new Response((err as Error).message ?? 'internal error', { status: 500 });
    }
  },
  error(err) {
    console.error('request handler error:', err);
    return new Response('Internal Server Error', { status: 500 });
  },
  websocket: {
    open(ws) {
      try {
        const data = startTunnelListener(ws);
        tunnels.set(ws, data);
        console.log(`tunnel: bound 127.0.0.1:${TUNNEL_TCP_PORT}`);
      } catch (err) {
        console.error('tunnel open failed:', err);
        ws.close(1011, 'tunnel-init-failed');
      }
    },
    message(ws, message) {
      const data = tunnels.get(ws);
      if (!data) return;
      // Bun delivers binary messages as Buffer. Defensive: stringify-mode
      // clients would land here as string — ignore.
      if (typeof message === 'string') return;
      const buf = Buffer.from(message);
      if (buf.length < FRAME_HEADER) return;
      const streamId = buf.readUInt32BE(0);
      const type = buf[4];
      if (type === TYPE_CLOSE) {
        const sock = data.streams.get(streamId);
        if (sock) {
          data.streams.delete(streamId);
          sock.destroy();
        }
        return;
      }
      if (type !== TYPE_DATA) {
        // Unknown type; drop the connection to surface protocol mismatch.
        console.error(`tunnel: unknown frame type ${type} from client; closing`);
        ws.close(1002, 'protocol-error');
        return;
      }
      // Every stream is sandbox-initiated (a TCP accept on port 6000 opens
      // it; the bot responds with data frames bound to the same streamId).
      // An unknown streamId from the bot is either late data after we
      // already closed the stream or a protocol bug — drop on the floor.
      const sock = data.streams.get(streamId);
      if (!sock) return;
      sock.write(buf.subarray(FRAME_HEADER));
    },
    close(ws) {
      closeTunnel(ws);
    },
  },
});

console.log(`sandbox-server listening on :${PORT}`);
