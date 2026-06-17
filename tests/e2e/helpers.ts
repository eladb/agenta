import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import { forwardToTenant } from '../../src/bot/forward';
import { decideRoute } from '../../src/bot/routing';
import { openSocketMode } from '../../src/bot/socket';
import { acquire, type Lock } from '../../src/shared/lockfile';
import { log } from '../../src/shared/log';
import type { TenantsConfig } from '../../src/shared/types';
import { teardownSession } from '../../src/tenant/git/bootstrap';
import { startHttp } from '../../src/tenant/http';
import type { ModelTriplet } from '../../src/tenant/runtime/home-config';
import { threadKey as makeThreadKey } from '../../src/tenant/runtime/thread';
import { removeContainer } from '../../src/tenant/sandbox';
import { type MockModelHandle, startMockModel } from './mock-model';

// True iff `docker` is installed AND the sandbox layer is configured to
// use it. Docker-specific assertions (egress block via iptables,
// container teardown, named volumes, uid checks) only make sense when
// docker is the active provider; on Fly the implementations differ and
// these tests will fail spuriously. Standardized here so every test
// file gates on the same condition. Resolve at module load so test.if
// receives a boolean.
function dockerInstalled(): boolean {
  const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    stdio: 'ignore',
  });
  return r.status === 0;
}
const _activeProvider = (process.env.SANDBOX_PROVIDER ?? 'docker').toLowerCase();
export const DOCKER_PROVIDER_ACTIVE = dockerInstalled() && _activeProvider === 'docker';

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

// Post-#253 the legacy in-process `Agent` (one SocketModeClient + one
// WebClient) is replaced by a pair: a bot service holding the real Socket
// Mode connection, and a tenant HTTP server the bot dispatches events to.
// Tests still want a single handle to drive mentions + verify replies, so
// we expose the union: `web` + `botUserId` come from auth.test() on the
// bot xoxb (mentions need them); `socket` + the two locks + the tenant
// server are exposed so afterAll can tear them down cleanly. The shape
// keeps the existing test call sites (`agent.botUserId`, `agent.web`,
// `agent.socket.disconnect()`, `agent.lock.release()`) working without
// per-test churn.
export type Agent = {
  socket: SocketModeClient;
  web: WebClient;
  botUserId: string;
  // The 'bot' (Socket Mode + routing) lockfile. Named `lock` so tests
  // that release+re-acquire across an in-test "restart" stay one-liner.
  lock: Lock;
  // The 'agent' (tenant) lockfile. Held by the in-process tenant for
  // the duration of the test; released alongside `lock` on shutdown.
  // Exposed so tests that simulate a bot restart (sandbox-persistence
  // suite) can release+re-acquire mid-test.
  agentLock: Lock;
  // The tenant HTTP server. Stopped on shutdown so its port is released
  // and the bot's in-flight forwarders unblock.
  tenant: { port: number; stop: () => void };
  // The long-lived mock-model server driving the SDK subprocess via
  // ANTHROPIC_BASE_URL. Tests script it (`mock.setTurns`) + assert on
  // `mock.requests`.
  mock: MockModelHandle;
  // Restores the process env this boot mutated (ANTHROPIC_BASE_URL,
  // ANTHROPIC_API_KEY, CLAUDE_CODE_USE_BEDROCK). Invoked by shutdown/safeShutdown.
  restoreEnv: () => void;
};

export type Tester = {
  socket: SocketModeClient;
  web: WebClient;
  botUserId: string;
  lock: Lock;
};

let dataDir: string | undefined;
let defaultHomeOverride: HomeConfigOverride | undefined;
let defaultHomeDir: string | undefined;

