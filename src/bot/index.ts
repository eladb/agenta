// Ingress bot entrypoint (#253).
//
// Wires together: lockfile → tenants.json → Socket Mode → per-event route
// resolution → forward to tenant. No disk writes, no Slack ops, no model
// calls — those are tenant responsibilities. The bot is a thin router with
// a `/health` endpoint.
//
// Per-event flow:
//   1. socket.ts has already acked Slack.
//   2. Extract team_id from payload.team_id and channel_id from
//      payload.event?.channel || payload.channel?.id (event_callback vs.
//      interactive shapes).
//   3. Resolve the route via shared/routes.ts. If null: log + drop + metric.
//   4. Mint an EventEnvelope (xoxb = SLACK_BOT_TOKEN, home from route) and
//      forwardToTenant.
//
// xoxb today comes from a single env var because the bot serves one xapp.
// Future OAuth distributed install will turn this into a workspace → xoxb
// map; the envelope already carries `xoxb` per-request so the data plane
// is forwards-compatible.

import { join } from 'node:path';
import { acquire } from '../shared/lockfile';
import { log } from '../shared/log';
import type { TenantsConfig } from '../shared/types';
import { loadTenantsConfig } from './config';
import { forwardToTenant } from './forward';
import { startHealth } from './health';
import { decideRoute } from './routing';
import { openSocketMode, type SocketEnvelope } from './socket';

const appToken = process.env.SLACK_APP_TOKEN;
const botToken = process.env.SLACK_BOT_TOKEN;
if (!appToken || !botToken) {
  log.error('bot/boot', 'SLACK_APP_TOKEN and SLACK_BOT_TOKEN required');
  process.exit(1);
}

const tenantsPath = process.env.TENANTS_JSON_PATH ?? join(process.cwd(), 'config/tenants.json');
let tenantsConfig: TenantsConfig;
try {
  tenantsConfig = loadTenantsConfig(tenantsPath);
} catch (err) {
  log.error('bot/boot', `tenants config load failed: ${(err as Error).message}`);
  process.exit(1);
}
log.info(
  'bot/boot',
  `loaded tenants config from ${tenantsPath}: ${Object.keys(tenantsConfig.tenants).length} tenants, ${Object.keys(tenantsConfig.routes).length} workspace routes`,
);

// Single-process lock: a second bot using the same xapp would split-brain
// Socket Mode delivery (Slack sends each event to exactly one connected
// client). Fails fast pointing at the running pid.
try {
  acquire('bot');
} catch (err) {
  log.error('bot/boot', (err as Error).message);
  process.exit(1);
}

// Socket Mode connection. `openSocketMode` already awaited socket.start(),
// so by the time we attach the connected flag the WS IS connected. Initialize
// `true` and let later disconnect/reconnect events flip it; otherwise the
// first probe would 503 because openSocketMode's own 'connected' listener
// fired before this one attached.
let socketConnected = true;
const { socket } = await openSocketMode(appToken, (env) => {
  routeAndForward(env).catch((err) => {
    log.error('bot/dispatch', `routeAndForward threw for ${env.envelope_id}: ${err}`);
  });
});
socket.on('connected', () => {
  socketConnected = true;
});
socket.on('disconnected', () => {
  socketConnected = false;
});

const healthPort = Number(process.env.HEALTH_PORT ?? '8080');
startHealth(healthPort, () => socketConnected);

log.info('bot/boot', 'listening for Slack events');

// ---------------------------------------------------------------------------
// Per-envelope dispatch. Routing decision lives in `./routing.ts` so unit
// tests can exercise it without booting Socket Mode / lockfile / health.

async function routeAndForward(socketEnv: SocketEnvelope): Promise<void> {
  // SAFETY: botToken is validated non-null at boot, so the bang is sound.
  const decision = decideRoute(socketEnv, tenantsConfig, botToken as string);
  if (decision.kind === 'dropped') {
    if (decision.reason === 'no-team') {
      log.warn('bot/route', `dropped ${socketEnv.envelope_id}: no team_id in payload`);
    } else {
      log.warn(
        'bot/route',
        `dropped ${socketEnv.envelope_id}: unrouted workspace=${decision.teamId ?? '?'} channel=${decision.channelId ?? '?'}`,
      );
    }
    return;
  }
  log.info('bot/route', `envelope ${decision.envelope.envelope_id} -> tenant ${decision.tenant}`);
  await forwardToTenant(decision.tenant, tenantsConfig, decision.envelope);
}
