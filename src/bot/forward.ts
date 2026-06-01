// Bot → tenant /events forwarder (#253).
//
// `POST {tenant.url}/events` with the bot's per-tenant shared bearer secret
// (`Authorization: Bearer <resolved auth_env value>`) and a JSON body that
// is the full `EventEnvelope` we minted in `index.ts`. The response is a
// status-only SSE stream — the tenant talks to Slack directly using the
// request-scoped xoxb inside the envelope, so the stream carries no Slack
// ops, only `heartbeat` / `error` / `done` markers.
//
// We drain the stream until we see a `done` or `error` event (or it closes),
// log on `error`, and return. The bot does NOT retry — Slack's at-least-once
// redelivery is the recovery story; double-handling is the tenant's problem
// (envelope_id is the idempotency key).
//
// Network errors are logged and swallowed (bot must keep routing the next
// event). The Socket Mode ack already shipped in `socket.ts`, so a failure
// here doesn't trigger a Slack retry — that's the deliberate trade-off
// called out in the spec.

import { log } from '../shared/log';
import type { EventEnvelope, TenantsConfig } from '../shared/types';

export type ForwardResult = 'done' | 'error' | 'closed' | 'send-failed';

export async function forwardToTenant(
  tenantName: string,
  config: TenantsConfig,
  envelope: EventEnvelope,
): Promise<ForwardResult> {
  const tenant = config.tenants[tenantName];
  if (!tenant) {
    log.error('bot/forward', `tenant ${tenantName} not in config`);
    return 'send-failed';
  }
  const secret = process.env[tenant.auth_env];
  if (!secret) {
    log.error(
      'bot/forward',
      `tenant ${tenantName} auth_env ${tenant.auth_env} not set; cannot dispatch`,
    );
    return 'send-failed';
  }

  const url = joinEventsUrl(tenant.url);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`,
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(envelope),
    });
  } catch (err) {
    log.error(
      'bot/forward',
      `POST to tenant ${tenantName} (${url}) failed: ${(err as Error).message}`,
    );
    return 'send-failed';
  }

  if (!res.ok) {
    log.error(
      'bot/forward',
      `tenant ${tenantName} returned HTTP ${res.status} for envelope ${envelope.envelope_id}`,
    );
    // Drain the body so the connection can be reused / closed cleanly.
    try {
      await res.text();
    } catch {}
    return 'error';
  }

  return drainSse(res, tenantName, envelope.envelope_id);
}

// Trim a trailing slash so `${url}/events` doesn't double-slash. We accept
// the spec's literal form (`tenant.url = "https://host/"`) AND a bare host
// (`"https://host"`) so config edits are forgiving.
function joinEventsUrl(base: string): string {
  const trimmed = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${trimmed}/events`;
}

// Minimal SSE parser: split on blank lines, look for an `event:` line and
// stop on the first `done` or `error`. We don't care about `data:` payload
// shape — these are status markers only. If the stream closes without a
// terminal marker we log + return `closed`.
async function drainSse(
  res: Response,
  tenantName: string,
  envelopeId: string,
): Promise<ForwardResult> {
  if (!res.body) {
    log.warn('bot/forward', `tenant ${tenantName} response had no body for ${envelopeId}`);
    return 'closed';
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // SSE messages are separated by blank lines (\n\n). Process every
      // complete message; keep the partial tail in `buf`.
      while (true) {
        const sep = buf.indexOf('\n\n');
        if (sep === -1) break;
        const message = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const event = parseEventName(message);
        if (event === 'done') return 'done';
        if (event === 'error') {
          log.warn('bot/forward', `tenant ${tenantName} reported error for envelope ${envelopeId}`);
          return 'error';
        }
        // `heartbeat` and anything else: ignore, keep reading.
      }
    }
  } catch (err) {
    log.error(
      'bot/forward',
      `read stream from tenant ${tenantName} (${envelopeId}) failed: ${(err as Error).message}`,
    );
    return 'error';
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }

  log.warn(
    'bot/forward',
    `tenant ${tenantName} stream for ${envelopeId} closed without terminal event`,
  );
  return 'closed';
}

function parseEventName(message: string): string | null {
  for (const line of message.split('\n')) {
    if (line.startsWith('event:')) {
      return line.slice('event:'.length).trim();
    }
  }
  return null;
}
