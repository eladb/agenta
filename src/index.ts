import { teardownAllSessions } from './git/bootstrap';
import { acquire } from './lockfile';
import { log } from './log';
import { makeEventHandler } from './runtime/handler';
import type { ModelTriplet } from './runtime/home-config';
import { recoverInterruptedSessions } from './runtime/recovery';
import { reapOrphanSandboxes } from './sandbox';
import { connect } from './slack/connect';
import { listen } from './slack/events';
import { listenInteractive } from './slack/interactive';
import { startWatchdog } from './slack/watchdog';

const appToken = process.env.SLACK_APP_TOKEN;
const botToken = process.env.SLACK_BOT_TOKEN;
// Prefer the generic name; fall back to ANTHROPIC_API_KEY so existing setups
// don't break. The gateway speaks the OpenAI-compatible wire format, so this
// same key can point at OpenRouter, Anthropic's compat endpoint, or any other
// OpenAI-compat host via MODEL_BASE_URL.
const modelApiKey = process.env.MODEL_API_KEY ?? process.env.ANTHROPIC_API_KEY;

if (!appToken || !botToken) {
  log.error('boot', 'SLACK_APP_TOKEN and SLACK_BOT_TOKEN required (see .env.example)');
  process.exit(1);
}

// Env-derived model fallback (#128). Used when a thread's channel doesn't
// have a per-channel `model` block in homes.json AND the default home doesn't
// either. Existing single-model deploys carry this fallback only — keeping
// it works without homes.json changes. The api_key_env name we pin here
// (`MODEL_API_KEY` or `ANTHROPIC_API_KEY`) is what gets frozen into
// session.json on first mention; the secret value is read at every call.
let fallbackModel: ModelTriplet | undefined;
if (modelApiKey) {
  const apiKeyEnv = process.env.MODEL_API_KEY ? 'MODEL_API_KEY' : 'ANTHROPIC_API_KEY';
  fallbackModel = {
    name: process.env.MODEL_NAME ?? 'claude-sonnet-4-6',
    base_url: process.env.MODEL_BASE_URL ?? 'https://api.anthropic.com/v1',
    api_key_env: apiKeyEnv,
  };
}

// Single-process lock: two agent instances using the same bot token would
// split-brain Socket Mode delivery (Slack sends each event to exactly one
// connected client). Fails fast with a clear error pointing at the running
// pid, instead of silently dropping half of incoming events.
try {
  acquire('agent');
} catch (err) {
  log.error('boot', (err as Error).message);
  process.exit(1);
}

// The system prompt is no longer constructed here — the handler composes it
// per thread from the agent home dir on the first mention (README.md + skills),
// then freezes it in `data/{thread_key}/session.json`. `SYSTEM_PROMPT` env
// var, if set, *prepends* to that composition; it no longer replaces it.

const { socket, web, botUserId } = await connect(appToken, botToken);
log.info('boot', `connected as bot user ${botUserId}`);

// Register handlers BEFORE any slow boot work. Both reap and recovery
// hit Slack/Fly HTTP APIs which can stall under throttling or transient
// network issues — we don't want them to delay the bot from responding
// to incoming mentions. Each runs as fire-and-forget; failures log a
// warning and don't take the bot down.
listen(socket, botUserId, makeEventHandler(web, botToken, botUserId, fallbackModel));
listenInteractive(socket);
log.info('boot', 'listening for events');

// Health endpoint for Fly's machine-level [[checks]]. Process-up + Socket
// Mode connected = OK. Slack silent-deaf (#27) isn't detected here yet —
// that needs an event-recency heartbeat we haven't built. Binds to all
// interfaces so Fly's check infrastructure inside the machine can reach
// it. The bot has no [http_service] so this port isn't publicly exposed.
const healthPort = Number(process.env.HEALTH_PORT ?? '8080');
// connect() above already awaited socket.start(), so by here the socket
// IS connected — initialize true and let subsequent disconnect/connect
// events flip the flag. If we initialized false, the first health probe
// after boot would 503 because connect()'s own 'connected' listener
// already fired before this one attached.
let socketConnected = true;
socket.on('connected', () => {
  socketConnected = true;
});
socket.on('disconnected', () => {
  socketConnected = false;
});
const healthServer = Bun.serve({
  port: healthPort,
  hostname: '0.0.0.0',
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== '/health') {
      return new Response('Not Found', { status: 404 });
    }
    const ok = socketConnected;
    return new Response(JSON.stringify({ ok, socket: socketConnected }), {
      status: ok ? 200 : 503,
      headers: { 'Content-Type': 'application/json' },
    });
  },
});
log.info('boot', `health on http://0.0.0.0:${healthServer.port}/health`);

// Socket Mode liveness watchdog (#41, addresses #27). Periodic auth.test
// ping; after 3 consecutive failures the process exits and Fly restarts us.
// The @slack/socket-mode library has no clean force-reconnect API and we
// don't trust it to shake out of the silent-deaf state on its own.
startWatchdog({ web });

// Announce any in-flight sessions that died with the previous process.
// listSessions() scans data/{thread_key}/session.json.
recoverInterruptedSessions(web).catch((err) => {
  log.warn('boot', `recovery failed: ${(err as Error).message}`);
});

// Sandboxes survive bot restart: per-thread routing info lives in
// session.json, the provider re-hydrates from disk on the next mention.
// Routine cleanup is `/delete`. This boot-time reap is a safety net for
// orphans the bot lost track of (e.g. `rm -rf data/` without `/delete`,
// or a thread dir nuked while the bot was down). Slow under Fly
// throttling, so run in the background.
reapOrphanSandboxes().catch((err) => {
  log.warn('boot', `orphan reap failed: ${(err as Error).message}`);
});

// WS tunnels + per-session git HTTP servers live in-process only — they
// don't survive a bot restart and there's nothing to reap on boot. We
// just make sure we stop them on a clean shutdown so the loopback ports
// are released and the WS half-closes propagate to the sandbox.
const tunnelCleanup = (): void => {
  void teardownAllSessions();
};
process.on('exit', tunnelCleanup);
process.on('SIGINT', tunnelCleanup);
process.on('SIGTERM', tunnelCleanup);
