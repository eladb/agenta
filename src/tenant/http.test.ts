// HTTP entrypoint tests (#253).
//
// These exercise the wire-protocol surface — bearer auth, envelope validation,
// SSE shape, /health gating — without booting the full handler pipeline.
// We can't easily stub `new WebClient(xoxb)` from inside http.ts, so the
// event_callback dispatch path is tested via the "valid envelope, no xoxb-
// backed Slack" surface: the envelope reaches dispatch, auth.test fails (no
// network), the SSE stream emits an `error`. That confirms the boundary
// without requiring a live Slack.

import { describe, expect, test } from 'bun:test';
import { connect } from 'node:net';
import { startHttp } from './http';

const SECRET = 'test-secret';

function startServer(opts?: { ready?: boolean }) {
  const readyRef = { value: opts?.ready ?? true };
  const server = startHttp({
    // Port 0 → kernel-assigned; avoids collisions across parallel tests.
    port: 0,
    hostname: '127.0.0.1',
    tenantSecret: SECRET,
    fallbackModel: { name: 'm' },
    readyRef,
  });
  return {
    base: `http://127.0.0.1:${server.port}`,
    port: server.port,
    readyRef,
    stop: () => server.stop(),
  };
}

// Send a raw request line over a TCP socket (the standard fetch client
// normalizes URLs, so it can't reproduce the authority-form `req.url` a
// CONNECT / port-scan probe sends). Returns the first response line.
function sendRawRequest(port: number, requestLine: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', () => {
      sock.write(`${requestLine}\r\nHost: 127.0.0.1\r\n\r\n`);
    });
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      if (buf.includes('\r\n')) {
        sock.destroy();
        resolve(buf.split('\r\n')[0] ?? '');
      }
    });
    sock.on('error', reject);
    sock.setTimeout(5000, () => {
      sock.destroy();
      reject(new Error('timeout'));
    });
  });
}

// Read an SSE stream until it closes; return the list of event names seen.
async function readSseEvents(res: Response): Promise<string[]> {
  if (!res.body) throw new Error('no body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events: string[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    while (true) {
      const sep = buf.indexOf('\n\n');
      if (sep === -1) break;
      const message = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      for (const line of message.split('\n')) {
        if (line.startsWith('event:')) {
          const name = line.slice('event:'.length).trim();
          events.push(name);
          // We're done once any terminal marker arrives.
          if (name === 'done' || name === 'error') {
            reader.releaseLock();
            return events;
          }
        }
      }
    }
  }
  return events;
}

describe('GET /health', () => {
  test('200 when readyRef.value is true', async () => {
    const { base, stop } = startServer({ ready: true });
    try {
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; ready: boolean };
      expect(body.ok).toBe(true);
      expect(body.ready).toBe(true);
    } finally {
      stop();
    }
  });

  test('503 while still booting', async () => {
    const { base, stop } = startServer({ ready: false });
    try {
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(503);
    } finally {
      stop();
    }
  });
});

describe('POST /events bearer auth', () => {
  test('rejects missing Authorization header', async () => {
    const { base, stop } = startServer();
    try {
      const res = await fetch(`${base}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(401);
    } finally {
      stop();
    }
  });

  test('rejects wrong secret', async () => {
    const { base, stop } = startServer();
    try {
      const res = await fetch(`${base}/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer wrong-secret',
        },
        body: '{}',
      });
      expect(res.status).toBe(401);
    } finally {
      stop();
    }
  });

  test('rejects same-prefix-but-shorter secret (constant-time guard)', async () => {
    const { base, stop } = startServer();
    try {
      const res = await fetch(`${base}/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SECRET.slice(0, 4)}`,
        },
        body: '{}',
      });
      expect(res.status).toBe(401);
    } finally {
      stop();
    }
  });
});

describe('POST /events envelope validation', () => {
  test('400 on malformed JSON', async () => {
    const { base, stop } = startServer();
    try {
      const res = await fetch(`${base}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
        body: 'not json',
      });
      expect(res.status).toBe(400);
    } finally {
      stop();
    }
  });

  test('400 on missing envelope_id', async () => {
    const { base, stop } = startServer();
    try {
      const res = await fetch(`${base}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
        body: JSON.stringify({
          type: 'event_callback',
          workspace_id: 'T1',
          xoxb: 'xoxb-x',
          home: { remote: 'file:///tmp' },
          payload: {},
        }),
      });
      expect(res.status).toBe(400);
    } finally {
      stop();
    }
  });

  test('400 on unsupported envelope.type', async () => {
    const { base, stop } = startServer();
    try {
      const res = await fetch(`${base}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
        body: JSON.stringify({
          envelope_id: 'E1',
          type: 'slash_command',
          workspace_id: 'T1',
          xoxb: 'xoxb-x',
          home: { remote: 'file:///tmp' },
          payload: {},
        }),
      });
      expect(res.status).toBe(400);
    } finally {
      stop();
    }
  });

  test('400 on missing home.remote', async () => {
    const { base, stop } = startServer();
    try {
      const res = await fetch(`${base}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
        body: JSON.stringify({
          envelope_id: 'E1',
          type: 'event_callback',
          workspace_id: 'T1',
          xoxb: 'xoxb-x',
          home: {},
          payload: { event: {} },
        }),
      });
      expect(res.status).toBe(400);
    } finally {
      stop();
    }
  });
});

describe('malformed request hardening (#297)', () => {
  // A CONNECT (or otherwise authority-form) request makes `new URL(req.url)`
  // throw; without the guard the handler threw and crashed the process.
  // Expect a clean 400 and a still-live server.
  test('authority-form request line returns 400, server stays up', async () => {
    const { base, port, stop } = startServer();
    try {
      const status = await sendRawRequest(port, 'CONNECT 185.65.245.10:7227 HTTP/1.1');
      expect(status).toContain('400');
      // Server is still alive: a normal /health request succeeds afterward.
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(200);
    } finally {
      stop();
    }
  });
});

describe('POST /events SSE response', () => {
  test('interactive payload returns 200 and emits `done`', async () => {
    const { base, stop } = startServer();
    try {
      const res = await fetch(`${base}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
        body: JSON.stringify({
          envelope_id: 'E1',
          type: 'interactive',
          workspace_id: 'T1',
          xoxb: 'xoxb-x',
          home: { remote: 'file:///tmp' },
          // Stale click — payload doesn't match any pending ask, so the
          // dispatch is a fast no-op and the stream resolves cleanly.
          payload: { type: 'block_actions', message: { ts: 'no-such-ts' }, actions: [] },
        }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/event-stream');
      const events = await readSseEvents(res);
      expect(events[events.length - 1]).toBe('done');
    } finally {
      stop();
    }
  });

  test('event_callback with invalid xoxb surfaces as `error` (not 500)', async () => {
    const { base, stop } = startServer();
    try {
      const res = await fetch(`${base}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
        body: JSON.stringify({
          envelope_id: 'E2',
          type: 'event_callback',
          workspace_id: 'T1',
          // Bogus xoxb so the per-request WebClient's auth.test() fails;
          // the SSE stream should emit `error`, not a 500.
          xoxb: 'xoxb-not-a-real-token',
          home: { remote: 'file:///tmp' },
          payload: {
            event: {
              type: 'message',
              channel: 'C1',
              ts: '1.0',
              user: 'U1',
              text: 'hi',
            },
          },
        }),
      });
      expect(res.status).toBe(200);
      const events = await readSseEvents(res);
      expect(events).toContain('error');
    } finally {
      stop();
    }
  });
});
