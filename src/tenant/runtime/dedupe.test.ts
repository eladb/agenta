import { describe, expect, it } from 'bun:test';
import { createDedupe, dedupeKey } from './dedupe';

describe('dedupeKey', () => {
  it('uses native event id when present', () => {
    const k = dedupeKey({
      eventId: 'Ev123',
      channel: 'C',
      threadTs: '1',
      user: 'U',
      ts: '1',
      text: 'hi',
    });
    expect(k).toBe('id:Ev123');
  });

  it('falls back to deterministic composite when event id missing', () => {
    const a = dedupeKey({ channel: 'C', threadTs: '1', user: 'U', ts: '2', text: 'hi' });
    const b = dedupeKey({ channel: 'C', threadTs: '1', user: 'U', ts: '2', text: 'hi' });
    expect(a).toBe(b);
    expect(a.startsWith('fb:')).toBe(true);
  });

  it('produces different keys for different payloads', () => {
    const a = dedupeKey({ channel: 'C', threadTs: '1', user: 'U', ts: '2', text: 'hi' });
    const b = dedupeKey({ channel: 'C', threadTs: '1', user: 'U', ts: '2', text: 'bye' });
    expect(a).not.toBe(b);
  });
});

describe('createDedupe', () => {
  it('returns false the first time, true on repeats', () => {
    const isDup = createDedupe();
    expect(isDup('a')).toBe(false);
    expect(isDup('a')).toBe(true);
    expect(isDup('b')).toBe(false);
  });

  it('evicts oldest beyond maxSize', () => {
    const isDup = createDedupe(2);
    expect(isDup('a')).toBe(false); // [a]
    expect(isDup('b')).toBe(false); // [a, b]
    expect(isDup('c')).toBe(false); // adding c evicts oldest 'a' -> [b, c]
    expect(isDup('b')).toBe(true);
    expect(isDup('c')).toBe(true);
    expect(isDup('a')).toBe(false); // 'a' was evicted; treated as new
  });
});
