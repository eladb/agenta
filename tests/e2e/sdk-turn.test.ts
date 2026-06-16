// Deterministic e2e for the SDK harness turn (#303) via the mock-model seam.
//
// The Claude Agent SDK spawns a real harness subprocess that talks the
// Anthropic Messages wire protocol to `ANTHROPIC_BASE_URL`. We point that at
// `startMockModel` (a local fake `/v1/messages` SSE server) so the model side
// is scripted + deterministic, while EVERYTHING else is real: the in-process
// MCP server wrapping our TOOLS registry, the actual tool execution, the JSONL
// persistence, and the Slack-stream chunk mapping (driven into a recording
// stub driver instead of real Slack).
//
// Two layers:
//   1. No-sandbox tool (`get_current_time`) — always runs. Proves the full
//      runSdkTurn path: mock scripts a tool_use → final text; we assert the
//      tool executed (JSONL tool_call + tool_result) and the Slack-stream
//      chunks (plan header, task card in_progress→complete, final markdown,
//      feedback blocks).
//   2. Full write_file → bash → read_file chain — gated on docker
//      (DOCKER_PROVIDER_ACTIVE), since those tools need the per-thread sandbox.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { WebClient } from '@slack/web-api';
import type { AgentaEvent } from '../../src/tenant/persistence/events';
import { newEventId, nowIso, record } from '../../src/tenant/persistence/events';
import { readEvents } from '../../src/tenant/persistence/store';
import { _resetAsks, getPendingAskByThread } from '../../src/tenant/runtime/asks';
import type { ModelTriplet } from '../../src/tenant/runtime/home-config';
import type { SlackStreamDriver } from '../../src/tenant/runtime/sdk-stream';
import { runSdkTurn } from '../../src/tenant/runtime/sdk-turn';
import { readSession } from '../../src/tenant/runtime/session-store';
import { ensureContainer, removeContainer } from '../../src/tenant/sandbox';
import { DOCKER_PROVIDER_ACTIVE } from './helpers';
import { type MockTurn, startMockModel } from './mock-model';

type Chunk = { type: string; [k: string]: unknown };

function makeDriverStub(): { driver: SlackStreamDriver; appended: Chunk[]; finals: unknown[][] } {
  const appended: Chunk[] = [];
  const finals: unknown[][] = [];
  let opened = false;
  const driver: SlackStreamDriver = {
    ensurePlan: async (title) => {
      if (opened) return;
      opened = true;
      appended.push({ type: 'plan_update', title });
    },
    setPlanTitle: async (title) => {
      appended.push({ type: 'plan_update', title });
    },
    append: async (chunks) => {
      for (const c of chunks) appended.push(c as Chunk);
    },
    finalize: async (blocks) => {
      finals.push(blocks);
    },
  };
  return { driver, appended, finals };
}

const MODEL: ModelTriplet = {
  name: 'claude-sonnet-4-6',
  base_url: 'https://api.anthropic.com/v1',
  api_key_env: 'AGENTA_TEST_STUB_KEY',
};

// These turns never touch Slack (stub driver + non-Slack tools), so the
// WebClient arg is unused — pass a typed-undefined placeholder once.
const NO_WEB = undefined as unknown as WebClient;

let dataDir: string;
// Saved env we mutate so we can restore in afterEach.
let savedBaseUrl: string | undefined;
let savedApiKey: string | undefined;
let savedBedrock: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'agenta-sdke2e-'));
  process.env.AGENTA_DATA_DIR = dataDir;
  savedBaseUrl = process.env.ANTHROPIC_BASE_URL;
  savedApiKey = process.env.ANTHROPIC_API_KEY;
  savedBedrock = process.env.CLAUDE_CODE_USE_BEDROCK;
  // Bedrock OFF for the test — we drive the mock via ANTHROPIC_BASE_URL.
  delete process.env.CLAUDE_CODE_USE_BEDROCK;
  process.env.ANTHROPIC_API_KEY = 'test-key-not-used';
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.AGENTA_DATA_DIR;
  if (savedBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = savedBaseUrl;
  if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedApiKey;
  if (savedBedrock === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK;
  else process.env.CLAUDE_CODE_USE_BEDROCK = savedBedrock;
});

// Seed the triggering user mention into JSONL so runSdkTurn's
// collectUserPrompt has a prompt to send.
async function seedMention(threadKey: string, text: string): Promise<void> {
  await record({
    event_id: newEventId(),
    thread_key: threadKey,
    source: 'slack',
    type: 'message',
    ts: nowIso(),
    ingested_at: nowIso(),
    payload: { slack_event_id: 'Ev1', slack_ts: '1.0', user: 'U1', text },
  });
}

const input = {
  channel: 'C',
  threadTs: '1.0',
  threadKey: 'sdk-e2e-1',
  recipientUserId: 'U1',
  recipientTeamId: 'T1',
};

