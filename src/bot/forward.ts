// Bot → tenant /events forwarder (#253).
//
// `POST {tenant.url}/events` with the bot's per-tenant shared bearer secret
// (`Authorization: Bearer <resolved auth_env value>`) and a JSON body that
// is the full `EventEnvelope` we minted in `index.ts`. The response is a
// status-only SSE stream — the tenant talks to Slack directly using the
// request-scoped xoxb inside the envelope, so the stream carries no Slack
// ops, only `heartbeat` / `error` / `done` markers, none of which the bot
// acts on. We drain it to EOF (the tenant closes the stream after its
// terminal event); the heartbeat keeps the connection alive for a long turn
// across a future split-host proxy. The bot does NOT retry — Slack's
// at-least-once redelivery is the recovery story; double-handling is the
// tenant's problem (envelope_id is the idempotency key).
//
// Network errors are logged and swallowed (the bot must keep routing the next
// event). The Socket Mode ack already shipped in `socket.ts`, so a failure
// here doesn't trigger a Slack retry — the deliberate trade-off from the spec.

import { log } from '../shared/log';
import type { EventEnvelope, TenantsConfig } from '../shared/types';

export async function forwardToTenant(
  tenantName: string,
  config: TenantsConfig,
  envelope: EventEnvelope,
): Promise<void> {
  const tenant = config.tenants[tenantName];
  if (!tenant) {
    log.error('bot/forward', `tenant ${tenantName} not in config`);
    return;
  }
  const secret = process.env[tenant.auth_env];
  if (!secret) {
    log.error(
      'bot/forward',
      `tenant ${tenantName} auth_env ${tenant.auth_env} not set; cannot dispatch`,
    );
    return;
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
    return;
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
    return;
  }

  await drainToEof(res, tenantName, envelope.envelope_id);
}

// Trim a trailing slash so `${url}/events` doesn't double-slash. We accept
// the spec's literal form (`tenant.url = "https://host/"`) AND a bare host
// (`"https://host"`) so config edits are forgiving.
function joinEventsUrl(base: string): string {
  const trimmed = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${trimmed}/events`;
}

// Read the status stream to EOF and discard it. We don't parse the SSE markers
// — the bot branches on none of them (it already acked Slack and never retries;
// the tenant logs its own turn errors). Reading to completion just blocks until
// the turn finishes and lets the connection close cleanly.
async function drainToEof(res: Response, tenantName: string, envelopeId: string): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  } catch (err) {
    log.error(
      'bot/forward',
      `read stream from tenant ${tenantName} (${envelopeId}) failed: ${(err as Error).message}`,
    );
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
}
