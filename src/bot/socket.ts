// Slack Socket Mode wrapper for the ingress bot (#253).
//
// The bot owns exactly one Socket Mode connection (one xapp). On every
// envelope it acks Slack IMMEDIATELY (Slack's 3s ack window must not depend
// on tenant latency), then hands the raw envelope to `onEvent` to dispatch
// to the resolved tenant asynchronously. `onEvent` is fire-and-forget from
// Slack's perspective; any failure inside is logged but never re-raised.
//
// The bot never inspects the payload here — payload parsing/normalization
// is the tenant's job. We just forward the raw envelope plus the type so
// `index.ts` can resolve the route and mint an `EventEnvelope`.
//
// Connection lifecycle events are logged but otherwise opaque; the caller
// gets a `socket` handle to attach `connected`/`disconnected` listeners for
// `/health` reporting.

import { SocketModeClient } from '@slack/socket-mode';
import { log } from '../shared/log';

export type SocketEnvelope = {
  envelope_id: string;
  type: 'event_callback' | 'interactive' | string;
  payload: Record<string, unknown>;
};

export type SocketHandle = {
  socket: SocketModeClient;
};

// Slack's @slack/socket-mode passes a single arg object to event listeners
// with `body` (full envelope), `event` (inner event for `event_callback`),
// and an `ack` callback that resolves Slack's WS-level ack frame. We treat
// `body` as untyped JSON and let the caller pluck fields it cares about.
type SocketModeArgs = {
  body?: {
    envelope_id?: string;
    type?: string;
    payload?: unknown;
    [k: string]: unknown;
  };
  ack: () => Promise<void>;
};

export async function openSocketMode(
  appToken: string,
  onEvent: (env: SocketEnvelope) => void,
): Promise<SocketHandle> {
  const socket = new SocketModeClient({ appToken });

  socket.on('connected', () => log.info('bot/socket', 'connected'));
  socket.on('disconnected', () => log.warn('bot/socket', 'disconnected'));
  socket.on('error', (err) => log.error('bot/socket', 'error', err));

  // We register a handler for each Slack envelope type we care about. Each
  // handler acks the envelope FIRST, then dispatches. If dispatching throws
  // synchronously we still swallow it (fire-and-forget); the next event
  // must still route.
  const handle = (type: 'event_callback' | 'interactive') => async (args: SocketModeArgs) => {
    try {
      await args.ack();
    } catch (err) {
      log.error('bot/socket', `ack failed for ${type}`, err);
      return;
    }
    const body = args.body;
    if (!body || typeof body !== 'object') {
      log.warn('bot/socket', `${type} envelope missing body`);
      return;
    }
    const envelopeId = body.envelope_id;
    if (typeof envelopeId !== 'string' || envelopeId.length === 0) {
      log.warn('bot/socket', `${type} envelope missing envelope_id`);
      return;
    }
    try {
      onEvent({ envelope_id: envelopeId, type, payload: body as Record<string, unknown> });
    } catch (err) {
      log.error('bot/socket', `onEvent threw for ${type}`, err);
    }
  };

  socket.on('event_callback', handle('event_callback'));
  socket.on('interactive', handle('interactive'));

  await socket.start();
  return { socket };
}
