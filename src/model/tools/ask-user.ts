import { AskInUseError, type AskKind, getPendingAskByTs, registerAsk } from '../../runtime/asks';
import { buildAskBlocks, buildSettledBlocks } from '../../slack/ask-blocks';
import { editBlocksMessage, postBlocksInThread } from '../../slack/post';
import { oneLine, strArg } from './helpers';
import type { Tool } from './types';

const TIMEOUT_MS = 10 * 60_000;

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
    const placeholder = typeof a.placeholder === 'string' ? a.placeholder : undefined;
    const question = a.question;
    const blocks = buildAskBlocks(kind as AskKind, question, options, placeholder);
    const messageTs = await postBlocksInThread(web, channel, ctx.threadTs, question, blocks);

    // onSettle edits the Slack message in place so the thread is left with a
    // tidy "Q / A" record instead of stale buttons.
    const settle = async (
      settledKind: 'answer' | 'timeout' | 'cancel',
      detail: string,
    ): Promise<void> => {
      const answerLine =
        settledKind === 'timeout'
          ? '_(timed out)_'
          : settledKind === 'cancel'
            ? '_(cancelled)_'
            : detail.length > 0
              ? detail
              : '_(no answer)_';
      try {
        await editBlocksMessage(
          web,
          channel,
          messageTs,
          `${question} — ${answerLine}`,
          buildSettledBlocks(question, answerLine),
        );
      } catch {
        // Slack edit failures are best-effort.
      }
    };

    let registered: Promise<string>;
    try {
      registered = registerAsk({
        messageTs,
        threadKey: ctx.threadKey,
        kind: kind as AskKind,
        timeoutMs: TIMEOUT_MS,
        onSettle: settle,
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