export function setupTempDataDir(): string {
  dataDir = mkdtempSync(join(tmpdir(), 'agenta-e2e-'));
  process.env.AGENTA_DATA_DIR = dataDir;
  // Every e2e mention triggers handler.ts → resolveHome(channelId) →
  // loadHomesConfig, so we need a valid config on disk. Default to a
  // file:// URL pointing at a fresh tmp working tree — tests that need
  // a different shape (https://, a real repo on disk) can install their
  // own via `withTempHomeConfig` before/after this in beforeAll, and the
  // last-installed config wins.
  //
  // The tmpdir must be an initialized non-bare git repo (with at least
  // one commit on `main`) because tunneled-file transport serves it via
  // `git-http-backend`, which 404s on a directory without `.git/`. See
  // #93 — without this, every sandbox-touching e2e test fails with
  // 'repository not found'.
  defaultHomeDir = mkdtempSync(join(tmpdir(), 'agenta-e2e-home-'));
  writeFileSync(join(defaultHomeDir, 'README.md'), 'agenta e2e home\n');
  const gitRun = (...args: string[]): void => {
    const r = spawnSync('git', args, { cwd: defaultHomeDir, stdio: 'ignore' });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed (status ${r.status}) in ${defaultHomeDir}`);
    }
  };
  gitRun('init', '--initial-branch=main', '--quiet');
  gitRun('add', '.');
  gitRun('-c', 'user.email=e2e@agenta', '-c', 'user.name=e2e', 'commit', '-q', '-m', 'initial');
  defaultHomeOverride = withTempHomeConfig(`file://${defaultHomeDir}`);
  return dataDir;
}

// Like `setupTempDataDir`, but seeds the temp home from a checked-in
// fixture directory (e.g. `tests/e2e/fixtures/python-charts-home/`)
// instead of an empty README.md. Used by tests that need specific
// content in the agent home — e.g. `skills-golden.test.ts` needs a
// `python-charts` skill so the prompt builder projects it. The fixture
// dir is copied (not symlinked) so the per-test working tree is
// isolated and can be git-init'd in place.
export function setupTempDataDirFromFixture(fixtureDir: string): string {
  dataDir = mkdtempSync(join(tmpdir(), 'agenta-e2e-'));
  process.env.AGENTA_DATA_DIR = dataDir;
  defaultHomeDir = mkdtempSync(join(tmpdir(), 'agenta-e2e-home-'));
  cpSync(fixtureDir, defaultHomeDir, { recursive: true });
  const gitRun = (...args: string[]): void => {
    const r = spawnSync('git', args, { cwd: defaultHomeDir, stdio: 'ignore' });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed (status ${r.status}) in ${defaultHomeDir}`);
    }
  };
  gitRun('init', '--initial-branch=main', '--quiet');
  gitRun('add', '.');
  gitRun('-c', 'user.email=e2e@agenta', '-c', 'user.name=e2e', 'commit', '-q', '-m', 'initial');
  defaultHomeOverride = withTempHomeConfig(`file://${defaultHomeDir}`);
  return dataDir;
}

export function cleanupTempDataDir(): void {
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
  delete process.env.AGENTA_DATA_DIR;
  if (defaultHomeOverride) {
    defaultHomeOverride.restore();
    defaultHomeOverride = undefined;
  }
  if (defaultHomeDir) {
    rmSync(defaultHomeDir, { recursive: true, force: true });
    defaultHomeDir = undefined;
  }
}

export function getDataDir(): string {
  if (!dataDir) throw new Error('data dir not set; call setupTempDataDir first');
  return dataDir;
}

// Per-test home override (#87, refactored under #253). Under the bot↔tenant
// split the home arrives in each `/events` envelope from the bot's
// `tenants.json` route, so the override feeds the inline route
// `startBotAndTenant` mints. We stash the active spec in a module-level ref;
// `startBotAndTenant` reads it when assembling the inline tenants config (so
// re-installing AFTER `startBotAndTenant` won't retroactively swap the
// route — install the override in `beforeAll` BEFORE `startBotAndTenant`).
export type HomeConfigOverride = {
  restore: () => void;
};

let currentHomeRemote: string | undefined;
let currentHomeAuthEnv: string | undefined;

export function withTempHomeConfig(remote: string, authEnvName?: string): HomeConfigOverride {
  const prevRemote = currentHomeRemote;
  const prevAuthEnv = currentHomeAuthEnv;
  currentHomeRemote = remote;
  currentHomeAuthEnv = authEnvName;
  return {
    restore: () => {
      currentHomeRemote = prevRemote;
      currentHomeAuthEnv = prevAuthEnv;
    },
  };
}

// Wrap connect() with a per-attempt timeout + single retry. Slack
// Socket Mode's apps.connections.open + WSS handshake occasionally
// stalls past 30s with no error (observed in CD 2026-05-19). With the
// run-e2e test-runner timeout at 60s, this gives us two ~20s attempts
// and a clear error message if both fail, instead of an opaque
// beforeAll timeout that leaves `agent` undefined and crashes afterAll.
async function openSocketWithRetry(
  appToken: string,
  onEvent: Parameters<typeof openSocketMode>[1],
): Promise<Awaited<ReturnType<typeof openSocketMode>>> {
  const attemptMs = 20_000;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const pending = openSocketMode(appToken, onEvent);
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(new Error(`socket open timed out after ${attemptMs}ms (attempt ${attempt})`)),
            attemptMs,
          ),
        ),
      ]);
    } catch (err) {
      // The connect may still succeed in the background → an orphaned Socket
      // Mode client. Disconnect it once it settles so two connections never
      // coexist on one app token (Slack churns them → split-brain → dropped
      // events → flaky e2e).
      void pending.then((h) => h.socket.disconnect()).catch(() => {});
      if (attempt === 2) throw err;
      // Brief backoff before retry so Slack has a moment to recover.
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
  throw new Error('unreachable');
}

