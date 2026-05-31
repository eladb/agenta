// Tenant entrypoint (#253).
//
// The tenant is the agent harness — sessions, sandboxes, model gateway, JSONL
// store. Ingress moved to the bot service: there is no Socket Mode connection
// here anymore. Instead we start an HTTP server on `HEALTH_PORT` that exposes
// `POST /events` (bearer-auth, SSE response) and `GET /health`. The bot acks
// Slack, resolves the route, then POSTs the envelope here for processing.
//
// Boot order is deliberate:
//   1. Validate env (TENANT_SECRET + model triplet are non-negotiable).
//   2. Acquire the 'agent' lockfile (one tenant per data volume).
//   3. Recover interrupted sessions (silent — no WebClient at boot, so any
//      in-flight turn just gets cleared to idle; the user sees their next
//      mention re-trigger work fresh. Spec trade.).
//   4. Reap orphan sandboxes in the background (safety net; idempotent).
//   5. Start the HTTP server, latching readyRef → /health goes 200.
//
// Shutdown: tear down per-session git/WS state on SIGINT/SIGTERM so loopback
// ports + sandbox-side tunnels close cleanly. Sandboxes themselves outlive
// the tenant process — they're keyed off thread_key in session.json.

import { acquire } from '../shared/lockfile';
import { log } from '../shared/log';
import { teardownAllSessions } from './git/bootstrap';
import { startHttp } from './http';
import type { ModelTriplet } from './runtime/home-config';
import { recoverInterruptedSessions } from './runtime/recovery';
import { reapOrphanSandboxes } from './sandbox';

const tenantSecret = process.env.TENANT_SECRET;
if (!tenantSecret || tenantSecret.length === 0) {
  log.error('boot', 'TENANT_SECRET required (shared bearer secret the bot uses to call /events)');
  process.exit(1);
}

// Prefer the generic name; fall back to ANTHROPIC_API_KEY so existing setups
// don't break. The gateway speaks the OpenAI-compatible wire format, so this
// same key can point at OpenRouter, Anthropic's compat endpoint, or any other
// OpenAI-compat host via MODEL_BASE_URL.
const modelApiKey = process.env.MODEL_API_KEY ?? process.env.ANTHROPIC_API_KEY;

// Env-derived model fallback. With per-tenant homes.json gone (#253) this
// IS the model triplet for every turn — the bot's envelope no longer
// carries a model block. The api_key_env name we pin here (`MODEL_API_KEY`
// or `ANTHROPIC_API_KEY`) is what gets frozen into session.json on first
// mention; the secret value is read at every call.
let fallbackModel: ModelTriplet | undefined;
if (modelApiKey) {
  const apiKeyEnv = process.env.MODEL_API_KEY ? 'MODEL_API_KEY' : 'ANTHROPIC_API_KEY';
  fallbackModel = {
    name: process.env.MODEL_NAME ?? 'claude-sonnet-4-6',
    base_url: process.env.MODEL_BASE_URL ?? 'https://api.anthropic.com/v1',
    api_key_env: apiKeyEnv,
  };
}

// Single-process lock: two tenants on the same data volume would race the
// JSONL append + session.json writes. Fails fast with a clear error pointing
// at the running pid.
try {
  acquire('agent');
} catch (err) {
  log.error('boot', (err as Error).message);
  process.exit(1);
}

// `/health` returns 503 until this latches true. Bot's drain loop treats
// non-200 as "skip" so Slack will redeliver; that's the right behavior
// while we're sweeping interrupted sessions on boot.
const readyRef = { value: false };

// Recovery first — we want any 'running'/'stopping' marker cleared before
// the first envelope arrives, so a new mention in an interrupted thread
// can start fresh instead of queueing behind a phantom turn. No Slack deps
// at boot (the spec accepts the "frozen partial message until next mention"
// trade); the next phase formalizes the silent variant.
try {
  await recoverInterruptedSessions();
} catch (err) {
  log.warn('boot', `recovery failed: ${(err as Error).message}`);
}

// Sandboxes survive bot restart: per-thread routing info lives in
// session.json, the provider re-hydrates from disk on the next mention.
// Routine cleanup is `/delete`. This boot-time reap is a safety net for
// orphans the bot lost track of (e.g. `rm -rf data/` without `/delete`, or
// a thread dir nuked while the bot was down). Slow under Fly throttling, so
// run in the background.
reapOrphanSandboxes().catch((err) => {
  log.warn('boot', `orphan reap failed: ${(err as Error).message}`);
});

// HTTP server: this is the entire ingress surface now. `HEALTH_PORT` keeps
// the old env var name even though it's also the events port — same Bun.serve
// instance, two routes.
const port = Number(process.env.HEALTH_PORT ?? '8080');
const server = startHttp({
  port,
  tenantSecret,
  fallbackModel,
  readyRef,
});
readyRef.value = true;
log.info('boot', `tenant ready on http://0.0.0.0:${server.port} (/events + /health)`);

// WS tunnels + per-session git HTTP servers live in-process only — they
// don't survive a tenant restart and there's nothing to reap on boot. We
// just make sure we stop them on a clean shutdown so the loopback ports
// are released and the WS half-closes propagate to the sandbox.
const tunnelCleanup = (): void => {
  void teardownAllSessions();
};
process.on('exit', tunnelCleanup);
process.on('SIGINT', tunnelCleanup);
process.on('SIGTERM', tunnelCleanup);
