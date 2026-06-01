import { describe, expect, it } from 'bun:test';
import { decodeThreadKey, threadKey } from './thread';

describe('threadKey', () => {
  it('joins channel and thread_ts with double underscore', () => {
    expect(threadKey('C123', '1700000000_000100')).toBe('C123__1700000000_000100');
  });

  it('replaces all dots in thread_ts with underscores', () => {
    expect(threadKey('C123', '1700000000.000100')).toBe('C123__1700000000_000100');
  });

  it('is deterministic for the same inputs', () => {
    expect(threadKey('C', '1.2')).toBe(threadKey('C', '1.2'));
  });
});

describe('decodeThreadKey', () => {
  it('roundtrips a Slack-shaped thread key', () => {
    const tk = threadKey('C0B307LP274', '1778580834.616069');
    expect(decodeThreadKey(tk)).toEqual({
      channel: 'C0B307LP274',
      threadTs: '1778580834.616069',
    });
  });

  it('returns undefined for keys missing the separator', () => {
    expect(decodeThreadKey('no-separator')).toBeUndefined();
  });

  it('returns undefined for keys with no underscore in the ts portion', () => {
    expect(decodeThreadKey('C__123456')).toBeUndefined();
  });
});
