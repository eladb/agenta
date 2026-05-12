import { afterEach, describe, expect, mock, test } from 'bun:test';
import { _resetAsks, getPendingAskByTs, registerAsk } from '../runtime/asks';
import {
  ASK_ACTION_BUTTON,
  ASK_ACTION_CANCEL,
  ASK_ACTION_MULTI,
  ASK_ACTION_SELECT,
  ASK_ACTION_SUBMIT,
  listenInteractive,
} from './interactive';

afterEach(() => {
  _resetAsks();
});

// Minimal Socket Mode shim — captures the registered handler so we can fire
// synthetic block_actions payloads at it.
function makeSocketStub(): {
  socket: { on: (event: string, fn: (args: unknown) => Promise<void>) => void };
  send: (payload: unknown) => Promise<{ acked: boolean }>;
} {
  let handler: ((args: unknown) => Promise<void>) | undefined;
  const socket = {
    on: mock((event: string, fn: (args: unknown) => Promise<void>) => {
      if (event === 'interactive') handler = fn;
    }),
  };
  const send = async (payload: unknown): Promise<{ acked: boolean }> => {
    if (!handler) throw new Error('listenInteractive did not register an interactive handler');
    let acked = false;
    await handler({ body: payload, ack: async () => void (acked = true) });
    return { acked };
  };
  return { socket, send };
}

function block_actions(messageTs: string, actions: Array<Record<string, unknown>>): object {
  return {
    type: 'block_actions',
    message: { ts: messageTs },
    actions,
  };
}

describe('listenInteractive — block_actions dispatch', () => {
  test('button click (action_id with index suffix) resolves the pending ask with action.value', async () => {
    const { socket, send } = makeSocketStub();
    listenInteractive(socket as unknown as Parameters<typeof listenInteractive>[0]);
    const promise = registerAsk({
      messageTs: 't1',
      threadKey: 'k1',
      kind: 'buttons',
      timeoutMs: 60_000,
      onSettle: () => {},
    });
    const { acked } = await send(
      block_actions('t1', [{ action_id: `${ASK_ACTION_BUTTON}.1`, value: 'postgres' }]),
    );
    expect(acked).toBe(true);
    expect(await promise).toBe('postgres');
  });

  test('static_select resolves with selected_option.value', async () => {
    const { socket, send } = makeSocketStub();
    listenInteractive(socket as unknown as Parameters<typeof listenInteractive>[0]);
    const promise = registerAsk({
      messageTs: 't2',
      threadKey: 'k2',
      kind: 'select',
      timeoutMs: 60_000,
      onSettle: () => {},
    });
    await send(
      block_actions('t2', [{ action_id: ASK_ACTION_SELECT, selected_option: { value: 'mysql' } }]),
    );
    expect(await promise).toBe('mysql');
  });

  test('multi_static_select captures selections but does not resolve until Submit', async () => {
    const { socket, send } = makeSocketStub();
    listenInteractive(socket as unknown as Parameters<typeof listenInteractive>[0]);
    const promise = registerAsk({
      messageTs: 't3',
      threadKey: 'k3',
      kind: 'multi_select',
      timeoutMs: 60_000,
      onSettle: () => {},
    });
    await send(
      block_actions('t3', [
        {
          action_id: ASK_ACTION_MULTI,
          selected_options: [{ value: 'a' }, { value: 'b' }],
        },
      ]),
    );
    // Still pending.
    expect(getPendingAskByTs('t3')?.multiSelected).toEqual(['a', 'b']);
    // Submit click → resolves with JSON-stringified selection.
    await send(block_actions('t3', [{ action_id: ASK_ACTION_SUBMIT }]));
    expect(await promise).toBe('["a","b"]');
  });

  test('cancel button resolves the deferred with "cancelled"', async () => {
    const { socket, send } = makeSocketStub();
    listenInteractive(socket as unknown as Parameters<typeof listenInteractive>[0]);
    const promise = registerAsk({
      messageTs: 't4',
      threadKey: 'k4',
      kind: 'text',
      timeoutMs: 60_000,
      onSettle: () => {},
    });
    await send(block_actions('t4', [{ action_id: ASK_ACTION_CANCEL }]));
    expect(await promise).toBe('cancelled');
  });

  test('click on an unknown message ts is ack-and-ignore (no throw)', async () => {
    const { socket, send } = makeSocketStub();
    listenInteractive(socket as unknown as Parameters<typeof listenInteractive>[0]);
    const { acked } = await send(
      block_actions('no-such-ts', [{ action_id: `${ASK_ACTION_BUTTON}.0`, value: 'a' }]),
    );
    expect(acked).toBe(true);
  });

  test('non block_actions payloads are ignored', async () => {
    const { socket, send } = makeSocketStub();
    listenInteractive(socket as unknown as Parameters<typeof listenInteractive>[0]);
    const { acked } = await send({ type: 'view_submission' });
    expect(acked).toBe(true);
  });
});
