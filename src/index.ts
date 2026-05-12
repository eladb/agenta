import { log } from './log';
import { createCallModel } from './model/gateway';
import { makeEventHandler } from './runtime/handler';
import { recoverInterruptedSessions } from './runtime/recovery';
import { killAllSandboxContainers } from './sandbox/docker';
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

const systemPrompt =
  process.env.SYSTEM_PROMPT ??
  [
    'You are agenta, a helpful assistant participating in Slack threads.',
    'Reply concisely and in plain text suitable for Slack.',
    '',
    'File handling rules (strict):',
    '- The user cannot see files you write to /workspace. The ONLY way they see a file is if you call the `share_file` tool with that path.',
    '- If the user asks you to "send", "show", or "share" a file (image, chart, PDF, archive, etc.), you must call `share_file` AFTER you create the file. Writing it alone is not enough.',
    '- Never put fake paths or invented URLs in your reply (e.g. `sandbox://...`, `file://...`, or a markdown image whose target is not a real https URL). The user cannot open those. If you have not called `share_file`, do not pretend the file is delivered.',
    '- After `share_file` succeeds, the file appears inline in the Slack thread. Your final reply should NOT restate the filename, paste a permalink, or otherwise re-announce the file.',
  ].join('\n');

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

listen(socket, botUserId, makeEventHandler(web, botToken, botUserId, callModel, systemPrompt));
listenInteractive(socket);
