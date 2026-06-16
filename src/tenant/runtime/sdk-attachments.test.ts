import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AttachmentRef } from '../persistence/events';
import { attachmentToBlock, buildAttachedSuffix, buildUserContent } from './sdk-attachments';

// sdk-attachments reads the on-disk copy under <AGENTA_DATA_DIR>/<threadKey>/<local_path>.
let dataDir: string;
let savedDataDir: string | undefined;
const TK = 'C1-T1';

function writeAttachment(name: string, bytes: Buffer): AttachmentRef {
  const fileId = `F_${name}`;
  const localName = `${fileId}-${name}`;
  mkdirSync(join(dataDir, TK, 'attachments'), { recursive: true });
  writeFileSync(join(dataDir, TK, 'attachments', localName), bytes);
  return { file_id: fileId, name, mimetype: '', local_path: `attachments/${localName}` };
}

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'sdk-attach-'));
  savedDataDir = process.env.AGENTA_DATA_DIR;
  process.env.AGENTA_DATA_DIR = dataDir;
});

afterAll(() => {
  if (savedDataDir === undefined) delete process.env.AGENTA_DATA_DIR;
  else process.env.AGENTA_DATA_DIR = savedDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

test('buildAttachedSuffix lists one path hint per file', () => {
  const suffix = buildAttachedSuffix([
    { file_id: 'F1', name: 'a.png', mimetype: 'image/png', local_path: 'attachments/F1-a.png' },
    {
      file_id: 'F2',
      name: 'b c.txt',
      mimetype: 'text/plain',
      local_path: 'attachments/F2-b c.txt',
    },
  ]);
  expect(suffix).toContain('[attached: attachments/F1-a.png]');
  // sanitize collapses spaces in the name half of the hint.
  expect(suffix).toContain('[attached: attachments/F2-b');
});

test('image attachment → native base64 image block', async () => {
  const png = Buffer.from('\x89PNG\r\n\x1a\nfake', 'binary');
  const ref = { ...writeAttachment('photo.png', png), mimetype: 'image/png' };
  const block = await attachmentToBlock(TK, ref);
  expect(block.type).toBe('image');
  if (block.type !== 'image') throw new Error('expected image');
  expect(block.source.media_type).toBe('image/png');
  expect(block.source.data).toBe(png.toString('base64'));
});

test('pdf attachment → native base64 document block', async () => {
  const pdf = Buffer.from('%PDF-1.4 fake', 'binary');
  const ref = { ...writeAttachment('doc.pdf', pdf), mimetype: 'application/pdf' };
  const block = await attachmentToBlock(TK, ref);
  expect(block.type).toBe('document');
  if (block.type !== 'document') throw new Error('expected document');
  expect(block.source.media_type).toBe('application/pdf');
  expect(block.source.data).toBe(pdf.toString('base64'));
});

test('text attachment → inlined text block with file header', async () => {
  const ref = {
    ...writeAttachment('notes.txt', Buffer.from('hello world')),
    mimetype: 'text/plain',
  };
  const block = await attachmentToBlock(TK, ref);
  expect(block.type).toBe('text');
  if (block.type !== 'text') throw new Error('expected text');
  expect(block.text).toContain('[attached file: notes.txt]');
  expect(block.text).toContain('hello world');
});

test('text attachment over the cap is truncated', async () => {
  const big = Buffer.alloc(25 * 1024, 0x61); // 25KB of 'a'
  const ref = { ...writeAttachment('big.txt', big), mimetype: 'text/plain' };
  const block = await attachmentToBlock(TK, ref);
  if (block.type !== 'text') throw new Error('expected text');
  expect(block.text).toContain('[truncated');
  expect(block.text.length).toBeLessThan(big.byteLength);
});

test('unknown binary → text placeholder, not inlined', async () => {
  const ref = {
    ...writeAttachment('blob.bin', Buffer.from([0, 1, 2, 3])),
    mimetype: 'application/octet-stream',
  };
  const block = await attachmentToBlock(TK, ref);
  expect(block.type).toBe('text');
  if (block.type !== 'text') throw new Error('expected text');
  expect(block.text).toContain('not passed to model');
  expect(block.text).toContain('application/octet-stream');
});

test('buildUserContent: no files → plain string', async () => {
  const content = await buildUserContent(TK, 'just text', []);
  expect(content).toBe('just text');
});

test('buildUserContent: files → leading text block (prose + hints) then file blocks', async () => {
  const ref = { ...writeAttachment('pic.png', Buffer.from('img')), mimetype: 'image/png' };
  const content = await buildUserContent(TK, 'what is this', [ref]);
  expect(Array.isArray(content)).toBe(true);
  if (!Array.isArray(content)) throw new Error('expected blocks');
  expect(content[0]?.type).toBe('text');
  const first = content[0];
  if (first?.type !== 'text') throw new Error('expected text head');
  expect(first.text).toContain('what is this');
  expect(first.text).toContain('[attached: attachments/F_pic.png-pic.png]');
  expect(content[1]?.type).toBe('image');
});

test('buildUserContent: attachments with no prose → hints-only head block', async () => {
  const ref = { ...writeAttachment('only.png', Buffer.from('img')), mimetype: 'image/png' };
  const content = await buildUserContent(TK, '', [ref]);
  if (!Array.isArray(content)) throw new Error('expected blocks');
  const first = content[0];
  if (first?.type !== 'text') throw new Error('expected text head');
  expect(first.text.startsWith('[attached:')).toBe(true);
});
