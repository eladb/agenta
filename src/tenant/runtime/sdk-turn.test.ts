import { describe, expect, test } from 'bun:test';
import { guardLeadingSlash, stripBedrockScheme } from './sdk-turn';

describe('stripBedrockScheme', () => {
  test('strips a bedrock:// prefix', () => {
    expect(stripBedrockScheme('bedrock://us.anthropic.claude-sonnet-4-6')).toBe(
      'us.anthropic.claude-sonnet-4-6',
    );
  });
  test('leaves a bare model id unchanged', () => {
    expect(stripBedrockScheme('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
  });
});

describe('guardLeadingSlash', () => {
  test('prefixes a zero-width space when the text starts with /', () => {
    const out = guardLeadingSlash('/stop and please');
    expect(out).toBe('\u200B/stop and please');
    // The whole point: the SDK no longer sees a leading "/" to slash-parse.
    expect(out.startsWith('/')).toBe(false);
  });
  test('leaves text that does not start with / unchanged', () => {
    expect(guardLeadingSlash('hello /world')).toBe('hello /world');
    expect(guardLeadingSlash('plain text')).toBe('plain text');
    expect(guardLeadingSlash('')).toBe('');
  });
});
