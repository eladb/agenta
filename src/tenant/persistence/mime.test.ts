import { describe, expect, it } from 'bun:test';
import { detectMime } from './mime';

function bytes(...nums: number[]): Uint8Array {
  return Uint8Array.from(nums);
}

describe('detectMime', () => {
  it('detects PNG from magic bytes', async () => {
    // PNG: 8-byte signature + IHDR length + IHDR tag + 13 bytes IHDR data
    const png = bytes(
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      0x00,
      0x00,
      0x00,
      0x0d,
      0x49,
      0x48,
      0x44,
      0x52,
      0x00,
      0x00,
      0x00,
      0x01,
      0x00,
      0x00,
      0x00,
      0x01,
      0x08,
      0x02,
      0x00,
      0x00,
      0x00,
    );
    expect(await detectMime(png)).toBe('image/png');
  });

  it('detects JPEG from magic bytes', async () => {
    const jpeg = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01);
    expect(await detectMime(jpeg)).toBe('image/jpeg');
  });

  it('detects GIF from magic bytes', async () => {
    const gif = bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00);
    expect(await detectMime(gif)).toBe('image/gif');
  });

  it('detects PDF from magic bytes', async () => {
    const pdf = bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34);
    expect(await detectMime(pdf)).toBe('application/pdf');
  });

  it('classifies plain ASCII text as text/plain', async () => {
    const text = new TextEncoder().encode('hello, world\nthis is plain text\n');
    expect(await detectMime(text)).toBe('text/plain');
  });

  it('classifies UTF-8 text with multibyte chars as text/plain', async () => {
    const text = new TextEncoder().encode('héllo — π ≈ 3.14');
    expect(await detectMime(text)).toBe('text/plain');
  });

  it('falls back to octet-stream for random binary noise', async () => {
    const noise = new Uint8Array(256);
    for (let i = 0; i < 256; i++) noise[i] = i;
    expect(await detectMime(noise)).toBe('application/octet-stream');
  });

  it('returns octet-stream for empty buffer', async () => {
    expect(await detectMime(new Uint8Array(0))).toBe('application/octet-stream');
  });

  it('overrides a mismatched extension: PNG bytes named as .txt are still image/png', async () => {
    // detectMime ignores names entirely — only bytes matter
    const png = bytes(
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      0x00,
      0x00,
      0x00,
      0x0d,
      0x49,
      0x48,
      0x44,
      0x52,
      0x00,
      0x00,
      0x00,
      0x01,
      0x00,
      0x00,
      0x00,
      0x01,
      0x08,
      0x02,
      0x00,
      0x00,
      0x00,
    );
    expect(await detectMime(png)).toBe('image/png');
  });
});
