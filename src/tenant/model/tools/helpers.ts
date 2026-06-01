// Shared helpers used by multiple tool files. Each function is small and
// stateless. If a helper grows tool-specific quirks, move it into that
// tool's file.

export function truncate(s: string, cap: number, label: string): string {
  if (s.length <= cap) return s;
  return `${s.slice(0, cap)}\n…[${label} truncated, ${s.length - cap} more chars]`;
}

// One-line truncation used by tool describers. Keeps the Slack checklist
// readable without spilling onto multiple lines.
export function oneLine(s: string, max = 80): string {
  const flat = s.replace(/[\r\n]+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function strArg(args: unknown, key: string): string | undefined {
  const v = (args as Record<string, unknown> | null)?.[key];
  return typeof v === 'string' ? v : undefined;
}
