#!/usr/bin/env bun
// Smoke test for the production agenta bot.
//
//   bun run canary
//
// Posts mentions via the tester bot into TEST_CHANNEL_ID and asserts the
// running agent (assumed external, e.g. `bun start` on the user's machine
// or on Fly) handles each step. Exits 0 on green, 1 on red with the
// failing step on stderr.
//
// Steps (Smoke scope):
//   1. Plain mention 'hi'                       -> reply lands
//   2. Bash 'echo hello > ~/canary && cat ~/canary' -> reply contains 'hello'
//   3. /delete                                  -> 'deleted' reply + data dir removed on host
//
// Required env (the agent must already be running with these set):
//   SLACK_BOT_TOKEN       - agent's bot token (used here only to resolve the agent's bot_user_id)
//   TEST_APP_TOKEN        - tester app-level token (Socket Mode)
//   TEST_BOT_TOKEN        - tester bot token
//   TEST_CHANNEL_ID       - channel both bots are invited to
//
// Reuses helpers from tests/e2e to keep the wire-level logic in one place.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { WebClient } from '@slack/web-api';
import { threadKey as makeThreadKey } from '../src/runtime/thread';
import { mention, requireEnv, startTester, waitForReply } from '../tests/e2e/helpers';

const STEP_TIMEOUT_MS = 60_000;
const FLY_HEALTH_TIMEOUT_MS = 120_000;

function dataDir(): string {
  return process.env.AGENTA_DATA_DIR ?? join(process.cwd(), 'data');
}

// Polls the Fly Machines API until every machine in the app is `started`
// with all health checks passing. Ensures we don't fire canary steps at a
// half-rolled release. No-op when FLY_API_TOKEN / FLY_APP_NAME are unset
// (local dev against a long-running bot).
async function waitForFlyHealth(): Promise<void> {
  const token = process.env.FLY_API_TOKEN;
  const app = process.env.FLY_APP_NAME;
  if (!token || !app) {
    process.stderr.write('canary: skipping Fly health wait (FLY_API_TOKEN/FLY_APP_NAME unset)\n');
    return;
  }
  const url = `https://api.machines.dev/v1/apps/${app}/machines`;
  const deadline = Date.now() + FLY_HEALTH_TIMEOUT_MS;
  let lastSummary = '';
  while (Date.now() < deadline) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      lastSummary = `HTTP ${res.status}`;
    } else {
      const machines = (await res.json()) as Array<{
        id: string;
        state: string;
        checks?: Array<{ status: string }>;
      }>;
      const summary = machines
        .map((m) => {
          const checks = m.checks ?? [];
          const passing = checks.filter((c) => c.status === 'passing').length;
          return `${m.id}=${m.state}(${passing}/${checks.length})`;
        })
        .join(',');
      const allReady =
        machines.length > 0 &&
        machines.every(
          (m) =>
            m.state === 'started' &&
            (m.checks ?? []).length > 0 &&
            (m.checks ?? []).every((c) => c.status === 'passing'),
        );
      if (allReady) {
        process.stderr.write(`canary: Fly health OK (${summary})\n`);
        return;
      }
      lastSummary = summary;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(
    `Fly health did not converge within ${FLY_HEALTH_TIMEOUT_MS}ms; last=${lastSummary}`,
  );
}

async function agentBotUserId(): Promise<string> {
  // Prefer an explicit env var so canary can run from a host whose `.env`
  // doesn't carry the prod agent's xoxb-/xapp- credentials (e.g. dev hosts
  // where having prod's SLACK_APP_TOKEN would split-brain Socket Mode).
  // Falls back to auth.test for backwards compat with CD, where
  // SLACK_BOT_TOKEN is a GitHub secret.
  const explicit = process.env.CANARY_TARGET_USER_ID;
  if (explicit && explicit.length > 0) return explicit;
  const web = new WebClient(requireEnv('SLACK_BOT_TOKEN'));
  const auth = await web.auth.test();
  if (!auth.user_id) throw new Error('agent auth.test returned no user_id');
  return auth.user_id;
}

type StepResult = { name: string; ok: boolean; detail: string; elapsedMs: number };

