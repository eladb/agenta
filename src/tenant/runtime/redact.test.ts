import { describe, expect, it } from 'bun:test';
import { redact } from './redact';

describe('redact', () => {
  it('replaces openai-style keys', () => {
    expect(redact('key=sk-abc123def456ghi789jkl012')).toBe('key=<REDACTED>');
  });

  it('replaces slack tokens of every prefix', () => {
    expect(redact('xoxb-12345-67890-abcdef')).toBe('<REDACTED>');
    expect(redact('xapp-1-A0B-foo')).toBe('<REDACTED>');
    expect(redact('xoxp-12-foo-bar')).toBe('<REDACTED>');
    expect(redact('xoxe-1-foo')).toBe('<REDACTED>');
    expect(redact('xoxe.xoxp-1-foo')).toBe('<REDACTED>');
  });

  it('replaces PEM blocks', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvg...\n-----END PRIVATE KEY-----';
    expect(redact(`secret: ${pem} done`)).toBe('secret: <REDACTED> done');
  });

  it('leaves normal text alone', () => {
    expect(redact('plain error: connection refused')).toBe('plain error: connection refused');
  });
});
