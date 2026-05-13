import { log } from './log';
import { createCallModel } from './model/gateway';
import { makeEventHandler } from './runtime/handler';
import { recoverInterruptedSessions } from './runtime/recovery';
import { killAllSandboxContainers } from './sandbox';
import { connect } from './slack/connect';
import { listen } from './slack/events';
import { listenInteractive } from './slack/interactive';

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
if (!modelApiKey) {
  log.error('boot', 'MODEL_API_KEY (or ANTHROPIC_API_KEY) required (see .env.example)');
  process.exit(1);
}

const callModel = createCallModel({
  apiKey: modelApiKey,
  baseUrl: process.env.MODEL_BASE_URL ?? 'https://api.anthropic.com/v1',
  model: process.env.MODEL_NAME ?? 'claude-sonnet-4-6',
});

// The system prompt is no longer constructed here — the handler composes it
// per thread from `sandbox/botspace/` on the first mention (BOT.md + skills),
// then freezes it in `data/{thread_key}/runtime.json`. `SYSTEM_PROMPT` env
// var, if set, *prepends* to that composition; it no longer replaces it.

// Clean slate for sandboxes on every boot — see CLAUDE.md: state-machine
// recovery is deferred, so any prior threads' containers would be unreachable
// (we'd have lost their tokens) anyway.
await killAllSandboxContainers().catch((err) => {
  log.warn('boot', `sandbox cleanup failed: ${(err as Error).message}`);
});

const { socket, web, botUserId } = await connect(appToken, botToken);
log.info('boot', `connected as bot user ${botUserId}`);

// Announce any in-flight sessions that died with the previous process before
// we start handling new events. listRuntimes() scans data/{thread_key}/runtime.json.
await recoverInterruptedSessions(web).catch((err) => {
  log.warn('boot', `recovery failed: ${(err as Error).message}`);
});

listen(socket, botUserId, makeEventHandler(web, botToken, botUserId, callModel));
listenInteractive(socket);
