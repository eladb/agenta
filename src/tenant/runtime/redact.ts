// Best-effort secret redaction for error messages posted into Slack threads (spec §10).
const PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{20,}/g, // openai-style keys
  /xoxe\.xoxp-[\w-]+/g, // slack configuration access token
  /xoxb-[\w-]+/g, // slack bot tokens
  /xapp-[\w-]+/g, // slack app-level tokens
  /xoxp-[\w-]+/g, // slack user tokens
  /xoxe-[\w-]+/g, // slack refresh tokens
  /-----BEGIN [^-]+-----[\s\S]+?-----END [^-]+-----/g, // PEM blocks
];

export function redact(text: string): string {
  let out = text;
  for (const p of PATTERNS) out = out.replace(p, '<REDACTED>');
  return out;
}
