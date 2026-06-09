import { afterEach, describe, expect, test } from 'bun:test';
import { _resetAsks, getPendingAskByTs, registerAsk } from '../runtime/asks';
import {
  ASK_ACTION_BUTTON,
  ASK_ACTION_CANCEL,
  ASK_ACTION_MULTI,
  ASK_ACTION_SELECT,
  ASK_ACTION_SUBMIT,
  handleInteractivePayload,
} from './interactive';

afterEach(() => {
  _resetAsks();
});

function block_actions(messageTs: string, actions: Array<Record<string, unknown>>): object {
  return {
    type: 'block_actions',
    message: { ts: messageTs },
    actions,
  };
}

// `handleInteractivePayload` runs after the HTTP boundary has already acked
// Slack (#253); these tests assert the dispatch from a raw block_actions
// payload directly. The Socket-Mode-attached version is gone.
describe('handleInteractivePayload — block_actions dispatch', () => {
  test('button click (action_id with index suffix) resolves the pending ask with action.value', async () => {
    const promise = registerAsk({
      messageTs: 't1',
      threadKey: 'k1',
      kind: 'buttons',
      timeoutMs: 60_000,
      onSettle: () => {},
    });
    handleInteractivePayload(
      block_actions('t1', [{ action_id: `${ASK_ACTION_BUTTON}.1`, value: 'postgres' }]),
    );
    expect(await promise).toBe('postgres');
  });

  test('static_select resolves with selected_option.value', async () => {
    const promise = registerAsk({
      messageTs: 't2',
      threadKey: 'k2',
      kind: 'select',
      timeoutMs: 60_000,
      onSettle: () => {},
    });
    handleInteractivePayload(
      block_actions('t2', [{ action_id: ASK_ACTION_SELECT, selected_option: { value: 'mysql' } }]),
    );
    expect(await promise).toBe('mysql');
  });

  test('multi_static_select captures selections but does not resolve until Submit', async () => {
    const promise = registerAsk({
      messageTs: 't3',
      threadKey: 'k3',
      kind: 'multi_select',
      timeoutMs: 60_000,
      onSettle: () => {},
    });
    handleInteractivePayload(
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
    handleInteractivePayload(block_actions('t3', [{ action_id: ASK_ACTION_SUBMIT }]));
    expect(await promise).toBe('["a","b"]');
  });

  test('cancel button resolves the deferred with "cancelled"', async () => {
    const promise = registerAsk({
      messageTs: 't4',
      threadKey: 'k4',
      kind: 'text',
      timeoutMs: 60_000,
      onSettle: () => {},
    });
    handleInteractivePayload(block_actions('t4', [{ action_id: ASK_ACTION_CANCEL }]));
    expect(await promise).toBe('cancelled');
  });

  test('click on an unknown message ts is a silent no-op (no throw)', () => {
    expect(() =>
      handleInteractivePayload(
        block_actions('no-such-ts', [{ action_id: `${ASK_ACTION_BUTTON}.0`, value: 'a' }]),
      ),
    ).not.toThrow();
  });

  test('non block_actions payloads are ignored', () => {
    expect(() => handleInteractivePayload({ type: 'view_submission' })).not.toThrow();
  });

  // Turn-feedback buttons (#285): their own interaction — no pending ask to
  // resolve. The handler just acks (already done upstream) and records.
  test('turn_feedback click (positive) is handled without a pending ask, no throw', () => {
    expect(() =>
      handleInteractivePayload(
        block_actions('streamTs', [{ action_id: 'turn_feedback', value: 'up' }]),
      ),
    ).not.toThrow();
  });

  test('turn_feedback negative click does not resolve an unrelated pending ask', async () => {
    const promise = registerAsk({
      messageTs: 'askTs',
      threadKey: 'kf',
      kind: 'text',
      timeoutMs: 60_000,
      onSettle: () => {},
    });
    // A feedback click on a DIFFERENT message must not touch the pending ask.
    handleInteractivePayload(
      block_actions('streamTs', [{ action_id: 'turn_feedback', value: 'down' }]),
    );
    expect(getPendingAskByTs('askTs')).toBeDefined();
    // Clean up the still-pending ask so the test doesn't leak a timer.
    getPendingAskByTs('askTs')?.reject('cleanup');
    await promise;
  });
});
