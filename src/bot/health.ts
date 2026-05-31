// Bot `/health` endpoint (#253).
//
// Bun.serve on HEALTH_PORT (default 8080). Returns 200 iff Socket Mode is
// connected, else 503. This is the only inbound surface on the bot service;
// Fly/ECS use it as their machine-level health check. Process-up + socket
// connected = OK. Silent-deaf detection (#27) is the tenant watchdog's job
// today; not duplicated here.
//
// `isConnected` is a callback so the caller (index.ts) controls the source
// of truth — typically a boolean flipped by `connected`/`disconnected`
// listeners on the `SocketModeClient`.

import { log } from '../shared/log';

export type HealthServer = {
  port: number;
  stop: () => void;
};

export function startHealth(port: number, isConnected: () => boolean): HealthServer {
  const server = Bun.serve({
    port,
    hostname: '0.0.0.0',
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== '/health') {
        return new Response('Not Found', { status: 404 });
      }
      const ok = isConnected();
      return new Response(JSON.stringify({ ok, socket: ok }), {
        status: ok ? 200 : 503,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  log.info('bot/health', `health on http://0.0.0.0:${server.port}/health`);
  return {
    port: server.port,
    stop: () => server.stop(true),
  };
}
