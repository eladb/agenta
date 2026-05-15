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
//   - Status lines (provisioning workspace, attachments synced) shown as
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
): Promise<void> {
  // "Live" message tracks ONLY the current round. When the next round
  // begins (model returns more text + tool calls), we leave this message
  // frozen and post a new one. When the final reply lands, we post it as
  // a fresh clean message and delete any in-flight placeholder.
  let liveTs: string | undefined;
  let liveHeader = '';
  let liveLines: string[] = [];

  // Render the current round into Slack. Lazy: posts the message the
  // first time renderRound returns non-empty content, edits thereafter.
  // No-op when there's still nothing to show (empty header + empty
  // lines) — Slack rejects empty posts, and there's nothing to update.
  const repaint = async (): Promise<void> => {
    const body = renderRound(liveHeader, liveLines);
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
            await repaint();
          }
          continue;
        }
        // Truly final. Replace the live message with the clean final
        // reply, or post fresh if the model never exercised a tool and
        // there's no live message yet.
        const reply = text.length > 0 ? text : '(empty reply)';
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

      messages.push({ role: 'assistant', content: response.content, tool_calls: toolCalls });

      for (const tc of toolCalls) {
        // Lazy sandbox provisioning. Surfaced as an italicized status
        // line before the tool that needs it so the chronology lines up.
        const tool = TOOLS[tc.function.name];
        let provisionError: string | undefined;
        if (tool?.requiresSandbox && !isSandboxReady(input.threadKey)) {
          pushSeparator(liveLines);
          const provIdx = liveLines.length;
          liveLines.push('_provisioning workspace…_');
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

        // Git-backed botspace bootstrap. Runs AFTER ensureContainer (it
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
        const isBash = tc.function.name === 'bash';
        const label = toolLabel(tc);
        const bulletIdx = liveLines.length;
        liveLines.push(label);
        const liveIdx = liveLines.length;
        liveLines.push('…');
        await repaint();

        let liveBuffer = '';
        let flushTimer: ReturnType<typeof setTimeout> | undefined;
        const scheduleFlush = (): void => {
          if (flushTimer || liveIdx < 0 || !isBash) return;
          flushTimer = setTimeout(() => {
            flushTimer = undefined;
            liveLines[liveIdx] = liveLine(liveBuffer);
            void repaint();
          }, LIVE_EDIT_INTERVAL_MS);
        };
        const onProgress = isBash
          ? (chunk: { kind: 'stdout' | 'stderr'; text: string }): void => {
              liveBuffer = (liveBuffer + chunk.text).slice(-1024);
              scheduleFlush();
            }
          : undefined;

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
