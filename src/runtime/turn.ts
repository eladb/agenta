import type { WebClient } from '@slack/web-api';
import { ensureRepoBootstrap } from '../git/bootstrap';
import { log } from '../log';
import { buildMessages } from '../model/context';
import type { CallModel, Message, ToolCall } from '../model/gateway';
import { invokeTool, TOOL_DEFS, TOOLS } from '../model/tools';
import type { AgentaEvent } from '../persistence/events';
import { newEventId, nowIso, record } from '../persistence/events';
import { readEvents } from '../persistence/store';
import { ensureContainer, isSandboxReady, syncAttachmentsToSandbox } from '../sandbox';
import { addReaction, editMessage, postInThread, removeReaction } from '../slack/post';
import { parseCommand } from './commands';
import type { DisplayStyle } from './home-config';
import { redact } from './redact';

export type TurnInput = {
  channel: string;
  threadTs: string;
  threadKey: string;
};

const ARGS_PREVIEW_LEN = 80;
const LIVE_PREVIEW_LEN = 150;
const LIVE_EDIT_INTERVAL_MS = 800;

// Visual conventions for an intermediate round message:
//   - The model's reasoning text at the top, plain (no prefix).
//   - Tool blocks below — a plain label line + a result line (`→ result`).
//   - Status lines (waiting for workspace, attachments synced) shown as
//     plain italics so they read as informational, not equal weight to
//     tool actions.
// When the model emits no reasoning text, the header is omitted entirely —
// the round message is just the tool's rendering. No `thinking…` persists.
//
// Final replies (no tool_calls) post as a fresh plain message.
// Slack emoji shortcodes for in-flight UX. Reactions are added to the
// originating user message(s) so the user sees at a glance what the
// bot is doing, and removed when the turn finishes.
const REACTION_THINKING = 'thinking_face';
const REACTION_STEERING = 'wheel';

// Humanized tool labels for pretty mode (#141). Pure lookup — the model's
// `content` text takes precedence; this is the fallback when content is
// null/empty. Falls back to the raw tool name for unknown tools so a new
// tool added without an entry here is still displayed (just not prettily).
const PRETTY_TOOL_LABELS: Record<string, string> = {
  bash: 'Running command',
  web_search: 'Searching the web',
  read_page: 'Reading a page',
  read_file: 'Reading file',
  write_file: 'Writing file',
  edit_file: 'Editing file',
  grep: 'Searching code',
  glob: 'Listing files',
  list_dir: 'Listing directory',
  get_current_time: 'Checking time',
  fetch_url: 'Fetching URL',
  share_file: 'Sharing file',
  ask_user: 'Asking',
  salto_cli: 'Running Salto CLI',
  github_create_pr: 'Opening GitHub PR',
};

export function prettyToolLabel(name: string): string {
  return PRETTY_TOOL_LABELS[name] ?? name;
}

function toolLabel(tc: ToolCall): string {
  // Short human-readable label from the tool's own describe(). Falls back
  // to a raw name(args) form if no describer is registered or it throws.
  const tool = TOOLS[tc.function.name];
  if (tool?.describe) {
    try {
      const parsed = tc.function.arguments.length > 0 ? JSON.parse(tc.function.arguments) : {};
      const desc = tool.describe(parsed);
      if (desc) return desc;
    } catch {
      // fall through
    }
  }
  const a = tc.function.arguments;
  const args = a.length > ARGS_PREVIEW_LEN ? `${a.slice(0, ARGS_PREVIEW_LEN - 1)}…` : a;
  return `${tc.function.name}(${args})`;
}

function liveLine(preview: string): string {
  // Collapse newlines so the live preview stays single-line inside the bash
  // code fence. No leading indent — we're already inside a code block.
  const flat = preview.replace(/[\r\n]+/g, ' ⏎ ').slice(-LIVE_PREVIEW_LEN);
  return flat;
}

function renderRound(headerText: string, lines: string[]): string {
  const parts: string[] = [];
  if (headerText.length > 0) {
    // Italic the round header so intermediate reasoning reads as an
    // aside, distinct from the final reply which posts as plain text
    // in a separate message. Authored as standard markdown;
    // mdToMrkdwn translates *italic* → _italic_ at the post boundary.
    parts.push(`*${headerText}*`);
    if (lines.length > 0) parts.push(''); // blank line between header and tool blocks
  }
  parts.push(...lines);
  return parts.join('\n');
}

// Push a blank separator before a new logical block if the current trailing
// entry isn't already blank — keeps tool blocks visually separated.
function pushSeparator(lines: string[]): void {
  if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
}

