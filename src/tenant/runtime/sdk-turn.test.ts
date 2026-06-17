import { describe, expect, test } from 'bun:test';
import { buildSdkEnv, guardLeadingSlash, stripBedrockScheme } from './sdk-turn';

describe('buildSdkEnv', () => {
  test('sets IS_SANDBOX=1 so bypassPermissions works as root (#334)', () => {
    // The harness runs permissionMode:'bypassPermissions'; Claude Code refuses
    // that as root unless IS_SANDBOX is set. The tenant container is root in
    // real deployments, so this env var is what keeps every turn from crashing.
    expect(buildSdkEnv().IS_SANDBOX).toBe('1');
  });
  test('forces prompt caching off + pins the SDK config dir', () => {
    const env = buildSdkEnv();
    expect(env.DISABLE_PROMPT_CACHING).toBe('1');
    expect(env.CLAUDE_CONFIG_DIR).toBeDefined();
  });
});

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
