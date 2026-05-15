// WS tunnel client tests. We stand up:
//   - a fake sandbox-side WS server (Bun.serve with the same frame format),
//   - a fake "local git server" (a plain TCP echo listener on 127.0.0.1),
// and verify the client connects, multiplexes a stream from the fake
// sandbox into the local TCP server, and round-trips bytes.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server as NetServer } from 'node:net';
import { _resetForTests, startTunnel, stopTunnel } from './ws-tunnel';

const FRAME_HEADER = 5;
const TYPE_DATA = 0;
const TYPE_CLOSE = 1;
const FAKE_TOKEN = 'fake-token';

function encodeFrame(streamId: number, type: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, streamId >>> 0, false);
  out[4] = type;
  if (payload.length > 0) out.set(payload, FRAME_HEADER);
  return out;
}

type SandboxServer = {
  port: number;
  // Set on first ws open.
  ws?: import('bun').ServerWebSocket<unknown>;
  // Buffer of frames received from the client.
  inbound: Uint8Array[];
  authChecked: boolean;
  stop: () => Promise<void>;
};

function startFakeSandbox(): SandboxServer {
  const inbound: Uint8Array[] = [];
  const state: SandboxServer = {
    port: 0,
    inbound,
    authChecked: false,
    stop: async () => {},
  };
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv): Response | undefined {
      const url = new URL(req.url);
      if (url.pathname !== '/tunnel') return new Response('nope', { status: 404 });
      const auth = req.headers.get('authorization');
      state.authChecked = auth === `Bearer ${FAKE_TOKEN}`;
      if (!state.authChecked) return new Response('unauth', { status: 401 });
      if (srv.upgrade(req)) return undefined;
      return new Response('upgrade-fail', { status: 400 });
    },
    websocket: {
      open(ws) {
        state.ws = ws;
      },
      message(_ws, message) {
        if (typeof message === 'string') return;
        inbound.push(new Uint8Array(Buffer.from(message)));
      },
      close() {
        state.ws = undefined;
      },
    },
  });
  state.port = server.port;
  state.stop = async () => {
    // Force-close active sockets — Bun.serve.stop() defaults to a graceful
    // drain that hangs forever if the test left an upgraded WS in the
    // accepted state (Bun bug observed locally).
    await server.stop(true);
  };
  return state;
}

function startEchoTcp(): Promise<{ port: number; stop: () => Promise<void>; server: NetServer }> {
  const server = createServer((sock) => {
    sock.on('data', (chunk) => {
      // Echo with a prefix so we can tell the local server actually
      // touched the bytes (vs. being looped back at the WS layer).
      sock.write(Buffer.concat([Buffer.from('echo:'), chunk]));
    });
  });
  return new Promise<{ port: number; stop: () => Promise<void>; server: NetServer }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        server,
        stop: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

let sandbox: SandboxServer;
let echo: { port: number; stop: () => Promise<void>; server: NetServer };

beforeEach(async () => {
  _resetForTests();
  sandbox = startFakeSandbox();
  echo = await startEchoTcp();
});

afterEach(async () => {
  _resetForTests();
  await sandbox.stop();
  await echo.stop();
});

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v !== undefined && v !== null && v !== false) return v as T;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitFor timed out');
}

describe('startTunnel', () => {
  test('connects to /tunnel with Bearer auth and is idempotent per threadKey', async () => {
    const handle1 = await startTunnel({
      threadKey: 'tk-1',
      sandboxBaseUrl: `http://127.0.0.1:${sandbox.port}`,
      sandboxToken: FAKE_TOKEN,
      localTargetPort: echo.port,
    });
    expect(sandbox.authChecked).toBe(true);
    await waitFor(() => sandbox.ws);

    const handle2 = await startTunnel({
      threadKey: 'tk-1',
      sandboxBaseUrl: `http://127.0.0.1:${sandbox.port}`,
      sandboxToken: FAKE_TOKEN,
      localTargetPort: echo.port,
    });
    expect(handle1).toBe(handle2);

    await stopTunnel('tk-1');
  });

  test('forwards bytes both directions: sandbox-side data frame → local TCP → echo back through WS', async () => {
    await startTunnel({
      threadKey: 'tk-fwd',
      sandboxBaseUrl: `http://127.0.0.1:${sandbox.port}`,
      sandboxToken: FAKE_TOKEN,
      localTargetPort: echo.port,
    });
    const ws = await waitFor(() => sandbox.ws);

    // The "sandbox" sends a data frame with a fresh streamId. The bot
    // should open a TCP socket to the echo server, write the payload,
    // and the echo response should come back as data frames.
    const STREAM = 7;
    ws.sendBinary(encodeFrame(STREAM, TYPE_DATA, new TextEncoder().encode('hello')));

    // Wait for at least one frame back.
    const frame = await waitFor(() => sandbox.inbound[0]);
    expect(frame[4]).toBe(TYPE_DATA);
    const id = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, false);
    expect(id).toBe(STREAM);
    const text = new TextDecoder().decode(frame.subarray(FRAME_HEADER));
    expect(text).toContain('echo:hello');

    await stopTunnel('tk-fwd');
  });

  test('sandbox-side CLOSE frame tears down the corresponding local socket', async () => {
    await startTunnel({
      threadKey: 'tk-close',
      sandboxBaseUrl: `http://127.0.0.1:${sandbox.port}`,
      sandboxToken: FAKE_TOKEN,
      localTargetPort: echo.port,
    });
    const ws = await waitFor(() => sandbox.ws);

    ws.sendBinary(encodeFrame(11, TYPE_DATA, new TextEncoder().encode('x')));
    await waitFor(() => sandbox.inbound.length > 0);
    sandbox.inbound.length = 0;
    ws.sendBinary(encodeFrame(11, TYPE_CLOSE, new Uint8Array(0)));
    // No throw, no further frames echoed back for this streamId.
    await new Promise((r) => setTimeout(r, 50));
    for (const frame of sandbox.inbound) {
      const id = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, false);
      expect(id).not.toBe(11);
    }

    await stopTunnel('tk-close');
  });

  test('stop closes the WS and removes the handle', async () => {
    await startTunnel({
      threadKey: 'tk-stop',
      sandboxBaseUrl: `http://127.0.0.1:${sandbox.port}`,
      sandboxToken: FAKE_TOKEN,
      localTargetPort: echo.port,
    });
    await waitFor(() => sandbox.ws);
    await stopTunnel('tk-stop');
    await waitFor(() => sandbox.ws === undefined);
    expect(sandbox.ws).toBeUndefined();
  });
});