// Drain any slack.message events that arrived since `consumed` was last
// refreshed, append them to the in-process messages[] as `role: user`, and
// add their event_ids to `consumed` so we don't double-inject. Returns the
// slack_ts of each injected message (so the caller can react on each).
//
// This is the "steering" path: between rounds, the model picks up any
// user input that landed during the previous round and can adjust its
// trajectory. (Real-time during a single model call is impossible — the
// API is request/response.)
async function injectSteering(
  threadKey: string,
  messages: Message[],
  consumed: Set<string>,
): Promise<string[]> {
  const events = await readEvents<AgentaEvent>(threadKey);
  const injectedTs: string[] = [];
  for (const e of events) {
    if (e.source !== 'slack' || e.type !== 'message') continue;
    if (consumed.has(e.event_id)) continue;
    const text = e.payload.text;
    // Skip slash-commands — they're consumed by handler.ts, not steering.
    // The model shouldn't see "/stop" or "/delete" as user input.
    if (typeof text === 'string' && text.length > 0 && parseCommand(text) === null) {
      messages.push({ role: 'user', content: text });
      const slackTs = e.payload.slack_ts;
      if (typeof slackTs === 'string') injectedTs.push(slackTs);
    }
    consumed.add(e.event_id);
  }
  return injectedTs;
}

