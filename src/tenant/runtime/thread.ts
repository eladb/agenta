export function threadKey(channelId: string, threadTs: string): string {
  return `${channelId}__${threadTs.replace(/\./g, '_')}`;
}

// Inverse of threadKey: split `${channel}__${ts_with_underscores}` back into
// channel + thread_ts. Returns undefined for keys that don't match the shape
// (defensive — protects callers that scan untrusted thread dirs on disk).
export function decodeThreadKey(tk: string): { channel: string; threadTs: string } | undefined {
  const idx = tk.indexOf('__');
  if (idx <= 0 || idx === tk.length - 2) return undefined;
  const channel = tk.slice(0, idx);
  const tsRaw = tk.slice(idx + 2);
  // Slack ts is "<seconds>.<fractional>" → we stored it as "<seconds>_<fractional>".
  // Convert just the LAST underscore back to a dot.
  const lastUnderscore = tsRaw.lastIndexOf('_');
  if (lastUnderscore < 0) return undefined;
  const threadTs = `${tsRaw.slice(0, lastUnderscore)}.${tsRaw.slice(lastUnderscore + 1)}`;
  return { channel, threadTs };
}
