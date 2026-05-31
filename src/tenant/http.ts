// Tenant HTTP entrypoint (#253).
//
// `POST /events` is the bot→tenant data plane: the bot acks Slack, resolves
// the route, and forwards the raw envelope here. The body is a JSON
// `EventEnvelope` (see `src/shared/types.ts`). We:
//   1. Bearer-auth from `TENANT_SECRET` (constant-time compare).
//   2. Parse + validate the envelope.
//   3. Build a request-scoped WebClient from envelope.xoxb and resolve the
//      bot user id with auth.test (it doesn't ship in the envelope).
//   4. Normalize the inner Slack event (`event_callback`) into an
//      `IncomingEvent` or dispatch the `interactive` payload to the asks
//      registry. Hand off to `makeEventHandler`'s returned function.
//   5. Stream SSE status events back: `heartbeat` every 10s while running,
//      `error` on exception, `done` on resolve. The stream carries NO Slack
//      ops — the tenant talks to Slack directly via the request-scoped xoxb.
//
// `GET /health` returns 200 once boot is done (lockfile acquired + recovery
// finished) and 503 otherwise. There's no Socket Mode liveness signal
// anymore — process-up is all we need to report; the bot's own /health is
// the upstream signal.

import { timingSafeEqual } from 'node:crypto';
import { WebClient } from '@slack/web-api';
import { log } from '../shared/log';
import type { EventEnvelope, HomeSpec } from '../shared/types';
import type { CallModel } from './model/gateway';
import { makeEventHandler } from './runtime/handler';
import { type ModelTriplet, resolveHomeFromEnvelope } from './runtime/home-config';
import { normalize, type RawEvent } from './slack/events';
import { handleInteractivePayload } from './slack/interactive';

// 10s heartbeat keeps a typical reverse proxy / Slack Socket Mode 3s ack
// budget (already paid by the bot) plus the bot's drain loop happy. The
// upstream forwarder treats any non-`done`/`error` frame as keepalive.
const HEARTBEAT_INTERVAL_MS = 10_000;

export type HttpOptions = {
  port: number;
  hostname?: string;
  // Shared secret the bot uses as a Bearer token on /events. The tenant
  // resolves it once at boot from `TENANT_SECRET` in env. Production sets
  // this as a Fly/ECS secret tied to the value the bot resolves from
  // `tenants[name].auth_env`.
  tenantSecret: string;
  fallbackModel: ModelTriplet | undefined;
  // `/health` returns 200 only after this latches true (lockfile acquired +
  // recovery done). Until then the bot's drain loop will see 503 and skip
  // dispatching, which is fine — Slack will redeliver on its next attempt.
  readyRef: { value: boolean };
  // Test seam: e2e harness injects a stubbed `CallModel` so the tenant never
  // hits the real model gateway. Production never sets this — the handler
  // builds the real callModel from the per-thread frozen triplet. Wired
  // through `dispatch` → `makeEventHandler` (`callModelOverride` arg).
  callModelOverride?: CallModel;
};

