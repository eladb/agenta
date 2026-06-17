// runSdkTurn — the Claude Agent SDK harness turn (#282/#315). The SDK is the
// only harness; this is the one and only turn implementation. It:
//   - wraps the existing TOOLS registry as an in-process MCP server
//     (`buildAgentaMcpServer`) so the SDK drives our real sandbox / fs / git
//     tools and NOTHING else (native tools off: `tools: []`,
//     `allowedTools: ['mcp__agenta__*']`);
//   - runs the SDK `query()` with the per-thread frozen system prompt (rebuilt
//     every mention — preserves prompt-unfrozen) + model;
//   - maps the SDK message stream onto the Slack streaming display via
//     `consumeSdkStream` (sdk-stream.ts);
//   - persists assistant / tool_call / tool_result events to JSONL as it
//     streams so debug-thread + recovery keep working;
//   - multi-turns via SDK session resume: the SDK `session_id` is captured from
//     the stream and persisted on session.json (`sdk_session_id`); later turns
//     in the thread pass `options.resume`.
//   - /stop aborts the query via the AbortSignal (an AbortController fed to the
//     SDK). 🤔 stays handler-owned.
//
// Model endpoint comes from process env, NOT hardcoded: runtime sets
// `CLAUDE_CODE_USE_BEDROCK=1` (so `options.model` is a Bedrock model id);
// tests set `ANTHROPIC_BASE_URL` to the mock-model server. We strip a leading
// `bedrock://` from the triplet's model id and always set
// `DISABLE_PROMPT_CACHING=1` in the SDK process env.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { WebClient } from '@slack/web-api';
import { log } from '../../shared/log';
import { buildAgentaMcpServer } from '../model/sdk/mcp-tools';
import { ASK_TIMEOUT_MS } from '../model/tools/ask-user';
import type { ToolContext } from '../model/tools/types';
import type { AgentaEvent, AttachmentRef } from '../persistence/events';
import { newEventId, nowIso, record } from '../persistence/events';
import { dataRoot, readEvents } from '../persistence/store';
import { postInThread } from '../slack/post';
import { parseCommand } from './commands';
import type { ModelTriplet } from './home-config';
import { redact } from './redact';
import { buildUserContent } from './sdk-attachments';
import {
  consumeSdkStream,
  makeWebStreamDriver,
  type SdkStreamRecorder,
  type SlackStreamDriver,
} from './sdk-stream';
import type { TurnInput } from './session';
import { readSession, setSdkSessionId } from './session-store';

// Generous turn cap — the SDK counts each model round-trip; agentic tool chains
// can take several. Mirrors the spike's 12 with headroom.
const MAX_TURNS = 20;

// Strip a `bedrock://` scheme prefix from a model id if present. The frozen
// per-thread triplet may carry `bedrock://us.anthropic.claude-...`; the SDK
// wants the bare model id and learns the backend from `CLAUDE_CODE_USE_BEDROCK`.
export function stripBedrockScheme(model: string): string {
  return model.replace(/^bedrock:\/\//, '');
}

// The Claude Agent SDK parses any prompt that starts with `/` as a slash
// command — it's intercepted ("/<x> isn't available in this environment") and
// never reaches the model. agenta's own commands (/stop, /delete, …) are
// resolved by the handler before we ever build a turn, so a leading `/` here is
// real user text (e.g. "/etc/hosts", "/deploy the thing"). Prefix a zero-width
// space so the prompt no longer starts with `/`: the SDK skips slash parsing and
// the model sees effectively the same text (U+200B is invisible and not
// stripped by the SDK's leading-`/` check). Only the SDK prompt is guarded —
// the JSONL/Slack record keeps the user's verbatim text.
const ZERO_WIDTH_SPACE = '\u200B';
export function guardLeadingSlash(text: string): string {
  return text.startsWith('/') ? `${ZERO_WIDTH_SPACE}${text}` : text;
}

// Collect the user input for this turn from JSONL: the trailing run of slack
// `message` events (skipping slash-commands), i.e. everything the user said
// since the last assistant/tool activity, plus any files attached to those
// messages. On a fresh thread that's the triggering mention (+ any backfilled
// context); on a resumed thread it's the new input. Resume carries prior
// context inside the SDK session itself.
export async function collectUserTurn(
  threadKey: string,
): Promise<{ text: string; files: AttachmentRef[] }> {
  const events = await readEvents<AgentaEvent>(threadKey);
  // Walk backwards; collect contiguous trailing slack user messages until we
  // hit an assistant message / tool event. A message counts toward the turn if
  // it carries non-command text OR files (an attachment-only upload has text:'').
  const texts: string[] = [];
  const files: AttachmentRef[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e) continue;
    if (e.source === 'assistant') break;
    if (e.source === 'slack' && e.type === 'message') {
      const text = e.payload.text;
      const msgFiles = e.payload.files ?? [];
      const hasText = typeof text === 'string' && text.length > 0 && parseCommand(text) === null;
      if (hasText) texts.unshift(text);
      if (msgFiles.length > 0) files.unshift(...msgFiles);
    }
  }
  if (texts.length > 0 || files.length > 0) {
    return { text: texts.join('\n\n'), files };
  }
  // Fallback: nothing trailing (e.g. all prior msgs already consumed in a
  // resumed session but the new mention text was a command). Use the very last
  // non-command user message so the SDK always gets a non-empty prompt.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.source === 'slack' && e.type === 'message') {
      const text = e.payload.text;
      if (typeof text === 'string' && text.length > 0 && parseCommand(text) === null) {
        return { text, files: e.payload.files ?? [] };
      }
    }
  }
  return { text: '(no user message)', files: [] };
}

