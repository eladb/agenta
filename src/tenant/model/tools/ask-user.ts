import { AskInUseError, type AskKind, getPendingAskByTs, registerAsk } from '../../runtime/asks';
import { buildAskBlocks } from '../../slack/ask-blocks';
import { postBlocksInThread } from '../../slack/post';
import { oneLine, strArg } from './helpers';
import type { Tool } from './types';

// How long an ask blocks before auto-resolving to "timeout". Exported so the
// SDK harness can size CLAUDE_CODE_STREAM_CLOSE_TIMEOUT comfortably above it
// (the SDK's default 60s stream-close would otherwise drop the in-flight MCP
// call while a human is still deciding — #305).
export const ASK_TIMEOUT_MS = 10 * 60_000;

export const askUser: Tool = {
  def: {
    type: 'function',
    function: {
      name: 'ask_user',
      description:
        'Pause and ask the human a question via an interactive Slack message, then return their answer as a string. Use this when you need a decision you genuinely cannot infer from context. Kinds: "buttons" (1 of N, ideal for 2–6 options), "select" (compact dropdown for 7+ options), "multi_select" (any-of-N, answer is a JSON array), "text" (free-form reply in the thread; "options" is ignored). Returns "timeout" after 10 minutes, "cancelled" if the user clicks Cancel. The user can also just type a reply in the thread to answer any kind.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Question to display to the user.' },
          kind: {
            type: 'string',
            enum: ['buttons', 'select', 'multi_select', 'text'],
            description: 'Which interactive UI to use.',
          },
          options: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Required for buttons/select/multi_select. Each option must be a non-empty string. Ignored for text.',
          },
          placeholder: {
            type: 'string',
            description: 'Optional hint shown in the select / dropdown placeholder.',
          },
        },
        required: ['question', 'kind'],
        additionalProperties: false,
      },
    },
  },
  describe: (args) => {
    const q = oneLine(strArg(args, 'question') ?? '?', 40);
    const k = strArg(args, 'kind') ?? '?';
    return `ask_user (${k}): ${q}`;
  },
  invoke: async (args, ctx, signal) => {
    const a = args as {
      question?: unknown;
      kind?: unknown;
      options?: unknown;
      placeholder?: unknown;
    } | null;
    if (typeof a?.question !== 'string' || a.question.length === 0) {
      throw new Error('ask_user: missing or invalid question');
    }
    const kind = a.kind;
    if (kind !== 'buttons' && kind !== 'select' && kind !== 'multi_select' && kind !== 'text') {
      throw new Error('ask_user: kind must be buttons | select | multi_select | text');
    }
    const options =
      Array.isArray(a.options) && a.options.every((o) => typeof o === 'string' && o.length > 0)
        ? (a.options as string[])
        : [];
    if (
      (kind === 'buttons' || kind === 'select' || kind === 'multi_select') &&
      options.length === 0
    ) {
      throw new Error(`ask_user: kind=${kind} requires a non-empty options array`);
    }
    if (!ctx.web || !ctx.channel || !ctx.threadTs) {
      throw new Error('ask_user: Slack context unavailable in this run');
    }
    const web = ctx.web;
    const channel = ctx.channel;
    const threadTs = ctx.threadTs;
    const placeholder = typeof a.placeholder === 'string' ? a.placeholder : undefined;
    const question = a.question;

    // Build the interactive blocks. When the model emitted content text this
    // iteration (ctx.modelContent), prepend it as a section above the
    // question so the user keeps the model's reasoning visible alongside the
    // interactive controls.
    const askBlocks = buildAskBlocks(kind as AskKind, question, options, placeholder);
    const blocks = ctx.modelContent
      ? [{ type: 'section', text: { type: 'mrkdwn', text: ctx.modelContent } }, ...askBlocks]
      : askBlocks;

    // The Slack streaming spec forbids interactive blocks mid-stream, so POST
    // a SEPARATE thread message carrying the blocks. The stream shows an
    // "Asking…" task row that flips to complete when this resolves. The ask
    // registry is keyed by the new message's ts.
    let messageTs: string;
    try {
      messageTs = await postBlocksInThread(web, channel, threadTs, question, blocks);
    } catch (err) {
      throw new Error(`ask_user: could not post blocks: ${(err as Error).message}`);
    }

    let registered: Promise<string>;
    try {
      registered = registerAsk({
        messageTs,
        threadKey: ctx.threadKey,
        kind: kind as AskKind,
        timeoutMs: ASK_TIMEOUT_MS,
        // No Slack-side settle handler needed: the question lives in its own
        // thread message and the stream's "Asking…" task row flips to complete
        // when the ask resolves.
        onSettle: () => {},
      });
    } catch (err) {
      if (err instanceof AskInUseError) {
        throw new Error('ask_user: another ask is already pending in this thread');
      }
      throw err;
    }

    const onAbort = (): void => {
      getPendingAskByTs(messageTs)?.reject('cancelled');
    };
    signal?.addEventListener('abort', onAbort);
    try {
      return await registered;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  },
};
