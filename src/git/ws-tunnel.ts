// Per-session WebSocket tunnel client.
//
// The bot opens a WS to the sandbox's /tunnel endpoint (the only
// sandbox-reachable direction in the docker/fly architecture). The
// sandbox-side binds 127.0.0.1:6000 inside the container and frames every
// accepted TCP connection across the WS. This module demultiplexes those
// frames back into TCP sockets to the bot's per-session git HTTP server on
// loopback.
//
// Wire format: 5-byte header = `streamId: u32 BE | type: u8`, then payload.
//   type 0 = data, type 1 = close.
// The first data frame with a new streamId implicitly opens the stream.

import { connect as netConnect, type Socket as TcpSocket } from 'node:net';
import { log } from '../log';

export type StartTunnelOpts = {
  threadKey: string;
  // Base URL of the sandbox HTTP API (http://...). The WS upgrade is
  // requested at <base>/tunnel; ws:// is derived by swapping the scheme.
  sandboxBaseUrl: string;
  // Headers needed to reach the sandbox HTTP API — same set returned by
  // the active provider's getEndpoint(). On Fly this includes both the
  // Authorization Bearer header and `fly-force-instance-id` for routing
  // to the specific machine. On Docker it's just Authorization.
  sandboxHeaders: Record<string, string>;
  // Loopback port the bot's git HTTP server is listening on. Every WS
  // stream maps to a fresh TCP connection here.
  localTargetPort: number;
};

export type TunnelHandle = {
  stop: () => Promise<void>;
};

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

function toWsUrl(base: string): string {
  const u = new URL('/tunnel', base);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}

const tunnels = new Map<string, TunnelHandle>();

export function getTunnelHandle(threadKey: string): TunnelHandle | undefined {
  return tunnels.get(threadKey);
}

export async function startTunnel(opts: StartTunnelOpts): Promise<TunnelHandle> {
  const existing = tunnels.get(opts.threadKey);
  if (existing) return existing;

  // Per-thread state. Survives reconnect attempts; cleared on stop().
  const streams = new Map<number, TcpSocket>();
  let ws: WebSocket | undefined;
  let stopped = false;
  let reconnectMs = 250;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  // Resolves on first successful WS open so callers can await readiness.
  let readyResolve: (() => void) | undefined;
  let readyReject: ((err: Error) => void) | undefined;
  const ready = new Promise<void>((res, rej) => {
    readyResolve = res;
    readyReject = rej;
  });
  let everOpened = false;

  const cleanupStreams = (): void => {
    for (const sock of streams.values()) sock.destroy();
    streams.clear();
  };

  const onWsClose = (): void => {
    cleanupStreams();
    if (stopped) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, reconnectMs);
    reconnectMs = Math.min(reconnectMs * 2, 5000);
  };

  function openLocalSocket(streamId: number, initialChunk: Uint8Array): void {
    const sock = netConnect({ host: '127.0.0.1', port: opts.localTargetPort });
    streams.set(streamId, sock);
    sock.on('connect', () => {
      if (initialChunk.length > 0) sock.write(Buffer.from(initialChunk));
    });
    sock.on('data', (chunk: Buffer) => {
      try {
        ws?.send(encodeFrame(streamId, TYPE_DATA, new Uint8Array(chunk)));
      } catch {
        sock.destroy();
      }
    });
    sock.on('error', (err) => {
      log.warn('ws-tunnel', `[${opts.threadKey}] local socket error: ${err.message}`);
      streams.delete(streamId);
      try {
        ws?.send(encodeFrame(streamId, TYPE_CLOSE, new Uint8Array(0)));
      } catch {
        // WS may be down.
      }
    });
    sock.on('close', () => {
      if (streams.delete(streamId)) {
        try {
          ws?.send(encodeFrame(streamId, TYPE_CLOSE, new Uint8Array(0)));
        } catch {
          // WS may be down.
        }
      }
    });
  }

  function handleMessage(buf: Uint8Array): void {
    if (buf.length < FRAME_HEADER) return;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const streamId = view.getUint32(0, false);
    const type = buf[4];
    if (type === TYPE_CLOSE) {
      const sock = streams.get(streamId);
      if (sock) {
        streams.delete(streamId);
        sock.destroy();
      }
      return;
    }
    if (type !== TYPE_DATA) return;
    const payload = buf.subarray(FRAME_HEADER);
    const sock = streams.get(streamId);
    if (sock) {
      sock.write(Buffer.from(payload));
      return;
    }
    // First time we see this streamId: open a TCP socket to the local git
    // server and write the initial payload.
    openLocalSocket(streamId, payload);
  }

  function connect(): void {
    if (stopped) return;
    const url = toWsUrl(opts.sandboxBaseUrl);
    try {
      ws = new WebSocket(url, {
        headers: opts.sandboxHeaders,
      } as unknown as undefined);
    } catch (err) {
      log.warn('ws-tunnel', `[${opts.threadKey}] WS construct failed: ${(err as Error).message}`);
      onWsClose();
      return;
    }
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', () => {
      reconnectMs = 250;
      everOpened = true;
      log.info('ws-tunnel', `[${opts.threadKey}] connected to ${url}`);
      readyResolve?.();
    });
    ws.addEventListener('message', (ev) => {
      // Bun's WS delivers binary frames as ArrayBuffer when binaryType is
      // set above. String frames are unexpected and dropped.
      if (typeof ev.data === 'string') return;
      handleMessage(new Uint8Array(ev.data as ArrayBuffer));
    });
    ws.addEventListener('close', () => {
      log.info('ws-tunnel', `[${opts.threadKey}] WS closed`);
      onWsClose();
      if (!everOpened) {
        // Surface the failure to the first-call awaiter so callers don't
        // block forever on a tunnel that never came up.
        readyReject?.(new Error(`tunnel to ${url} closed before open`));
      }
    });
    ws.addEventListener('error', (ev) => {
      const msg = (ev as unknown as { message?: string }).message ?? 'ws error';
      log.warn('ws-tunnel', `[${opts.threadKey}] WS error: ${msg}`);
    });
  }

  connect();
  // Wait up to 5s for the first open before returning. Reconnect loop
  // keeps trying in the background after that.
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    ready,
    new Promise<void>((_resolve, reject) => {
      openTimer = setTimeout(
        () => reject(new Error(`tunnel to ${opts.sandboxBaseUrl} did not open within 5s`)),
        5000,
      );
    }),
  ])
    .catch((err) => {
      if (!everOpened) throw err;
    })
    .finally(() => {
      if (openTimer !== undefined) clearTimeout(openTimer);
    });

  const handle: TunnelHandle = {
    async stop() {
      stopped = true;
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      cleanupStreams();
      try {
        ws?.close();
      } catch {
        // Already closed.
      }
      tunnels.delete(opts.threadKey);
    },
  };
  tunnels.set(opts.threadKey, handle);
  return handle;
}

export async function stopTunnel(threadKey: string): Promise<void> {
  const handle = tunnels.get(threadKey);
  if (!handle) return;
  await handle.stop();
}

export async function stopAllTunnels(): Promise<void> {
  const keys = [...tunnels.keys()];
  await Promise.all(keys.map((k) => stopTunnel(k)));
}

// For tests.
export function _resetForTests(): void {
  for (const h of tunnels.values()) void h.stop();
  tunnels.clear();
}