// The SDK's default stream-close timeout is 60s (sdk.d.ts:483) — if an
// in-process MCP call runs longer the SDK tears the stream down. ask_user
// blocks for *human* time (up to ASK_TIMEOUT_MS = 10min), so we raise the
// stream-close timeout comfortably above it. Value is in milliseconds (the
// SDK's *_TIMEOUT env vars are ms; the doc's "60s" default = 60000ms).
const STREAM_CLOSE_TIMEOUT_MS = ASK_TIMEOUT_MS + 60_000;

// Where the SDK persists each session's transcript JSONL (#308). The SDK reads
// `query({resume})` from a file under CLAUDE_CONFIG_DIR/projects/<cwd>/<id>.jsonl;
// its default is the ephemeral ~/.claude, lost when the tenant container is
// replaced. Pinning it under the tenant's persistent data volume makes
// `resume: sdk_session_id` survive a tenant restart — the SDK session IS the
// model-context store for the SDK harness (our JSONL stays canonical for
// display/audit). Created eagerly so the SDK never races on a missing dir.
function sdkConfigDir(): string {
  const dir = join(dataRoot(), '.claude');
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Build the SDK process env: inherit process.env (so PATH/HOME/AWS creds +
// CLAUDE_CODE_USE_BEDROCK / ANTHROPIC_BASE_URL pass through) and force
// DISABLE_PROMPT_CACHING. The `env` option REPLACES the subprocess env when
// set, so we spread process.env explicitly.
function buildSdkEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    DISABLE_PROMPT_CACHING: '1',
    // Keep the stream open while ask_user blocks on a human (see above).
    CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: String(STREAM_CLOSE_TIMEOUT_MS),
    // Persist SDK sessions on the data volume so resume survives a restart.
    CLAUDE_CONFIG_DIR: sdkConfigDir(),
  };
}

