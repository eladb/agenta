import { log } from './log';
import { createCallModel } from './model/gateway';
import { makeEventHandler } from './runtime/handler';
import { connect } from './slack/connect';
import { listen } from './slack/events';

const appToken = process.env.SLACK_APP_TOKEN;
const botToken = process.env.SLACK_BOT_TOKEN;
const modelApiKey = process.env.ANTHROPIC_API_KEY;

if (!appToken || !botToken) {
  log.error('boot', 'SLACK_APP_TOKEN and SLACK_BOT_TOKEN required (see .env.example)');
  process.exit(1);
}
if (!modelApiKey) {
  log.error('boot', 'ANTHROPIC_API_KEY required (see .env.example)');
  process.exit(1);
}

const callModel = createCallModel({
  apiKey: modelApiKey,
  baseUrl: process.env.MODEL_BASE_URL ?? 'https://api.anthropic.com/v1',
  model: process.env.MODEL_NAME ?? 'claude-sonnet-4-6',
});

const systemPrompt =
  process.env.SYSTEM_PROMPT ??
  'You are agenta, a helpful assistant participating in Slack threads. Reply concisely and in plain text suitable for Slack.';

const { socket, web, botUserId } = await connect(appToken, botToken);
log.info('boot', `connected as bot user ${botUserId}`);
listen(socket, botUserId, makeEventHandler(web, botToken, botUserId, callModel, systemPrompt));
