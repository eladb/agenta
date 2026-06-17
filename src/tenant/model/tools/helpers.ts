// Shared helpers used by multiple tool files. Each function is small and
// stateless. If a helper grows tool-specific quirks, move it into that
// tool's file.

export function truncate(s: string, cap: number, label: string): string {
  if (s.length <= cap) return s;
  return `${s.slice(0, cap)}\n…[${label} truncated, ${s.length - cap} more chars]`;
}

export function strArg(args: unknown, key: string): string | undefined {
  const v = (args as Record<string, unknown> | null)?.[key];
  return typeof v === 'string' ? v : undefined;
}