export function startHttp(opts: HttpOptions): ReturnType<typeof Bun.serve> {
  const expectedSecret = Buffer.from(opts.tenantSecret);

  // biome-ignore lint/suspicious/noExplicitAny: Bun.serve fetch handler
  const fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/health') {
      const ok = opts.readyRef.value;
      return new Response(JSON.stringify({ ok, ready: opts.readyRef.value }), {
        status: ok ? 200 : 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (req.method === 'POST' && url.pathname === '/events') {
      // Bearer-auth FIRST so an unauth'd request can't even allocate the
      // SSE machinery. Constant-time compare keeps the secret check
      // immune to timing leaks across the public network (Fly / ECS).
      const auth = req.headers.get('authorization') ?? '';
      const provided = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
      const providedBuf = Buffer.from(provided);
      if (
        providedBuf.length !== expectedSecret.length ||
        !timingSafeEqual(providedBuf, expectedSecret)
      ) {
        return new Response('Unauthorized', { status: 401 });
      }

      let envelope: EventEnvelope;
      try {
        const raw = (await req.json()) as unknown;
        envelope = validateEnvelope(raw);
      } catch (err) {
        log.warn('http', `invalid envelope: ${(err as Error).message}`);
        return new Response(`Bad Request: ${(err as Error).message}`, { status: 400 });
      }

      // SSE stream. We open it immediately so the bot's drain loop sees a
      // 200 and can start counting heartbeats; the actual dispatch happens
      // inside the stream's `start` callback so an exception surfaces as
      // an `error` event rather than a 500 to the bot.
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          const send = (event: string, data: string = ''): void => {
            try {
              controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
            } catch {
              // controller already closed — bot disconnected mid-stream.
              // The dispatch promise will still settle; ignore the error.
            }
          };
          const heartbeat = setInterval(() => send('heartbeat'), HEARTBEAT_INTERVAL_MS);
          heartbeat.unref?.();
          dispatch(envelope, opts.fallbackModel, opts.callModelOverride)
            .then(() => {
              send('done');
            })
            .catch((err) => {
              const msg = (err as Error).message ?? String(err);
              log.error('http', `dispatch failed for ${envelope.envelope_id}: ${msg}`);
              send('error', msg);
            })
            .finally(() => {
              clearInterval(heartbeat);
              try {
                controller.close();
              } catch {}
            });
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    }

    return new Response('Not Found', { status: 404 });
  };

  const server = Bun.serve({
    port: opts.port,
    hostname: opts.hostname ?? '0.0.0.0',
    fetch,
  });
  log.info('http', `tenant /events listening on ${opts.hostname ?? '0.0.0.0'}:${server.port}`);
  return server;
}

// Per-event dispatch: build a request-scoped WebClient + handler closure and
// route based on envelope.type. event_callback events go through the existing
// normalize → handler.makeEventHandler pipeline; interactive events go to
// the asks-registry dispatcher directly.
async function dispatch(
  envelope: EventEnvelope,
  fallbackModel: ModelTriplet | undefined,
  callModelOverride: CallModel | undefined,
): Promise<void> {
  if (envelope.type === 'interactive') {
    handleInteractivePayload(envelope.payload);
    return;
  }

  // event_callback: WebClient is request-scoped so a credential rotation on
  // the bot side takes effect on the next envelope, without a tenant restart.
  const web = new WebClient(envelope.xoxb);
  const auth = await web.auth.test();
  const botUserId = auth.user_id;
  if (typeof botUserId !== 'string' || botUserId.length === 0) {
    throw new Error('auth.test did not return user_id');
  }

  const inner = extractEventCallbackInner(envelope.payload);
  if (!inner) {
    log.warn(
      'http',
      `envelope ${envelope.envelope_id} type=event_callback but no .event payload; dropping`,
    );
    return;
  }
  const normalized = normalize(inner, envelope.envelope_id, botUserId);
  if (!normalized) return;

  // Validate the envelope's home spec against the tenant's process env —
  // surfaces missing/empty auth_env values here with a clear error rather
  // than later inside a git clone. The returned HomeConfig is what gets
  // forwarded to the handler + frozen into session.json on first mention.
  const home = resolveHomeFromEnvelope(envelope.home, process.env);

  const handler = makeEventHandler(
    web,
    envelope.xoxb,
    botUserId,
    {
      home,
      fallbackModel,
    },
    callModelOverride,
  );
  await handler(normalized);
}

// Slack's event_callback envelope wraps the actual event under `.event`.
// The bot forwards the whole envelope as `payload`; we only need the inner
// object for normalize(). Returns null for anything that doesn't look like
// an event_callback so we drop it cleanly instead of crashing on a missing
// channel field.
function extractEventCallbackInner(payload: unknown): RawEvent | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const ev = p.event;
  if (!ev || typeof ev !== 'object') return null;
  return ev as RawEvent;
}

function validateEnvelope(raw: unknown): EventEnvelope {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('body must be a JSON object');
  }
  const r = raw as Record<string, unknown>;
  const requireString = (key: string): string => {
    const v = r[key];
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`envelope.${key} required (non-empty string)`);
    }
    return v;
  };
  const envelopeId = requireString('envelope_id');
  const type = requireString('type');
  if (type !== 'event_callback' && type !== 'interactive') {
    throw new Error(
      `envelope.type must be "event_callback" | "interactive" (got ${JSON.stringify(type)})`,
    );
  }
  const workspaceId = requireString('workspace_id');
  const xoxb = requireString('xoxb');
  const homeRaw = r.home;
  if (!homeRaw || typeof homeRaw !== 'object' || Array.isArray(homeRaw)) {
    throw new Error('envelope.home required (object)');
  }
  const h = homeRaw as Record<string, unknown>;
  if (typeof h.remote !== 'string' || h.remote.length === 0) {
    throw new Error('envelope.home.remote required (non-empty string)');
  }
  const home: HomeSpec = { remote: h.remote };
  if (h.auth_env !== undefined) {
    if (typeof h.auth_env !== 'string' || h.auth_env.length === 0) {
      throw new Error('envelope.home.auth_env must be a non-empty string if present');
    }
    home.auth_env = h.auth_env;
  }
  if (r.payload === undefined) {
    throw new Error('envelope.payload required');
  }
  return {
    envelope_id: envelopeId,
    type,
    workspace_id: workspaceId,
    xoxb,
    home,
    payload: r.payload,
  };
}
