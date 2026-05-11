import { describe, expect, it } from 'bun:test';
import { withLock } from './mutex';

describe('withLock', () => {
  it('serializes calls with the same key in arrival order', async () => {
    const log: string[] = [];
    const a = withLock('k', async () => {
      log.push('a-start');
      await new Promise((r) => setTimeout(r, 30));
      log.push('a-end');
    });
    const b = withLock('k', async () => {
      log.push('b-start');
      await new Promise((r) => setTimeout(r, 10));
      log.push('b-end');
    });
    await Promise.all([a, b]);
    expect(log).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('runs different keys concurrently', async () => {
    const ev: string[] = [];
    const a = withLock('x', async () => {
      ev.push('x-start');
      await new Promise((r) => setTimeout(r, 30));
      ev.push('x-end');
    });
    const b = withLock('y', async () => {
      ev.push('y-start');
      await new Promise((r) => setTimeout(r, 10));
      ev.push('y-end');
    });
    await Promise.all([a, b]);
    // y starts before x finishes -> overlap
    expect(ev.indexOf('y-start')).toBeLessThan(ev.indexOf('x-end'));
  });

  it('continues the chain after an error', async () => {
    const a = withLock('z', async () => {
      throw new Error('boom');
    });
    await expect(a).rejects.toThrow('boom');
    const b = await withLock('z', async () => 42);
    expect(b).toBe(42);
  });

  it('returns the value from fn', async () => {
    const v = await withLock('q', async () => 'hi');
    expect(v).toBe('hi');
  });
});
