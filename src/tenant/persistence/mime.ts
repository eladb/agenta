import { fileTypeFromBuffer } from 'file-type';

// Detect MIME type from the actual file bytes (not the filename / extension /
// Slack-reported mimetype). Falls back to a plaintext sniff for unknown
// binary returns, and to application/octet-stream as a last resort.
export async function detectMime(buffer: Uint8Array): Promise<string> {
  const detected = await fileTypeFromBuffer(buffer);
  if (detected) return detected.mime;
  if (looksLikeUtf8Text(buffer)) return 'text/plain';
  return 'application/octet-stream';
}

function looksLikeUtf8Text(buf: Uint8Array): boolean {
  if (buf.byteLength === 0) return false;
  const sample = buf.subarray(0, Math.min(buf.byteLength, 4096));
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(sample);
  } catch {
    return false;
  }
  let printable = 0;
  for (let i = 0; i < decoded.length; i++) {
    const c = decoded.charCodeAt(i);
    if (c >= 32 || c === 9 || c === 10 || c === 13) printable++;
  }
  return printable / decoded.length >= 0.95;
}
