// Small inline byte fixtures for attachment e2e tests. Each is the bare
// minimum the e2e suite needs: just enough for Slack to accept the upload and
// for file-type to recognize the bytes. The model is stubbed, so we don't
// need anything Anthropic-acceptable here.

// 1x1 transparent PNG (67 bytes). Valid signature + IHDR + IDAT + IEND.
const PNG_HEX =
  '89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D49444154789C636400010000050001D3D2A0F90000000049454E44AE426082';

export const PNG_BYTES: Buffer = Buffer.from(PNG_HEX, 'hex');

// Minimal valid PDF (~220 bytes). file-type detects it from the "%PDF-" magic.
export const PDF_BYTES: Buffer = Buffer.from(
  '%PDF-1.4\n' +
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n' +
    'xref\n0 4\n' +
    '0000000000 65535 f \n' +
    '0000000009 00000 n \n' +
    '0000000059 00000 n \n' +
    '0000000110 00000 n \n' +
    'trailer\n<< /Size 4 /Root 1 0 R >>\n' +
    'startxref\n177\n%%EOF\n',
);

export const TEXT_BYTES: Buffer = Buffer.from(
  'hello from agenta e2e\nthis is a plain text file.\n',
);

// Random-looking binary garbage. file-type returns null; UTF-8 sniffer fails;
// detectMime falls back to application/octet-stream.
export const BINARY_BYTES: Buffer = Buffer.from([
  0x00, 0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa, 0xc3, 0x28, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6,
]);