async function step(
  name: string,
  fn: () => Promise<string>,
): Promise<StepResult> {
  process.stderr.write(`canary: step "${name}" start\n`);
  const t0 = Date.now();
  try {
    const detail = await fn();
    process.stderr.write(`canary: step "${name}" OK: ${detail}\n`);
    return { name, ok: true, detail, elapsedMs: Date.now() - t0 };
  } catch (err) {
    const msg = (err as Error).message;
    process.stderr.write(`canary: step "${name}" FAIL: ${msg}\n`);
    return { name, ok: false, detail: msg, elapsedMs: Date.now() - t0 };
  }
}

async function main(): Promise<void> {
  process.stderr.write('canary: resolving env + agent user...\n');
  const channel = requireEnv('TEST_CHANNEL_ID');
  await waitForFlyHealth();
  const agentUser = await agentBotUserId();
  process.stderr.write(`canary: agent user = ${agentUser}; channel = ${channel}\n`);
  const tester = await startTester();
  process.stderr.write(`canary: tester connected\n`);

  const results: StepResult[] = [];
  let threadTs: string | undefined;
  let tk: string | undefined;

  let abort = false;
  try {
    // ── Step 1: plain mention ───────────────────────────────────────────
    const s1 = await step('chat reply', async () => {
      threadTs = await mention(tester, agentUser, channel, undefined, 'canary: say hi');
      tk = makeThreadKey(channel, threadTs);
      const reply = await waitForReply(
        tester,
        channel,
        threadTs,
        agentUser,
        // Any non-empty reply from the agent counts. The "thinking…" placeholder
        // is also a reply from the agent, so wait for it to mutate into prose.
        (text) => text.length > 0 && !text.includes('thinking…') && !text.includes('•'),
        { timeoutMs: STEP_TIMEOUT_MS },
      );
      return `reply length ${reply.length}`;
    });
    results.push(s1);
    if (!s1.ok) abort = true;

    // ── Step 2: bash + cat ──────────────────────────────────────────────
    if (!abort) {
      const s2 = await step('bash + cat', async () => {
        if (!threadTs) throw new Error('no threadTs from step 1');
        await mention(
          tester,
          agentUser,
          channel,
          threadTs,
          'run: `echo hello-canary > ~/canary.txt && cat ~/canary.txt` and tell me the file content',
        );
        const reply = await waitForReply(
          tester,
          channel,
          threadTs,
          agentUser,
          (text) => text.toLowerCase().includes('hello-canary'),
          { timeoutMs: STEP_TIMEOUT_MS },
        );
        return `reply contains marker (${reply.length} chars)`;
      });
      results.push(s2);
      if (!s2.ok) abort = true;
    }

    // ── Step 3: /delete + verify on-host cleanup ────────────────────────
    if (!abort) {
      const s3 = await step('/delete cleanup', async () => {
        if (!threadTs || !tk) throw new Error('no threadTs/tk from earlier steps');
        await mention(tester, agentUser, channel, threadTs, '/delete');
        await waitForReply(
          tester,
          channel,
          threadTs,
          agentUser,
          (text) => text.toLowerCase().startsWith('deleted'),
          { timeoutMs: STEP_TIMEOUT_MS },
        );
        const threadDir = join(dataDir(), tk);
        // Slack/delete is async w/r/t the on-host rm. Wait briefly.
        const deadline = Date.now() + 5000;
        while (existsSync(threadDir) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 200));
        }
        if (existsSync(threadDir)) {
          throw new Error(`thread dir still exists after /delete: ${threadDir}`);
        }
        return 'thread dir gone';
      });
      results.push(s3);
    }
  } finally {
    process.stderr.write(`canary: entering finally (${results.length} step results)\n`);
    const ranDelete = results.some((r) => r.name === '/delete cleanup' && r.ok);
    if (!ranDelete && threadTs) {
      process.stderr.write('canary: best-effort /delete cleanup...\n');
      await mention(tester, agentUser, channel, threadTs, '/delete').catch(() => {});
    }
    process.stderr.write('canary: disconnecting tester...\n');
    await tester.socket.disconnect().catch(() => {});
    process.stderr.write('canary: tester disconnected\n');
  }

  const allOk = results.every((r) => r.ok) && results.length === 3;
  process.stderr.write(`canary: summary (allOk=${allOk}):\n`);
  for (const r of results) {
    const status = r.ok ? 'OK ' : 'FAIL';
    process.stderr.write(`[${status}] ${r.name} (${r.elapsedMs}ms): ${r.detail}\n`);
  }
  if (!allOk) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('canary failed unexpectedly:', (err as Error).message);
  process.exit(1);
});
