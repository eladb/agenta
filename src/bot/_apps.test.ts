import { describe, expect, it } from 'bun:test';
import { parseSlackApps } from './apps';

describe('parseSlackApps', () => {
  it('falls back to single SLACK_APP_TOKEN/SLACK_BOT_TOKEN when SLACK_APPS_JSON is unset', () => {
    expect(parseSlackApps({ SLACK_APP_TOKEN: 'xapp-1', SLACK_BOT_TOKEN: 'xoxb-1' })).toEqual([
      { appToken: 'xapp-1', botToken: 'xoxb-1' },
    ]);
  });

  it('throws if neither SLACK_APPS_JSON nor the single-app pair is set', () => {
    expect(() => parseSlackApps({})).toThrow(/SLACK_APP_TOKEN and SLACK_BOT_TOKEN required/);
    expect(() => parseSlackApps({ SLACK_APP_TOKEN: 'xapp-1' })).toThrow(/required/);
  });

  it('resolves a multi-app list from env-var NAMES', () => {
    const env = {
      SLACK_APPS_JSON: JSON.stringify([
        { appTokenEnv: 'SLACK_APP_TOKEN', botTokenEnv: 'SLACK_BOT_TOKEN' },
        { appTokenEnv: 'SLACK_APP_TOKEN_ACME', botTokenEnv: 'SLACK_BOT_TOKEN_ACME' },
      ]),
      SLACK_APP_TOKEN: 'xapp-1',
      SLACK_BOT_TOKEN: 'xoxb-1',
      SLACK_APP_TOKEN_ACME: 'xapp-2',
      SLACK_BOT_TOKEN_ACME: 'xoxb-2',
    };
    expect(parseSlackApps(env)).toEqual([
      { appToken: 'xapp-1', botToken: 'xoxb-1' },
      { appToken: 'xapp-2', botToken: 'xoxb-2' },
    ]);
  });

  it('SLACK_APPS_JSON takes precedence over the single-app vars', () => {
    const env = {
      SLACK_APPS_JSON: JSON.stringify([{ appTokenEnv: 'A', botTokenEnv: 'B' }]),
      A: 'xapp-only',
      B: 'xoxb-only',
      SLACK_APP_TOKEN: 'xapp-ignored',
      SLACK_BOT_TOKEN: 'xoxb-ignored',
    };
    expect(parseSlackApps(env)).toEqual([{ appToken: 'xapp-only', botToken: 'xoxb-only' }]);
  });

  it('throws on malformed JSON / non-array / empty', () => {
    expect(() => parseSlackApps({ SLACK_APPS_JSON: '{not json' })).toThrow(/not valid JSON/);
    expect(() => parseSlackApps({ SLACK_APPS_JSON: '{}' })).toThrow(/non-empty array/);
    expect(() => parseSlackApps({ SLACK_APPS_JSON: '[]' })).toThrow(/non-empty array/);
  });

  it('throws when a referenced env var is unset/empty', () => {
    const env = {
      SLACK_APPS_JSON: JSON.stringify([{ appTokenEnv: 'MISSING_APP', botTokenEnv: 'MISSING_BOT' }]),
    };
    expect(() => parseSlackApps(env)).toThrow(/MISSING_APP is unset\/empty/);
  });

  it('throws on missing appTokenEnv/botTokenEnv keys', () => {
    expect(() => parseSlackApps({ SLACK_APPS_JSON: JSON.stringify([{ botTokenEnv: 'B' }]) })).toThrow(
      /appTokenEnv required/,
    );
  });

  it('rejects duplicate app tokens (would split-brain Socket Mode)', () => {
    const env = {
      SLACK_APPS_JSON: JSON.stringify([
        { appTokenEnv: 'A1', botTokenEnv: 'B1' },
        { appTokenEnv: 'A2', botTokenEnv: 'B2' },
      ]),
      A1: 'xapp-dup',
      B1: 'xoxb-1',
      A2: 'xapp-dup',
      B2: 'xoxb-2',
    };
    expect(() => parseSlackApps(env)).toThrow(/duplicate app token/);
  });
});
