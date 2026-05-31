import { describe, expect, it } from 'bun:test';
import { newEventId, nowIso } from './events';

describe('newEventId', () => {
  it('returns unique ids', () => {
    const a = newEventId();
    const b = newEventId();
    expect(a).not.toBe(b);
  });
  it('looks like a UUID', () => {
    expect(newEventId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe('nowIso', () => {
  it('is an ISO 8601 string parseable as a date', () => {
    const s = nowIso();
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.*Z$/);
    expect(Number.isNaN(Date.parse(s))).toBe(false);
  });
});