// Boot the bot+tenant pair in-process for an e2e test (#253). The tenant
// runs as a real HTTP server on a kernel-assigned localhost port; the
// bot builds an inline `tenants.json` that points at it and opens a real
// Socket Mode connection on `SLACK_APP_TOKEN`. Each Slack envelope flows
// the full path: Socket Mode → `decideRoute` → `forwardToTenant` →
// tenant `/events` → `makeEventHandler`. The injected `callModel` is
// threaded through to the tenant's handler so the model gateway is
// stubbed; the real Slack roundtrip is preserved.
//
// We rendezvous on workspace_id at runtime via `auth.test()` so the
// inline route's `team_id` matches whatever workspace the bot is
// authed against (no hardcoded `T0B304AJPUZ`).
//
// Replaces the legacy `startAgent`: the previous helper invoked
// `connect()` + `listen()` from `src/tenant/slack/*`, both removed under
// #253. The returned shape keeps the same fields so test call sites
// don't churn — see `Agent` for the per-field rationale.
export async function startBotAndTenant(): Promise<Agent> {
  const appToken = requireEnv('SLACK_APP_TOKEN');
  const botToken = requireEnv('SLACK_BOT_TOKEN');

  // The SDK is the only harness, so every e2e boot drives a real SDK subprocess
  // pointed at the mock-model server (no real model calls). One e2e process per
  // test file (run-e2e.ts spawns one bun per file), so mutating process.env
  // here is file-scoped + isolated; we still snapshot + restore on shutdown so
  // a `bun test <file>` run that boots twice is clean.
  const saved = {
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    apiKey: process.env.ANTHROPIC_API_KEY,
    bedrock: process.env.CLAUDE_CODE_USE_BEDROCK,
  };
  const restoreEnv = (): void => {
    const restore = (k: string, v: string | undefined): void => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    restore('ANTHROPIC_BASE_URL', saved.baseUrl);
    restore('ANTHROPIC_API_KEY', saved.apiKey);
    restore('CLAUDE_CODE_USE_BEDROCK', saved.bedrock);
  };
  const mock = await startMockModel();
  process.env.ANTHROPIC_BASE_URL = mock.baseUrl;
  // Bedrock OFF — the mock is reached via ANTHROPIC_BASE_URL — and a dummy
  // key so the SDK subprocess has something to send (the mock ignores it).
  delete process.env.CLAUDE_CODE_USE_BEDROCK;
  process.env.ANTHROPIC_API_KEY = 'sdk-e2e-key-not-used';

  // Hold the SAME 'bot' + 'agent' lockfiles the production processes
  // take. Production `bun run start:bot` calls `acquire('bot')`; the
  // tenant calls `acquire('agent')`. Two clients on the same xapp would
  // split-brain Socket Mode delivery (Slack sends each event to exactly
  // one connected client), so if either lock is held we throw with a
  // pid pointer instead of letting tests flake silently.
  const lock = acquire('bot');
  let agentLock: Lock | undefined;
  let tenantHandle: { port: number; stop: () => void } | undefined;
  let socketHandle: Awaited<ReturnType<typeof openSocketMode>> | undefined;
  try {
    agentLock = acquire('agent');

    // Build the tenant's fallback model triplet. The SDK reaches the mock via
    // ANTHROPIC_BASE_URL, so the triplet's `name` is the only field that
    // matters (passed to the SDK as `options.model`; the mock ignores it).
    // `resolveSystemPromptAndModel` freezes the triplet into session.json on
    // first mention. Pin a synthetic api_key_env so envelope validation passes.
    process.env.AGENTA_TEST_STUB_KEY = process.env.AGENTA_TEST_STUB_KEY ?? 'stub-key-not-used';
    const fallbackModel: ModelTriplet = {
      name: 'stub-model',
      base_url: 'http://stub.invalid',
      api_key_env: 'AGENTA_TEST_STUB_KEY',
    };

    // Bot↔tenant shared secret — random per test boot so a leaked
    // value can't be replayed across CI runs. Stashed in env under a
    // unique name so the inline tenants.json can reference it by
    // env-var name (mirroring the production `auth_env` indirection).
    const tenantSecret = randomBytes(16).toString('hex');
    const secretEnvName = `AGENTA_E2E_TENANT_SECRET_${randomBytes(4).toString('hex').toUpperCase()}`;
    process.env[secretEnvName] = tenantSecret;

    // Start the tenant HTTP server on a kernel-assigned localhost port
    // so parallel test files don't collide. `readyRef.value = true`
    // immediately — tests skip the boot-time recovery sweep (it runs
    // against AGENTA_DATA_DIR which is fresh per test). The SDK subprocess
    // reaches the mock-model server via ANTHROPIC_BASE_URL.
    const tenantServer = startHttp({
      port: 0,
      hostname: '127.0.0.1',
      tenantSecret,
      fallbackModel,
      readyRef: { value: true },
    });
    tenantHandle = {
      port: tenantServer.port,
      stop: () => {
        try {
          tenantServer.stop();
        } catch {}
      },
    };

    // Resolve botUserId + team_id from auth.test on the bot xoxb. We
    // need team_id BEFORE opening Socket Mode so the inline route
    // matches the bot's workspace; we don't want to hardcode
    // T0B304AJPUZ in the helper because the dev / ci / canary apps each
    // sit in the same workspace today but could move in the future.
    const web = new WebClient(botToken);
    const auth = await web.auth.test();
    const botUserId = auth.user_id;
    const teamId = auth.team_id;
    if (typeof botUserId !== 'string' || botUserId.length === 0) {
      throw new Error('auth.test did not return user_id for SLACK_BOT_TOKEN');
    }
    if (typeof teamId !== 'string' || teamId.length === 0) {
      throw new Error('auth.test did not return team_id for SLACK_BOT_TOKEN');
    }

    // Assemble the inline tenants.json. Single tenant `e2e` pointing at
    // the loopback tenant; workspace default route into that tenant
    // with the home spec from `withTempHomeConfig`. If a test never
    // called `withTempHomeConfig` before us we fall back to the empty
    // file:// repo `setupTempDataDir` seeded — same defaulting the
    // legacy helper used.
    const homeRemote =
      currentHomeRemote ?? (defaultHomeDir ? `file://${defaultHomeDir}` : undefined);
    if (!homeRemote) {
      throw new Error(
        'startBotAndTenant: no home configured. Call setupTempDataDir or withTempHomeConfig in beforeAll first.',
      );
    }
    const tenantsConfig: TenantsConfig = {
      tenants: {
        e2e: {
          url: `http://127.0.0.1:${tenantServer.port}`,
          auth_env: secretEnvName,
        },
      },
      routes: {
        [teamId]: {
          default: {
            tenant: 'e2e',
            home:
              currentHomeAuthEnv !== undefined
                ? { remote: homeRemote, auth_env: currentHomeAuthEnv }
                : { remote: homeRemote },
          },
        },
      },
    };

    // Bot dispatch loop: same shape as `src/bot/index.ts`'s
    // `routeAndForward`, inlined so we don't have to factor out the
    // production module just for tests. We log failures but never
    // raise — Socket Mode's redelivery is the recovery story.
    const routeAndForward = async (env: Parameters<typeof decideRoute>[0]): Promise<void> => {
      const decision = decideRoute(env, tenantsConfig, botToken);
      if (decision.kind === 'dropped') {
        log.warn(
          'e2e/bot',
          `dropped ${env.envelope_id}: reason=${decision.reason} team=${decision.teamId ?? '?'} channel=${decision.channelId ?? '?'}`,
        );
        return;
      }
      await forwardToTenant(decision.tenant, tenantsConfig, decision.envelope);
    };

    socketHandle = await openSocketWithRetry(appToken, (env) => {
      routeAndForward(env).catch((err) => {
        log.error('e2e/bot', `routeAndForward threw for ${env.envelope_id}: ${err}`);
      });
    });

    return {
      socket: socketHandle.socket,
      web,
      botUserId,
      lock,
      agentLock,
      tenant: tenantHandle,
      mock,
      restoreEnv,
    };
  } catch (err) {
    // Tear down in reverse acquisition order so a partial setup leaves
    // no stray locks / ports behind.
    try {
      await socketHandle?.socket.disconnect();
    } catch {}
    try {
      tenantHandle?.stop();
    } catch {}
    try {
      agentLock?.release();
    } catch {}
    lock.release();
    // Stop the mock server + restore the env we mutated so a failed boot
    // doesn't leak ANTHROPIC_BASE_URL into the next test file.
    try {
      await mock.stop();
    } catch {}
    try {
      restoreEnv();
    } catch {}
    throw err;
  }
}