describe('runSdkTurn via mock model — no-sandbox tool', () => {
  test('scripts get_current_time then a final answer; tool runs, JSONL + chunks correct', async () => {
    const turns: MockTurn[] = [
      {
        text: 'Let me check the current time.',
        toolUses: [{ id: 'tu_time', name: 'mcp__agenta__get_current_time', input: {} }],
      },
      { text: 'It is currently that time. Done.' },
    ];
    const mock = await startMockModel(turns);
    process.env.ANTHROPIC_BASE_URL = mock.baseUrl;

    const { driver, appended, finals } = makeDriverStub();
    try {
      await seedMention(input.threadKey, 'what time is it?');
      await runSdkTurn(NO_WEB, 'you are a test agent', input, undefined, 'task_update', MODEL, {
        driver,
      });
    } finally {
      await mock.stop();
    }

    // The mock saw two POSTs (initial + the tool-result continuation).
    expect(mock.requests.length).toBeGreaterThanOrEqual(2);

    // Slack-stream chunks: plan opened, tool card in_progress → complete, final
    // markdown, finalize with feedback blocks.
    expect(appended[0]?.type).toBe('plan_update');
    const rows = appended.filter((c) => c.type === 'task_update' && c.id === 'tu_time');
    expect(rows.some((r) => r.status === 'in_progress')).toBe(true);
    expect(rows.some((r) => r.status === 'complete')).toBe(true);
    expect(
      appended.some(
        (c) => c.type === 'markdown_text' && String(c.text).includes('It is currently that time'),
      ),
    ).toBe(true);
    expect(finals).toHaveLength(1);

    // JSONL: the tool_call + tool_result for get_current_time were persisted
    // (bare name, not the mcp__agenta__ prefix).
    const events = await readEvents<AgentaEvent>(input.threadKey);
    const toolCall = events.find((e) => e.source === 'assistant' && e.type === 'tool_call');
    expect(toolCall).toBeDefined();
    if (toolCall && toolCall.type === 'tool_call') {
      expect(toolCall.payload.name).toBe('get_current_time');
      expect(toolCall.payload.tool_call_id).toBe('tu_time');
    }
    const toolResult = events.find((e) => e.source === 'assistant' && e.type === 'tool_result');
    expect(toolResult).toBeDefined();
    if (toolResult && toolResult.type === 'tool_result') {
      expect(toolResult.payload.tool_call_id).toBe('tu_time');
      // get_current_time returns an ISO timestamp.
      expect(toolResult.payload.content).toMatch(/\d{4}-\d{2}-\d{2}T/);
    }

    // The SDK session id was captured + persisted for resume.
    const session = await readSession(input.threadKey);
    expect(typeof session?.sdk_session_id).toBe('string');
    expect((session?.sdk_session_id ?? '').length).toBeGreaterThan(0);
  }, 120_000);
});

describe('runSdkTurn via mock model — multi-turn resume', () => {
  test('first turn captures a session id; the second turn resumes it', async () => {
    const tk = 'sdk-e2e-resume';
    const turnInput = { ...input, threadKey: tk };

    // Turn 1: fresh query, captures + persists a session id.
    const mock1 = await startMockModel([{ text: 'first answer' }]);
    process.env.ANTHROPIC_BASE_URL = mock1.baseUrl;
    const { driver: d1 } = makeDriverStub();
    try {
      await seedMention(tk, 'first question');
      await runSdkTurn(NO_WEB, 'sys', turnInput, undefined, 'task_update', MODEL, {
        driver: d1,
      });
    } finally {
      await mock1.stop();
    }
    const afterFirst = await readSession(tk);
    const firstSession = afterFirst?.sdk_session_id;
    expect(typeof firstSession).toBe('string');

    // Turn 2: a new mention. runSdkTurn should pass options.resume = firstSession.
    const mock2 = await startMockModel([{ text: 'second answer' }]);
    process.env.ANTHROPIC_BASE_URL = mock2.baseUrl;
    const { driver: d2 } = makeDriverStub();
    let capturedResume: unknown;
    try {
      await seedMention(tk, 'second question');
      await runSdkTurn(NO_WEB, 'sys', turnInput, undefined, 'task_update', MODEL, {
        driver: d2,
        // Intercept the options to assert resume is threaded; delegate to the
        // real query so the turn still completes against the mock.
        runQuery: ({ prompt, options }) => {
          capturedResume = options.resume;
          // biome-ignore lint/suspicious/noExplicitAny: query() Options is wider than our Record; the SDK validates at runtime
          return query({ prompt, options } as any);
        },
      });
    } finally {
      await mock2.stop();
    }

    expect(capturedResume).toBe(firstSession);
  }, 120_000);
});

