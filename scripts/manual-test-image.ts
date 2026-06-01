#!/usr/bin/env bun
// One-off manual test: posts a mention with a tiny PNG attached via the tester
// bot. Use to validate the agent's file-share -> download -> detectMime ->
// model path end-to-end with a real image.

import { readFileSync } from 'node:fs';
import { WebClient } from '@slack/web-api';

const testerToken = process.env.TEST_BOT_TOKEN;
const agentToken = process.env.SLACK_BOT_TOKEN;
const channel = process.env.TEST_CHANNEL_ID;
const imagePath = process.env.TEST_IMAGE_PATH ?? '/usr/share/httpd/icons/compressed.png';

if (!testerToken || !agentToken || !channel) {
  console.error('need TEST_BOT_TOKEN, SLACK_BOT_TOKEN, TEST_CHANNEL_ID in env');
  process.exit(1);
}

const png = readFileSync(imagePath);

const agentWeb = new WebClient(agentToken);
const auth = await agentWeb.auth.test();
const agentUserId = auth.user_id;
if (!agentUserId) throw new Error('failed to look up agent user_id');

const tester = new WebClient(testerToken);
console.log(
  `uploading ${imagePath} (${png.byteLength} bytes) to ${channel} as a mention of <@${agentUserId}>...`,
);
const res = await tester.files.uploadV2({
  channel_id: channel,
  filename: 'test.png',
  file: png,
  initial_comment: `<@${agentUserId}> what is in this image?`,
});
const ok = res.files?.[0]?.files?.[0]?.id;
console.log(`uploaded file id=${ok ?? 'unknown'}`);