export async function startTester(): Promise<Tester> {
  // Same split-brain risk for the tester Slack app — only one tester
  // process at a time on the same TEST_BOT_TOKEN.
  const lock = acquire('tester');
  try {
    const web = new WebClient(requireEnv('TEST_BOT_TOKEN'));
    const auth = await web.auth.test();
    if (!auth.user_id) throw new Error('tester auth.test returned no user_id');
    const socket = new SocketModeClient({ appToken: requireEnv('TEST_APP_TOKEN') });
    await socket.start();
    return { web, socket, botUserId: auth.user_id, lock };
  } catch (err) {
    lock.release();
    throw err;
  }
}

export async function mention(
  tester: Tester,
  agentUserId: string,
  channel: string,
  threadTs: string | undefined,
  text: string,
): Promise<string> {
  const res = await tester.web.chat.postMessage({
    channel,
    text: `<@${agentUserId}> ${text}`,
    thread_ts: threadTs,
  });
  if (!res.ts) throw new Error('tester postMessage returned no ts');
  return res.ts;
}

// Upload a file via the tester bot into an existing thread, with a mention of
// the agent. Returns the file_id (use it to locate the file in the thread's
// JSONL after ingest).
export async function uploadFile(
  tester: Tester,
  agentUserId: string,
  channel: string,
  threadTs: string,
  fileBytes: Buffer | Uint8Array,
  filename: string,
  comment: string,
): Promise<string> {
  const res = await tester.web.files.uploadV2({
    channel_id: channel,
    thread_ts: threadTs,
    filename,
    file: Buffer.from(fileBytes),
    initial_comment: `<@${agentUserId}> ${comment}`,
  });
  const top = res.files?.[0] as { id?: string; files?: Array<{ id?: string }> } | undefined;
  const fileId = top?.files?.[0]?.id ?? top?.id;
  if (!fileId) throw new Error('files.uploadV2 returned no file id');
  return fileId;
}

