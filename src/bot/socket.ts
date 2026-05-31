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

export async function openSocketMode(
  appToken: string,
  onEvent: (env: SocketEnvelope) => void,
): Promise<SocketHandle> {
  const socket = new SocketModeClient({ appToken });

  socket.on('connected', () => log.info('bot/socket', 'connected'));
  socket.on('disconnected', () => log.warn('bot/socket', 'disconnected'));
  socket.on('error', (err) => log.error('bot/socket', 'error', err));

  // Listen on the catch-all `slack_event` channel. `@slack/socket-mode`'s
  // per-type emitters fire on the INNER event type for events_api
  // messages (e.g. `'message'`, `'app_mention'`) — not on the wrapper
  // type `'event_callback'` — so the previous per-type listeners never
  // fired and every Slack mention was silently dropped. `slack_event`
  // fires once per envelope with `{ type, body, envelope_id, ack }`,
  // where `type` is the SOCKET-mode envelope type (`'events_api'` for
  // Events API events, `'interactive'` for block_actions / shortcuts).
  // We re-map to the spec's `'event_callback' | 'interactive'` for
  // downstream routing.
  //
  // Ack FIRST, then dispatch. Slack's 3s ack budget must not depend on
  // tenant latency; if dispatching throws we swallow + log (the next
  // envelope must still route).
  type SlackEventArgs = {
    type: string;
    envelope_id?: string;
    body?: Record<string, unknown>;
    ack: () => Promise<void>;
  };
  socket.on('slack_event', async (args: SlackEventArgs) => {
    try {
      await args.ack();
    } catch (err) {
      log.error('bot/socket', `ack failed for ${args.type}`, err);
      return;
    }
    // Map socket-mode envelope `type` → spec envelope `type`. Drop
    // anything else (slash_commands, etc.) — the bot doesn't route
    // those yet.
    let envType: 'event_callback' | 'interactive';
    if (args.type === 'events_api') envType = 'event_callback';
    else if (args.type === 'interactive') envType = 'interactive';
    else return;
    const body = args.body;
    if (!body || typeof body !== 'object') {
      log.warn('bot/socket', `${envType} envelope missing body`);
      return;
    }
    const envelopeId = args.envelope_id ?? (body.envelope_id as string | undefined);
    if (typeof envelopeId !== 'string' || envelopeId.length === 0) {
      log.warn('bot/socket', `${envType} envelope missing envelope_id`);
      return;
    }
    try {
      onEvent({ envelope_id: envelopeId, type: envType, payload: body });
    } catch (err) {
      log.error('bot/socket', `onEvent threw for ${envType}`, err);
    }
  });

  await socket.start();
  return { socket };
}