export async function runTurn(
  web: WebClient,
  callModel: CallModel,
  systemPrompt: string,
  input: TurnInput,
  signal?: AbortSignal,
  onMidTurnConsume?: () => void,
  displayStyle: DisplayStyle = 'verbose',
): Promise<void> {
  const pretty = displayStyle === 'pretty';
  // Count tool calls executed across the whole turn — used for the pretty-
  // mode footer (`_ran N tools_`). Includes failures so the count matches
  // user expectations ("the bot tried N things").
  let toolsRan = 0;
  // "Live" message tracks ONLY the current round. When the next round
  // begins (model returns more text + tool calls), we leave this message
  // frozen and post a new one. When the final reply lands, we post it as
  // a fresh clean message and delete any in-flight placeholder.
  let liveTs: string | undefined;
  let liveHeader = '';
  let liveLines: string[] = [];

  // Pretty-mode progress line. Set whenever the model emits a new round —
  // takes the model's `content` if present, otherwise a comma-joined list of
  // humanized tool labels. Rendered as a single bold line. Verbose mode
  // ignores this field entirely.
  let prettyProgress = '';
  // Pretty-mode "currently running" indicator. Updated per tool execution so
  // the user sees `_reading file…_` swap to `_running command…_` while a
  // single iteration's tool list runs. Cleared between iterations and on the
  // final reply.
  let prettyCurrentTool = '';
  // Pretty-mode "just completed" indicator. Set when a tool finishes, kept
  // visible until the next tool starts OR the next model iteration begins.
  // Gives the user context for what the model is processing during the
  // model-call wait between rounds (previously this slot held the literal
  // word "Thinking" which replaced the model's own description text).
  let prettyLastTool = '';

  // Render the current round into Slack. Lazy: posts the message the
  // first time renderRound returns non-empty content, edits thereafter.
  // No-op when there's still nothing to show (empty header + empty
  // lines) — Slack rejects empty posts, and there's nothing to update.
  const repaint = async (): Promise<void> => {
    // Pretty mode body: bold model `content` (the model's own description
    // of what it's doing) stacked with an optional italic tool indicator
    // underneath — `_<label>…_` while a tool is running, `_<label>_` after
    // it completes. Both lines coexist so the user keeps the model's text
    // for context while tools run, and keeps the last tool name visible
    // during the model-call wait between iterations.
    let body: string;
    if (pretty) {
      const lines: string[] = [];
      if (prettyProgress.length > 0) lines.push(`*${prettyProgress}*`);
      // Only show the tool sub-line when it adds information beyond the
      // progress line. When model content is empty the progress falls back
      // to the humanized tool label — showing it again as the italic
      // sub-line is redundant ("Running command" + "_Running command…_").
      const toolLine = prettyCurrentTool.length > 0 ? prettyCurrentTool : prettyLastTool;
      const toolSuffix = prettyCurrentTool.length > 0 ? '…' : '';
      if (toolLine.length > 0 && toolLine !== prettyProgress) {
        lines.push(`_${toolLine}${toolSuffix}_`);
      }
      body = lines.join('\n');
    } else {
      body = renderRound(liveHeader, liveLines);
    }
    if (body.length === 0) return;
    if (liveTs) {
      await editMessage(web, input.channel, liveTs, body).catch(() => {});
    } else {
      try {
        liveTs = await postInThread(web, input.channel, input.threadTs, body);
      } catch {
        // best-effort; the next repaint will retry
      }
    }
  };

  // Track every reaction added so we can remove them all on turn end —
  // success, abort, or error.
  const reactionsAdded: Array<{ ts: string; name: string }> = [];
  const reactOn = async (ts: string, name: string): Promise<void> => {
    await addReaction(web, input.channel, ts, name);
    reactionsAdded.push({ ts, name });
  };
  const clearAllReactions = async (): Promise<void> => {
    await Promise.all(reactionsAdded.map((r) => removeReaction(web, input.channel, r.ts, r.name)));
    reactionsAdded.length = 0;
  };

  // No pre-model placeholder. The 🤔 reaction on the user's mention
  // (added inside the try block below) is the "I'm working on it"
  // signal; we only post a round message when we have concrete
  // content (a model response that emits tool calls, or an
  // intermediate steered text).

  try {
    const messages: Message[] = await buildMessages(input.threadKey, systemPrompt);

    // Initial set of slack.message event_ids that are already represented in
    // `messages` (via buildMessages). Anything that lands AFTER this is
    // unseen by the model until we inject it via injectSteering().
    // While we're walking the events, also find the latest slack message
    // (the one that triggered this turn) so we can react on it.
    const consumed = new Set<string>();
    let originatingTs: string | undefined;
    {
      const initial = await readEvents<AgentaEvent>(input.threadKey);
      for (const e of initial) {
        if (e.source === 'slack' && e.type === 'message') {
          consumed.add(e.event_id);
          const slackTs = e.payload.slack_ts;
          if (typeof slackTs === 'string') originatingTs = slackTs;
        }
      }
    }

    // React 🤔 on the originating mention so the user sees the bot is
    // working on it. Removed when the turn ends.
    if (originatingTs) {
      await reactOn(originatingTs, REACTION_THINKING);
    }

    while (true) {
      const response = await callModel(messages, { tools: TOOL_DEFS, signal });

      const assistantEventId = newEventId();
      const text = response.content ?? '';
      const toolCalls = response.tool_calls ?? [];

      await record({
        event_id: assistantEventId,
        thread_key: input.threadKey,
        source: 'assistant',
        type: 'message',
        ts: nowIso(),
        ingested_at: nowIso(),
        payload: { slack_ts: liveTs ?? '', text },
      });

      // No tool calls → model thinks it's done. But if user input landed
      // mid-round, treat this as an intermediate response: post it as a
      // standalone italic round message, inject the new user messages,
      // and continue the loop so the model sees them.
      if (toolCalls.length === 0) {
        const injected = await injectSteering(input.threadKey, messages, consumed);
        if (injected.length > 0) {
          onMidTurnConsume?.();
          for (const ts of injected) await reactOn(ts, REACTION_STEERING);
          // Render the would-be-final as an italic intermediate in the
          // live message. The next iteration will overwrite it.
          if (text.length > 0) {
            messages.push({ role: 'assistant', content: text });
            liveHeader = text;
            liveLines = [];
            if (pretty) {
              prettyProgress = text;
              prettyCurrentTool = '';
              prettyLastTool = '';
            }
            await repaint();
          }
          continue;
        }
        // Truly final. Replace the live message with the clean final
        // reply, or post fresh if the model never exercised a tool and
        // there's no live message yet. In pretty mode, append the
        // `_ran N tools_` footer when any tool ran during the turn.
        const baseReply = text.length > 0 ? text : '(empty reply)';
        const reply =
          pretty && toolsRan > 0
            ? `${baseReply}\n\n*ran ${toolsRan} ${toolsRan === 1 ? 'tool' : 'tools'}*`
            : baseReply;
        if (liveTs) {
          await editMessage(web, input.channel, liveTs, reply).catch(() => {});
        } else {
          await postInThread(web, input.channel, input.threadTs, reply);
        }
        log.info('turn', `[${input.threadKey}] replied (${reply.length} chars)`);
        return;
      }

      // Has tool calls → overwrite the live message with this round's
      // content. One Slack message is shared across the whole turn:
      // each round REPLACES the previous round's content in place.
      // repaint() lazy-creates the message the first time we have
      // something non-empty to show.
      liveHeader = text;
      liveLines = [];
      // Pretty mode: progress line is the model's content if present, else
      // a comma-joined list of humanized tool labels. Tool failures don't
      // change this — the next iteration's content (or final reply) will.
      if (pretty) {
        prettyProgress =
          text.length > 0
            ? text
            : toolCalls.map((tc) => prettyToolLabel(tc.function.name)).join(', ');
        // Reset the per-tool sub-line; it'll be set again at each tool's
        // execution below. Also clear prettyLastTool — the new round's
        // model content is the freshest context, so the previous round's
        // "_ran X_" indicator is no longer useful.
        prettyCurrentTool = '';
        prettyLastTool = '';
        // Paint the model's content immediately so the user sees it before
        // the first tool replaces the body. Without this, the first repaint
        // in the for-loop below sets prettyCurrentTool and the content text
        // never becomes visible.
        await repaint();
      }

      messages.push({ role: 'assistant', content: response.content, tool_calls: toolCalls });

      for (const tc of toolCalls) {
        // Sandbox readiness. Provisioning was kicked off in the background
        // when the turn started (see handler.ts → kickoffEnsureContainer);
        // here we just await whatever's in flight. If it's already done by
        // the time we get here, ensureContainer is effectively a no-op and
        // no status line is shown. Otherwise we surface a single
        // "_waiting for workspace…_" line until it lands.
        const tool = TOOLS[tc.function.name];
        let provisionError: string | undefined;
        if (tool?.requiresSandbox && !isSandboxReady(input.threadKey)) {
          pushSeparator(liveLines);
          const provIdx = liveLines.length;
          liveLines.push('_waiting for workspace to become available…_');
          await repaint();
          try {
            await ensureContainer(input.threadKey);
            // Success: don't persist the status line. The tool block that
            // follows is the meaningful content. Drop the trailing
            // separator too if it was added just for this status line.
            liveLines.splice(provIdx, 1);
            if (
              liveLines.length > 0 &&
              liveLines[liveLines.length - 1] === '' &&
              liveLines.length === provIdx
            ) {
              liveLines.pop();
            }
          } catch (err) {
            const msg = (err as Error).message;
            provisionError = msg;
            liveLines[provIdx] = `_workspace provisioning failed: ${msg}_`;
          }
          await repaint();
        }

        // Git-backed agent home bootstrap. Runs AFTER ensureContainer (it
        // talks to the sandbox over the existing HTTP API) and BEFORE the
        // attachment sync (so the clone-into-empty-home dance plays out
        // before we copy stuff into ~). Idempotent: short-circuits when
        // the session already has a registered key + ~/.git is present.
        // Failures synthesize a tool_result (same shape as a sandbox-
        // provision failure) so the model can recover.
        if (tool?.requiresSandbox && !provisionError) {
          try {
            await ensureRepoBootstrap(input.threadKey);
          } catch (err) {
            const msg = (err as Error).message;
            provisionError = msg;
            pushSeparator(liveLines);
            liveLines.push(`_git bootstrap failed: ${msg}_`);
            await repaint();
          }
        }

        // Lazy attachment sync. Same idempotent helper. We don't surface
        // a status line in Slack — it's a harness detail, not something
        // the user needs to track. If it fails, the next tool that tries
        // to read the missing file will surface a real error.
        if (tool?.requiresSandbox && !provisionError) {
          try {
            const { synced } = await syncAttachmentsToSandbox(input.threadKey);
            if (synced > 0) {
              log.info('turn', `[${input.threadKey}] synced ${synced} attachment(s)`);
            }
          } catch (err) {
            log.warn('turn', `[${input.threadKey}] attachment sync failed`, err);
          }
        }

        pushSeparator(liveLines);

        // Tool rendering: a label line + a mutable result/preview line
        // underneath, both plain text (no inline-code / fenced backticks).
        // bash gets the live preview behavior; everything else just shows
        // a result placeholder until the tool returns.
        const hasLivePreview = tc.function.name === 'bash' || tc.function.name === 'salto_cli';
        const label = toolLabel(tc);
        const bulletIdx = liveLines.length;
        liveLines.push(label);
        const liveIdx = liveLines.length;
        liveLines.push('…');
        // Pretty mode: surface the per-tool transition as a small italic
        // sub-line under the round's progress text. Without this, a single
        // model iteration that emits N tool calls would show the same
        // progress line for the entire run — the user couldn't tell that
        // anything is happening between the initial "Let me look at…" and
        // the final reply (observed 2026-05-20).
        if (pretty) prettyCurrentTool = prettyToolLabel(tc.function.name);
        await repaint();

        let liveBuffer = '';
        let flushTimer: ReturnType<typeof setTimeout> | undefined;
        const scheduleFlush = (): void => {
          if (flushTimer || liveIdx < 0 || !hasLivePreview) return;
          flushTimer = setTimeout(() => {
            flushTimer = undefined;
            liveLines[liveIdx] = liveLine(liveBuffer);
            void repaint();
          }, LIVE_EDIT_INTERVAL_MS);
        };
        const onProgress = hasLivePreview
          ? (chunk: { kind: 'stdout' | 'stderr'; text: string }): void => {
              liveBuffer = (liveBuffer + chunk.text).slice(-1024);
              scheduleFlush();
            }
          : undefined;

        toolsRan += 1;
        await record({
          event_id: newEventId(),
          thread_key: input.threadKey,
          source: 'assistant',
          type: 'tool_call',
          ts: nowIso(),
          ingested_at: nowIso(),
          payload: {
            parent_event_id: assistantEventId,
            tool_call_id: tc.id,
            name: tc.function.name,
            arguments_json: tc.function.arguments,
          },
        });

        const result: { content: string; error: boolean } = provisionError
          ? {
              content: `error: workspace not available: ${provisionError}`,
              error: true,
            }
          : await invokeTool(
              tc.function.name,
              tc.function.arguments,
              {
                threadKey: input.threadKey,
                onProgress,
                web,
                channel: input.channel,
                threadTs: input.threadTs,
                checklistTs: liveTs ?? input.threadTs,
                modelContent: liveHeader.length > 0 ? liveHeader : undefined,
              },
              signal,
            );

        // ask_user resolves inline on its label line (no separate result
        // slot — the answer reads naturally next to the question).
        if (tc.function.name === 'ask_user' && !result.error) {
          liveLines[bulletIdx] = `${liveLines[bulletIdx]} → ${result.content}`;
          // drop the unused result slot
          if (liveIdx >= 0 && liveLines[liveIdx] === '…') {
            liveLines.splice(liveIdx, 1);
          }
        } else {
          if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = undefined;
          }
          if (liveIdx >= 0) {
            const firstLine = result.content.split('\n')[0] ?? '';
            liveLines[liveIdx] = `→ ${firstLine}`;
          }
        }

        await record({
          event_id: newEventId(),
          thread_key: input.threadKey,
          source: 'assistant',
          type: 'tool_result',
          ts: nowIso(),
          ingested_at: nowIso(),
          payload: {
            tool_call_id: tc.id,
            content: result.content,
            ...(result.error ? { error: true } : {}),
          },
        });

        messages.push({ role: 'tool', tool_call_id: tc.id, content: result.content });

        // Pretty mode: transition the tool indicator from "_<label>…_"
        // (running) to "_<label>_" (done). The transition is visible
        // briefly between sequential tools in the same round; if this was
        // the last tool of the round it persists through the model-call
        // wait that follows.
        if (pretty) {
          prettyLastTool = prettyCurrentTool;
          prettyCurrentTool = '';
        }
      }

      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');

      // Steering: drain any user messages that arrived during this round
      // before the next model call. The model will see them on the next
      // iteration and can adjust direction. React 🛞 on each one.
      const injectedMid = await injectSteering(input.threadKey, messages, consumed);
      if (injectedMid.length > 0) {
        onMidTurnConsume?.();
        for (const ts of injectedMid) await reactOn(ts, REACTION_STEERING);
      }

      // End of round. Do NOT clear liveTs — the same live message
      // carries forward to the next iteration and gets overwritten
      // there. While the next model call is in flight the message
      // still shows THIS round's content; the 🤔 reaction is the
      // user-facing "still working" signal.
      //
      // Pretty mode: at end of round, `prettyProgress` stays as the
      // model's own description text and `prettyLastTool` (set when the
      // last tool finished) stays visible. No "Thinking" placeholder —
      // the user keeps the model's words + the last tool's name as
      // context during the model-call wait.
      await repaint();
    }
  } catch (err) {
    if (signal?.aborted) {
      if (liveTs) {
        await editMessage(web, input.channel, liveTs, 'stopped').catch(() => {});
      } else {
        await postInThread(web, input.channel, input.threadTs, 'stopped').catch(() => {});
      }
      log.info('turn', `[${input.threadKey}] stopped`);
      return;
    }
    const msg = redact((err as Error).message ?? String(err));
    log.error('turn', `[${input.threadKey}] model call failed`, msg);
    if (liveTs) {
      await editMessage(web, input.channel, liveTs, `error: ${msg}`).catch(() => {});
    } else {
      await postInThread(web, input.channel, input.threadTs, `error: ${msg}`).catch(() => {});
    }
  } finally {
    // Always clear reactions added during this turn — success, abort, or
    // error. Best-effort: Slack errors here don't propagate.
    await clearAllReactions();
  }
}
