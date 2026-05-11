// Per-key serialization: calls for the same key run one at a time, in arrival order.
// Calls for different keys run concurrently. Errors from one call do not break the chain
// for subsequent calls on the same key.
const chains = new Map<string, Promise<unknown>>();

export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn); // run fn whether previous resolved or rejected
  chains.set(
    key,
    next.catch(() => {}),
  );
  return next;
}