export async function waitForReply(
  tester: Tester,
  channel: string,
  threadTs: string,
  byUserId: string,
  predicate: (text: string) => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<string> {
  // 120s default (raised from 90s, was 45s): docker-in-CI is slower and more
  // contended than the dev-box / Fly environment these waits were tuned for.
  // 90s still flaked — inbound-attachments landed at ~91.7s, sandbox restart at
  // ~65s (#310) — once CD moved e2e to the docker provider (#276). Callers can
  // still pass an explicit timeoutMs for known-slow/-fast steps.
  const timeoutMs = opts.timeoutMs ?? 120000;
  const intervalMs = opts.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await tester.web.conversations.replies({ channel, ts: threadTs });
      const msgs = res.messages ?? [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m && m.user === byUserId && typeof m.text === 'string' && predicate(m.text)) {
          return m.text;
        }
      }
    } catch (err) {
      // Slack hasn't materialized the thread yet (parent has no replies).
      // Keep polling — the bot's reply will create it.
      if (!String((err as Error).message).includes('thread_not_found')) throw err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitForReply timed out after ${timeoutMs}ms`);
}

export async function deleteThread(
  tester: Tester,
  agent: Agent,
  channel: string,
  threadTs: string,
): Promise<void> {
  try {
    const res = await tester.web.conversations.replies({ channel, ts: threadTs });
    const msgs = res.messages ?? [];
    for (const m of msgs) {
      if (!m.ts) continue;
      const client = m.user === agent.botUserId ? agent.web : tester.web;
      await client.chat.delete({ channel, ts: m.ts }).catch(() => {});
    }
  } catch {
    // ignore
  }
  // Tear down per-session git state (git server + WS tunnel) BEFORE the
  // container goes away — otherwise the tunnel's reconnect loop hammers
  // a dead container forever, polluting logs and stealing CPU from the
  // next test in the same file. Mirror the production /delete order
  // (handler.ts: teardownSession + removeContainer).
  const tk = makeThreadKey(channel, threadTs);
  await teardownSession(tk).catch(() => {});
  await removeContainer(tk).catch(() => {});
}

export async function shutdown(agent: Agent, tester: Tester): Promise<void> {
  await Promise.allSettled([agent.socket.disconnect(), tester.socket.disconnect()]);
  // Stop the tenant HTTP server so its port is released before the next
  // test file boots (helper-level state is per-process; the bot↔tenant
  // pair is per-`startBotAndTenant` call).
  try {
    agent.tenant.stop();
  } catch {}
  // Release the per-bot locks so the next test file (in the same process)
  // or the next `bun run e2e` invocation can acquire fresh. Bot AND
  // agent locks: the in-process tenant holds 'agent' for the test's
  // lifetime; the in-process bot holds 'bot'. Releasing both here
  // matches the legacy single-`startAgent` cleanup (which held only
  // 'agent') without leaking the new 'bot' lock between test files.
  agent.lock.release();
  agent.agentLock.release();
  tester.lock.release();
  // SDK mode: stop the mock-model server + restore the mutated process env.
  try {
    await agent.mock?.stop();
  } catch {}
  try {
    agent.restoreEnv?.();
  } catch {}
}

// Tolerant variant for `afterAll`: handles partial setup (one or both of
// agent/tester may be undefined if `beforeAll` timed out or threw before
// both sockets came up). Per-disconnect errors are swallowed so cleanup
// never masks the underlying setup failure.
export async function safeShutdown(
  agent: Agent | undefined,
  tester: Tester | undefined,
): Promise<void> {
  const disconnects: Promise<unknown>[] = [];
  if (agent) disconnects.push(agent.socket.disconnect());
  if (tester) disconnects.push(tester.socket.disconnect());
  await Promise.allSettled(disconnects);
  try {
    agent?.tenant.stop();
  } catch {}
  try {
    agent?.lock.release();
  } catch {}
  try {
    agent?.agentLock.release();
  } catch {}
  try {
    tester?.lock.release();
  } catch {}
  try {
    await agent?.mock?.stop();
  } catch {}
  try {
    agent?.restoreEnv?.();
  } catch {}
}

export async function waitFor(
  check: () => boolean,
  opts: { timeoutMs?: number; intervalMs?: number; what?: string } = {},
): Promise<void> {
  // 120s default — see waitForReply: 90s still flaked under docker-in-CI (#310).
  const timeoutMs = opts.timeoutMs ?? 120000;
  const intervalMs = opts.intervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out${opts.what ? `: ${opts.what}` : ''}`);
}
