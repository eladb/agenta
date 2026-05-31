import { afterEach, describe, expect, test } from 'bun:test';
import {
  _resetAsks,
  AskInUseError,
  getPendingAskByThread,
  getPendingAskByTs,
  registerAsk,
  resolveByThreadText,
} from './asks';

afterEach(() => {
  _resetAsks();
});

describe('asks registry', () => {
  test('registerAsk resolves when ask.resolve is called', async () => {
    let settledKind: string | undefined;
    const promise = registerAsk({
      messageTs: 't1',
      threadKey: 'k1',
      kind: 'buttons',
      timeoutMs: 60_000,
      onSettle: (kind) => {
        settledKind = kind;
      },
    });
    getPendingAskByTs('t1')?.resolve('postgres');
    expect(await promise).toBe('postgres');
    expect(settledKind).toBe('answer');
    // Cleanup: no longer pending.
    expect(getPendingAskByTs('t1')).toBeUndefined();
    expect(getPendingAskByThread('k1')).toBeUndefined();
  });

  test('registerAsk rejects via reject() with "cancelled"', async () => {
    let settledKind: string | undefined;
    const promise = registerAsk({
      messageTs: 't2',
      threadKey: 'k2',
      kind: 'text',
      timeoutMs: 60_000,
      onSettle: (kind) => {
        settledKind = kind;
      },
    });
    getPendingAskByTs('t2')?.reject('user cancel');
    expect(await promise).toBe('cancelled');
    expect(settledKind).toBe('cancel');
  });

  test('timeout fires after timeoutMs', async () => {
    let settledKind: string | undefined;
    const promise = registerAsk({
      messageTs: 't3',
      threadKey: 'k3',
      kind: 'text',
      timeoutMs: 30,
      onSettle: (kind) => {
        settledKind = kind;
      },
    });
    expect(await promise).toBe('timeout');
    expect(settledKind).toBe('timeout');
  });

  test('double-register on the same thread throws AskInUseError', async () => {
    const first = registerAsk({
      messageTs: 'ta',
      threadKey: 'thread-x',
      kind: 'text',
      timeoutMs: 60_000,
      onSettle: () => {},
    });
    expect(() =>
      registerAsk({
        messageTs: 'tb',
        threadKey: 'thread-x',
        kind: 'text',
        timeoutMs: 60_000,
        onSettle: () => {},
      }),
    ).toThrow(AskInUseError);
    getPendingAskByTs('ta')?.resolve('done');
    expect(await first).toBe('done');
  });

  test('resolveByThreadText resolves the pending ask for that thread', async () => {
    const promise = registerAsk({
      messageTs: 'tt',
      threadKey: 'kk',
      kind: 'text',
      timeoutMs: 60_000,
      onSettle: () => {},
    });
    const matched = resolveByThreadText('kk', 'my reply');
    expect(matched).toBe(true);
    expect(await promise).toBe('my reply');
  });

  test('resolveByThreadText returns false when no ask pending', () => {
    expect(resolveByThreadText('unknown-thread', 'whatever')).toBe(false);
  });

  test('multi_select accumulates multiSelected, Submit returns JSON array', async () => {
    const promise = registerAsk({
      messageTs: 'tm',
      threadKey: 'km',
      kind: 'multi_select',
      timeoutMs: 60_000,
      onSettle: () => {},
    });
    const ask = getPendingAskByTs('tm');
    if (!ask) throw new Error('ask not registered');
    ask.multiSelected = ['a', 'b', 'c'];
    // Simulate Submit click → tool resolves with JSON array of multiSelected.
    ask.resolve(JSON.stringify(ask.multiSelected));
    expect(await promise).toBe('["a","b","c"]');
  });
});
