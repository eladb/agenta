export type DedupeInput = {
  eventId?: string;
  channel: string;
  threadTs: string;
  user: string;
  ts: string;
  text: string;
};

export function dedupeKey(input: DedupeInput): string {
  if (input.eventId) return `id:${input.eventId}`;
  const h = textHash(input.text);
  return `fb:${input.channel}:${input.threadTs}:${input.user}:${input.ts}:${h}`;
}

export function createDedupe(maxSize = 5000): (key: string) => boolean {
  const seen = new Map<string, true>();
  return (key) => {
    if (seen.has(key)) return true;
    seen.set(key, true);
    if (seen.size > maxSize) {
      const oldest = seen.keys().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    return false;
  };
}

function textHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}