// A minimal stub WebClient for ask_user: it only needs chat.postMessage (to
// post the interactive blocks in stream/task_update mode) to return a ts and
// record the posted blocks. Everything else ask_user touches in this path is
// the in-process asks registry.
function makeWebStub(): {
  web: WebClient;
  posted: { text: string; blocks: unknown }[];
} {
  const posted: { text: string; blocks: unknown }[] = [];
  let n = 0;
  const web = {
    chat: {
      postMessage: async (args: { text?: string; blocks?: unknown }) => {
        n += 1;
        posted.push({ text: args.text ?? '', blocks: args.blocks });
        return { ok: true, ts: `ask-ts-${n}` };
      },
    },
  } as unknown as WebClient;
  return { web, posted };
}

async function waitForPendingAsk(
  threadKey: string,
  timeoutMs = 30_000,
): Promise<NonNullable<ReturnType<typeof getPendingAskByThread>>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ask = getPendingAskByThread(threadKey);
    if (ask) return ask;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no pending ask for ${threadKey} after ${timeoutMs}ms`);
}

describe('runSdkTurn via mock model — ask_user (#305)', () => {
  afterEach(() => {
    _resetAsks();
  });

  test('asks a buttons question, an out-of-band resolve feeds the answer back as the tool_result', async () => {
    const tk = 'sdk-e2e-ask';
    const askInput = { ...input, threadKey: tk };
    const turns: MockTurn[] = [
      {
        text: 'I need to know which color you prefer.',
        toolUses: [
          {
            id: 'tu_ask',
            name: 'mcp__agenta__ask_user',
            input: {
              question: 'Which color?',
              kind: 'buttons',
              options: ['red', 'green', 'blue'],
            },
          },
        ],
      },
      { text: 'Great, going with green.' },
    ];
    const mock = await startMockModel(turns);
    process.env.ANTHROPIC_BASE_URL = mock.baseUrl;

    const { driver, appended, finals } = makeDriverStub();
    const { web, posted } = makeWebStub();

    try {
      await seedMention(tk, 'pick a color');
      // ask_user BLOCKS inside the MCP handler, so don't await the turn yet —
      // resolve the pending ask out of band, then await completion.
      const turnDone = runSdkTurn(
        web,
        'you are a test agent',
        askInput,
        undefined,
        'task_update',
        MODEL,
        {
          driver,
        },
      );
      const ask = await waitForPendingAsk(tk);
      ask.resolve('green');
      await turnDone;
    } finally {
      await mock.stop();
    }

    // The interactive blocks were posted as a separate thread message (#285
    // stream-mode contract).
    expect(posted.length).toBeGreaterThanOrEqual(1);
    expect(posted[0]?.text).toBe('Which color?');

    // modelContent threading: the model's reasoning text from this iteration is
    // prepended as a section above the question/controls (#305 part-4), so the
    // user keeps the reasoning visible alongside the choices.
    const blocks = (posted[0]?.blocks ?? []) as { text?: { text?: string } }[];
    expect(blocks[0]?.text?.text).toBe('I need to know which color you prefer.');

    // The chosen answer reached the model as the tool_result for tu_ask.
    const events = await readEvents<AgentaEvent>(tk);
    const askCall = events.find(
      (e) =>
        e.source === 'assistant' && e.type === 'tool_call' && e.payload.tool_call_id === 'tu_ask',
    );
    expect(askCall).toBeDefined();
    if (askCall && askCall.type === 'tool_call') {
      expect(askCall.payload.name).toBe('ask_user');
    }
    const askResult = events.find(
      (e) =>
        e.source === 'assistant' && e.type === 'tool_result' && e.payload.tool_call_id === 'tu_ask',
    );
    expect(askResult).toBeDefined();
    if (askResult && askResult.type === 'tool_result') {
      expect(askResult.payload.content).toBe('green');
    }

    // The mock saw the tool_result content as a user message on the continuation.
    const flat = JSON.stringify(mock.requests);
    expect(flat).toContain('green');

    // The ❓ card rendered (in_progress) and completed (the answer as detail).
    const askRows = appended.filter((c) => c.type === 'task_update' && c.id === 'tu_ask');
    expect(askRows.some((r) => String(r.title ?? '').includes('❓ Asking: Which color?'))).toBe(
      true,
    );
    expect(askRows.some((r) => r.status === 'in_progress')).toBe(true);
    const done = askRows.find((r) => r.status === 'complete');
    expect(done).toBeDefined();
    expect(String(done?.details ?? '')).toContain('green');

    // The turn completed (final markdown + finalize).
    expect(
      appended.some((c) => c.type === 'markdown_text' && String(c.text).includes('green')),
    ).toBe(true);
    expect(finals).toHaveLength(1);
  }, 120_000);

  test('/stop while an ask is pending rejects the ask so the turn unwinds', async () => {
    const tk = 'sdk-e2e-ask-stop';
    const askInput = { ...input, threadKey: tk };
    const turns: MockTurn[] = [
      {
        text: 'Asking before stop.',
        toolUses: [
          {
            id: 'tu_ask2',
            name: 'mcp__agenta__ask_user',
            input: { question: 'Proceed?', kind: 'buttons', options: ['yes', 'no'] },
          },
        ],
      },
      { text: 'unused' },
    ];
    const mock = await startMockModel(turns);
    process.env.ANTHROPIC_BASE_URL = mock.baseUrl;

    const { driver } = makeDriverStub();
    const { web } = makeWebStub();
    const ac = new AbortController();

    try {
      await seedMention(tk, 'proceed?');
      const turnDone = runSdkTurn(web, 'sys', askInput, ac.signal, 'task_update', MODEL, {
        driver,
      });
      await waitForPendingAsk(tk);
      // Simulate /stop: aborting the turn signal must reject the pending ask
      // (ask_user's onAbort) so the handler unblocks and the turn returns.
      ac.abort();
      await turnDone; // must not hang
    } finally {
      await mock.stop();
    }

    // The ask was settled (registry cleared) — no leak, the handler unblocked.
    // (ask_user's onAbort calls reject('cancelled') the instant the signal
    // fires; the await on `turnDone` above returning at all proves the MCP
    // handler stopped blocking. Under abort the SDK tears the MCP stream down,
    // so the tool_result the SDK ultimately records for this call may be its
    // own "stream closed" message rather than our 'cancelled' string — the
    // contract here is "the turn unwinds and the registry is clean", not the
    // exact tool_result text.)
    expect(getPendingAskByThread(tk)).toBeUndefined();
  }, 120_000);
});

describe('runSdkTurn via mock model — full sandbox tool chain', () => {
  beforeAll(() => {
    if (!DOCKER_PROVIDER_ACTIVE) {
      console.log('skipping SDK sandbox-chain e2e: docker provider not active');
    }
  });
  afterAll(async () => {
    if (DOCKER_PROVIDER_ACTIVE) await removeContainer('sdk-e2e-chain').catch(() => {});
  });

  test.if(DOCKER_PROVIDER_ACTIVE)(
    'write_file → bash → read_file all execute against the real sandbox',
    async () => {
      const chainInput = { ...input, threadKey: 'sdk-e2e-chain' };
      const turns: MockTurn[] = [
        {
          text: 'Writing the file.',
          toolUses: [
            {
              id: 'tu_w',
              name: 'mcp__agenta__write_file',
              input: { path: 'note.txt', content: 'hello sdk\n' },
            },
          ],
        },
        {
          text: 'Listing via bash.',
          toolUses: [{ id: 'tu_b', name: 'mcp__agenta__bash', input: { command: 'cat note.txt' } }],
        },
        {
          text: 'Reading the file back.',
          toolUses: [{ id: 'tu_r', name: 'mcp__agenta__read_file', input: { path: 'note.txt' } }],
        },
        { text: 'The file contains: hello sdk' },
      ];
      const mock = await startMockModel(turns);
      process.env.ANTHROPIC_BASE_URL = mock.baseUrl;

      const { driver, appended } = makeDriverStub();
      try {
        // Pre-provision the sandbox so the tools find a ready container.
        await ensureContainer(chainInput.threadKey);
        await seedMention(chainInput.threadKey, 'write hello sdk to note.txt and read it back');
        await runSdkTurn(
          NO_WEB,
          'you are a test agent',
          chainInput,
          undefined,
          'task_update',
          MODEL,
          {
            driver,
          },
        );
      } finally {
        await mock.stop();
      }

      // All three tool cards completed.
      for (const id of ['tu_w', 'tu_b', 'tu_r']) {
        const rows = appended.filter((c) => c.type === 'task_update' && c.id === id);
        expect(rows.some((r) => r.status === 'complete')).toBe(true);
      }

      // bash card output carries the file contents.
      const bashRow = appended.find(
        (c) => c.type === 'task_update' && c.id === 'tu_b' && c.status === 'complete',
      );
      expect(String(bashRow?.details ?? '')).toContain('hello sdk');

      // JSONL records all three tool results, and the read result has the content.
      const events = await readEvents<AgentaEvent>(chainInput.threadKey);
      const results = events.filter((e) => e.source === 'assistant' && e.type === 'tool_result');
      expect(results.length).toBeGreaterThanOrEqual(3);
      const readResult = events.find(
        (e) =>
          e.source === 'assistant' && e.type === 'tool_result' && e.payload.tool_call_id === 'tu_r',
      );
      expect(readResult).toBeDefined();
      if (readResult && readResult.type === 'tool_result') {
        expect(readResult.payload.content).toContain('hello sdk');
      }
    },
    180_000,
  );
});