export async function runSdkTurn(
  web: WebClient,
  systemPrompt: string,
  input: TurnInput,
  signal: AbortSignal | undefined,
  model: ModelTriplet,
  // Test seams (optional): inject a stream driver + recorder + a `query`
  // override so the turn is unit/e2e testable without a real Slack stream.
  // Production passes none — the WebClient driver + JSONL recorder are built.
  overrides?: {
    driver?: SlackStreamDriver;
    recorder?: SdkStreamRecorder;
    // biome-ignore lint/suspicious/noExplicitAny: query() return type is the SDK Query (async-iterable + control methods)
    runQuery?: (params: {
      prompt: string | AsyncIterable<unknown>;
      options: Record<string, unknown>;
    }) => any;
  },
): Promise<void> {
  const channel = input.channel;
  const threadTs = input.threadTs;

  // The 🤔 reaction is handler-owned (session.ts:markThinking). We only manage
  // the steering reaction here — but v1 SDK turns are boundary-only with no
  // mid-turn steering injection, so there are no reactions to add/clear beyond
  // what the handler owns. Kept minimal.

  // Latest assistant text seen this turn, threaded into ask_user's ctx.modelContent
  // so the question message keeps the model's reasoning above the controls (as
  // the bespoke harness does). Best-effort: the recorder's onAssistantText
  // updates it; ctxFactory reads it. If the model emits no text before calling
  // ask_user it stays empty and ask_user renders the bare controls.
  let latestAssistantText = '';

  // Per-invocation ToolContext factory. Each tool call gets a fresh context
  // threading the turn's Slack handles + the abort signal (the signal is
  // forwarded by buildAgentaMcpServer to every tool invoke).
  const ctxFactory = (): ToolContext => ({
    threadKey: input.threadKey,
    web,
    channel,
    threadTs,
    ...(latestAssistantText.length > 0 ? { modelContent: latestAssistantText } : {}),
    // onProgress (bash live output) is optional for v1 — the SDK streams
    // tool_result frames atomically, so we render the final card body. Wiring
    // incremental bash output would require a side channel; deferred.
  });

  const mcpServer = buildAgentaMcpServer(ctxFactory, signal);

  // Resume if we have a stored SDK session id for this thread.
  const existing = await readSession(input.threadKey);
  const resume = existing?.sdk_session_id;

  // Build the turn's user input. Text-only turns use the SDK string-prompt fast
  // path; turns with attachments switch to streaming-input mode (an async
  // iterable yielding one native multimodal user message — images/PDFs inline as
  // base64 blocks, text files inline, all with a `[attached:]` sandbox path
  // hint). Streaming input composes with `resume` (only `continue` is mutually
  // exclusive with it).
  const { text: rawUserText, files: userFiles } = await collectUserTurn(input.threadKey);
  const userText = guardLeadingSlash(rawUserText);
  const userContent = await buildUserContent(input.threadKey, userText, userFiles);
  const prompt: string | AsyncIterable<unknown> =
    typeof userContent === 'string'
      ? userContent
      : (async function* () {
          yield {
            type: 'user' as const,
            message: { role: 'user' as const, content: userContent },
            parent_tool_use_id: null,
          };
        })();

  // Track the assistant event id for tool_call parent linkage (mirrors
  // runStreamingTurn, which links each tool_call to the assistant message it
  // came from). The SDK doesn't hand us a clean parent boundary per tool, so we
  // record one synthetic assistant event id per turn and parent all tool calls
  // under it — good enough for buildMessages reconstruction + debug-thread.
  let assistantEventId = newEventId();
  let assistantRecorded = false;

  const driver: SlackStreamDriver =
    overrides?.driver ??
    makeWebStreamDriver(web, channel, threadTs, input.recipientUserId, input.recipientTeamId);

  const recorder: SdkStreamRecorder = overrides?.recorder ?? {
    onAssistantText: async (text) => {
      latestAssistantText = text;
      assistantEventId = newEventId();
      assistantRecorded = true;
      await record({
        event_id: assistantEventId,
        thread_key: input.threadKey,
        source: 'assistant',
        type: 'message',
        ts: nowIso(),
        ingested_at: nowIso(),
        payload: { slack_ts: '', text },
      });
    },
    onToolCall: async (call) => {
      if (!assistantRecorded) {
        // Ensure a parent assistant event exists even if the tool fired before
        // any assistant text (rare but possible).
        await record({
          event_id: assistantEventId,
          thread_key: input.threadKey,
          source: 'assistant',
          type: 'message',
          ts: nowIso(),
          ingested_at: nowIso(),
          payload: { slack_ts: '', text: '' },
        });
        assistantRecorded = true;
      }
      await record({
        event_id: newEventId(),
        thread_key: input.threadKey,
        source: 'assistant',
        type: 'tool_call',
        ts: nowIso(),
        ingested_at: nowIso(),
        payload: {
          parent_event_id: assistantEventId,
          tool_call_id: call.id,
          name: call.name,
          arguments_json: call.argumentsJson,
        },
      });
    },
    onToolResult: async (result) => {
      await record({
        event_id: newEventId(),
        thread_key: input.threadKey,
        source: 'assistant',
        type: 'tool_result',
        ts: nowIso(),
        ingested_at: nowIso(),
        payload: {
          tool_call_id: result.id,
          content: result.content,
          ...(result.error ? { error: true } : {}),
        },
      });
    },
  };

  // The SDK uses an AbortController, not a raw signal. Bridge our turn signal
  // (the handler's /stop AbortSignal) into a fresh controller the SDK owns.
  const abortController = new AbortController();
  if (signal) {
    if (signal.aborted) abortController.abort();
    else signal.addEventListener('abort', () => abortController.abort(), { once: true });
  }

  const options: Record<string, unknown> = {
    tools: [],
    mcpServers: { agenta: mcpServer },
    allowedTools: ['mcp__agenta__*'],
    permissionMode: 'bypassPermissions',
    systemPrompt,
    model: stripBedrockScheme(model.name),
    maxTurns: MAX_TURNS,
    abortController,
    env: buildSdkEnv(),
    ...(resume ? { resume } : {}),
  };

  const runQuery =
    overrides?.runQuery ??
    ((params: { prompt: string | AsyncIterable<unknown>; options: Record<string, unknown> }) =>
      // biome-ignore lint/suspicious/noExplicitAny: query() Options is wider than our Record; the SDK validates at runtime
      query(params as any));

  try {
    const stream = runQuery({ prompt, options });
    const outcome = await consumeSdkStream(
      stream as AsyncIterable<unknown>,
      driver,
      recorder,
      signal,
    );

    // Persist the SDK session id on the FIRST turn so subsequent turns resume.
    if (outcome.sessionId && outcome.sessionId !== resume) {
      await setSdkSessionId(input.threadKey, outcome.sessionId);
    }
    log.info(
      'sdk-turn',
      `[${input.threadKey}] turn done (resume=${resume ? 'yes' : 'no'}, session=${outcome.sessionId ?? '?'}, completed=${outcome.completed})`,
    );
  } catch (err) {
    if (signal?.aborted) {
      log.info('sdk-turn', `[${input.threadKey}] stopped`);
      return;
    }
    const msg = redact((err as Error).message ?? String(err));
    log.error('sdk-turn', `[${input.threadKey}] query failed`, msg);
    // Best-effort: surface the error in-thread if the stream driver never
    // opened a stream (consumeSdkStream finalizes its own errors when the
    // stream is live).
    await postInThread(web, channel, threadTs, `error: ${msg}`).catch(() => {});
  }
}
