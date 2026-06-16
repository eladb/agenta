// SDK-harness attachment inlining (#315 Phase A). The bespoke harness inlines
// Slack attachments into the model request via context.ts:fileToContentPart in
// the OpenAI-compat `image_url` shape. The SDK harness talks the native
// Anthropic Messages wire format, so attachments become native content blocks
// (`image` / `document` / `text`) on a streaming-input user message. Semantics
// mirror context.ts: images + PDFs inline as base64, text-ish files inline
// (capped), everything else gets a text placeholder; every file also gets a
// `[attached: attachments/<id>-<name>]` path hint so the model can read the
// synced copy in the sandbox.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sanitize } from '../persistence/attachments';
import type { AttachmentRef } from '../persistence/events';
import { threadDir } from '../persistence/store';

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const TEXT_MIMES = new Set([
  'text/plain',
  'text/markdown',
  'text/html',
  'text/csv',
  'text/xml',
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/x-yaml',
  'application/yaml',
  'application/toml',
]);
const TEXT_BYTE_CAP = 20 * 1024;

// Native Anthropic user-content blocks we emit. Kept minimal + local so we don't
// couple to the @anthropic-ai/sdk type surface (the SDK validates at runtime).
type TextBlock = { type: 'text'; text: string };
type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };
type DocumentBlock = {
  type: 'document';
  source: { type: 'base64'; media_type: 'application/pdf'; data: string };
};
export type UserContentBlock = TextBlock | ImageBlock | DocumentBlock;

// The `[attached: attachments/<id>-<name>]` path hints, one per file. Mirrors
// context.ts:buildAttachedSuffix — points the model at the synced sandbox copy
// (syncAttachmentsToSandbox pushes data/{tk}/attachments/<id>-<name> into
// attachments/<id>-<name> under /home/sandbox).
export function buildAttachedSuffix(files: AttachmentRef[]): string {
  return files
    .map((f) => `[attached: attachments/${f.file_id}-${sanitize(f.name ?? f.file_id)}]`)
    .join('\n');
}

function appendSuffix(text: string, suffix: string): string {
  if (suffix.length === 0) return text;
  return text.length > 0 ? `${text}\n${suffix}` : suffix;
}

// One attachment → one native content block. Images/PDFs inline as base64;
// text-ish files inline their (capped) contents; anything else is a text
// placeholder. Reads the on-disk copy under data/{threadKey}/<local_path>.
export async function attachmentToBlock(
  threadKey: string,
  f: AttachmentRef,
): Promise<UserContentBlock> {
  const fullPath = join(threadDir(threadKey), f.local_path);
  if (IMAGE_MIMES.has(f.mimetype)) {
    const buf = await readFile(fullPath);
    return {
      type: 'image',
      source: { type: 'base64', media_type: f.mimetype, data: buf.toString('base64') },
    };
  }
  if (f.mimetype === 'application/pdf') {
    const buf = await readFile(fullPath);
    return {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') },
    };
  }
  if (TEXT_MIMES.has(f.mimetype) || f.mimetype.startsWith('text/')) {
    const buf = await readFile(fullPath);
    const truncated =
      buf.byteLength > TEXT_BYTE_CAP
        ? `${buf.subarray(0, TEXT_BYTE_CAP).toString('utf-8')}\n…[truncated ${buf.byteLength - TEXT_BYTE_CAP} bytes]`
        : buf.toString('utf-8');
    return { type: 'text', text: `[attached file: ${f.name}]\n\n${truncated}` };
  }
  return { type: 'text', text: `[attached: ${f.name} (${f.mimetype}) — not passed to model]` };
}

// Build the user-message content for a turn. With no files it's a plain string
// (the common path — keeps the SDK string-prompt fast path). With files it's a
// native content-block array: a leading text block (the user's prose + the
// `[attached:]` path hints, or just the hints) followed by one block per file.
export async function buildUserContent(
  threadKey: string,
  text: string,
  files: AttachmentRef[],
): Promise<string | UserContentBlock[]> {
  if (files.length === 0) return text;
  const blocks: UserContentBlock[] = [
    { type: 'text', text: appendSuffix(text, buildAttachedSuffix(files)) },
  ];
  for (const f of files) blocks.push(await attachmentToBlock(threadKey, f));
  return blocks;
}
