// Pending interactive Slack asks. The `ask_user` tool registers an entry
// keyed by message ts, then awaits the deferred. A Slack block_actions event
// (or a same-thread text reply, or a timeout, or /stop) resolves it. The
// resolved string becomes the tool_result the model sees.
//
// Invariant: at most one pending ask per threadKey at a time. The model
// invokes tools serially so this matches reality, and it lets a thread-text
// reply unambiguously resolve "the" pending ask in its thread.

export type AskKind = 'buttons' | 'select' | 'multi_select' | 'text';

export type AskPending = {
  messageTs: string;
  threadKey: string;
  kind: AskKind;
  // For multi_select: items the user has clicked so far (resolved on Submit).
  multiSelected: string[];
  // Called by the resolver (block_actions handler / text reply / timeout /
  // abort). Idempotent — second call is a no-op.
  resolve: (answer: string) => void;
  reject: (reason: string) => void;
};

const byMessageTs = new Map<string, AskPending>();
const byThreadKey = new Map<string, AskPending>();

export class AskInUseError extends Error {
  constructor(threadKey: string) {
    super(`an ask is already pending in thread ${threadKey}`);
  }
}

export function getPendingAskByThread(threadKey: string): AskPending | undefined {
  return byThreadKey.get(threadKey);
}

export function getPendingAskByTs(messageTs: string): AskPending | undefined {
  return byMessageTs.get(messageTs);
}

export type RegisterArgs = {
  messageTs: string;
  threadKey: string;
  kind: AskKind;
  timeoutMs: number;
  onSettle: (kind: 'answer' | 'timeout' | 'cancel', detail: string) => void | Promise<void>;
};

// Returns a Promise that resolves to the tool_result string when the ask
// settles. Throws AskInUseError if a different ask is already pending in
// this thread.
export function registerAsk(args: RegisterArgs): Promise<string> {
  if (byThreadKey.has(args.threadKey)) throw new AskInUseError(args.threadKey);
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      byMessageTs.delete(args.messageTs);
      byThreadKey.delete(args.threadKey);
      clearTimeout(timer);
    };
    const settle = (kind: 'answer' | 'timeout' | 'cancel', detail: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      // Surface the settlement to the tool (for UI editing). Errors thrown by
      // onSettle don't block resolution.
      void Promise.resolve(args.onSettle(kind, detail)).catch(() => {});
      if (kind === 'answer') resolve(detail);
      else if (kind === 'timeout') resolve('timeout');
      else resolve('cancelled');
      void reject;
    };
    const timer = setTimeout(() => settle('timeout', ''), args.timeoutMs);
    const entry: AskPending = {
      messageTs: args.messageTs,
      threadKey: args.threadKey,
      kind: args.kind,
      multiSelected: [],
      resolve: (answer) => settle('answer', answer),
      reject: (reason) => settle('cancel', reason),
    };
    byMessageTs.set(args.messageTs, entry);
    byThreadKey.set(args.threadKey, entry);
  });
}

// Resolve the pending ask for a thread because the user typed a reply in
// that thread instead of using the interactive controls. No-op if no ask is
// pending. Returns true if an ask was resolved.
export function resolveByThreadText(threadKey: string, text: string): boolean {
  const ask = byThreadKey.get(threadKey);
  if (!ask) return false;
  ask.resolve(text);
  return true;
}

// For tests.
export function _resetAsks(): void {
  for (const ts of [...byMessageTs.keys()]) {
    byMessageTs.get(ts)?.reject('reset');
  }
  byMessageTs.clear();
  byThreadKey.clear();
}
