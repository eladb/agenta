import { describe, expect, it } from 'bun:test';
import { threadKey } from './thread';

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
