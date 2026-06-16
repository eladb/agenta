#!/usr/bin/env bun
// Wrapper around `bun test tests/e2e` that gives every run its own
// dedicated Slack channel. Avoids leftover messages bleeding between
// runs and makes each run easy to inspect in isolation.
//
// Flow:
//   1. Create channel `agenta-e2e-<YYMMDDhhmmss>-<rand>` as the tester
//      bot (needs channels:manage + channels:write.invites).
//   2. Invite the agent bot user into the channel (auth.test on the
//      agent token gives us the user id).
//   3. spawn `bun test --timeout 30000 tests/e2e` with the new channel
//      id exported as TEST_CHANNEL_ID.
//   4. Archive the channel — success, failure, or signal.
//
// Slack doesn't expose hard channel delete via API; archive is the
// cleanup. Archived channels stay in the workspace but disappear from
// the active list.

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { WebClient } from '@slack/web-api';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

function channelName(): string {
  const t = new Date();
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  const stamp =
    `${String(t.getUTCFullYear()).slice(2)}` +
    `${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}` +
    `${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}${pad(t.getUTCSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 6);
  return `agenta-e2e-${stamp}-${rand}`;
}

async function botUserId(token: string, label: string): Promise<string> {
  const auth = await new WebClient(token).auth.test();
  if (!auth.user_id) throw new Error(`${label} auth.test returned no user_id`);
  return auth.user_id;
}

const testerToken = requireEnv('TEST_BOT_TOKEN');
const agentToken = requireEnv('SLACK_BOT_TOKEN');

const tester = new WebClient(testerToken);
const name = channelName();

console.log(`run-e2e: creating channel #${name}`);
const created = await tester.conversations.create({ name, is_private: false });
if (!created.ok || !created.channel?.id) {
  console.error('conversations.create failed:', created.error);
  process.exit(1);
}
const channelId = created.channel.id;

let archived = false;
const archiveOnce = async (): Promise<void> => {
  if (archived) return;
  archived = true;
  try {
    await tester.conversations.archive({ channel: channelId });
    console.log(`run-e2e: archived #${name}`);
  } catch (err) {
    console.error(`run-e2e: archive failed (${(err as Error).message}); manual cleanup needed`);
  }
};

// Make sure we archive on Ctrl-C / SIGTERM too.
const signalHandler = (sig: NodeJS.Signals): void => {
  archiveOnce()
    .catch(() => {})
    .finally(() => {
      process.kill(process.pid, sig);
    });
};
process.on('SIGINT', signalHandler);
process.on('SIGTERM', signalHandler);

try {
  const agentUser = await botUserId(agentToken, 'agent');
  await tester.conversations.invite({ channel: channelId, users: agentUser });
  console.log(`run-e2e: invited agent (${agentUser})`);

  // Run each test file in its own bun process, sequentially. Bun's
  // default test parallelism would have multiple files contending for
  // the per-bot lockfile (and the underlying Slack socket) inside one
  // process. One file per process = one lock holder at a time.
  const testFiles = readdirSync(join(import.meta.dir, '..', 'tests/e2e'))
    .filter((f) => f.endsWith('.test.ts'))
    .sort();
  console.log(`run-e2e: ${testFiles.length} test files to run sequentially`);

  let firstFailExit = 0;
  for (const file of testFiles) {
    const relPath = `tests/e2e/${file}`;
    console.log(`\nrun-e2e: → ${relPath}`);
    const code: number = await new Promise((resolve) => {
      // 180s per-test timeout: covers docker sandbox cold starts on a
      // contended CI runner plus the connectWithRetry path in startAgent
      // (~42s if the first attempt stalls). Raised to 240s alongside the 120s
      // helpers waitFor/waitForReply defaults (#276 docker-in-CI move, #310) —
      // a tighter cap would kill a test before its 120s wait could resolve.
      const child = spawn('bun', ['test', '--timeout', '240000', relPath], {
        stdio: 'inherit',
        env: { ...process.env, TEST_CHANNEL_ID: channelId },
      });
      child.on('exit', (c) => resolve(c ?? 1));
      child.on('error', (err) => {
        console.error('run-e2e: child spawn error:', err.message);
        resolve(1);
      });
    });
    if (code !== 0 && firstFailExit === 0) firstFailExit = code;
  }

  await archiveOnce();
  process.exit(firstFailExit);
} catch (err) {
  console.error('run-e2e: setup failed:', (err as Error).message);
  await archiveOnce();
  process.exit(1);
}
