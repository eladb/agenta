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
// The bot serves N Slack apps (one per workspace), opening one Socket Mode
// connection per app and threading that app's bot token as the per-event xoxb.
// Apps come from SLACK_APPS_JSON (or the single SLACK_APP_TOKEN/SLACK_BOT_TOKEN
// fallback) — see ./apps.ts. The envelope carries `xoxb` per-request so the
// data plane is unchanged. (OAuth distributed install — one app across many
// workspaces with a stored install map — remains future work.)

import { join } from 'node:path';
import { acquire } from '../shared/lockfile';
import { log } from '../shared/log';
import type { TenantsConfig } from '../shared/types';
import { parseSlackApps } from './apps';
import { loadTenantsConfig } from './config';
import { forwardToTenant } from './forward';
import { startHealth } from './health';
import { decideRoute } from './routing';
import { openSocketMode, type SocketEnvelope } from './socket';

let apps: ReturnType<typeof parseSlackApps>;
try {
  apps = parseSlackApps(process.env);
} catch (err) {
  log.error('bot/boot', (err as Error).message);
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

// One Socket Mode connection per Slack app. Slack delivers each event to
// exactly one connected client per app, so N apps = N connections in this one
// process (still a single 'bot' lock). Each connection threads ITS app's bot
// token as the xoxb. `openSocketMode` already awaited socket.start(), so the WS
// is connected by the time we attach the flag — initialize `true` and let
// later disconnect/reconnect events flip it (else the first probe would 503).
const connected = apps.map(() => true);
await Promise.all(
  apps.map(async (app, i) => {
    const { socket } = await openSocketMode(app.appToken, (env) => {
      routeAndForward(env, app.botToken).catch((err) => {
        log.error('bot/dispatch', `routeAndForward threw for ${env.envelope_id}: ${err}`);
      });
    });
    socket.on('connected', () => {
      connected[i] = true;
    });
    socket.on('disconnected', () => {
      connected[i] = false;
    });
  }),
);

const healthPort = Number(process.env.HEALTH_PORT ?? '8080');
// Healthy iff EVERY app's connection is up.
startHealth(healthPort, () => connected.every(Boolean));

log.info('bot/boot', `listening for Slack events across ${apps.length} app(s)`);

// ---------------------------------------------------------------------------
// Per-envelope dispatch. Routing decision lives in `./routing.ts` so unit
// tests can exercise it without booting Socket Mode / lockfile / health.

async function routeAndForward(socketEnv: SocketEnvelope, botToken: string): Promise<void> {
  const decision = decideRoute(socketEnv, tenantsConfig, botToken);
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
