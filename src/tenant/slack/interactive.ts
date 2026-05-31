import type { SocketModeClient } from '@slack/socket-mode';
import { log } from '../../shared/log';
import { getPendingAskByTs } from '../runtime/asks';

// Slack block_actions payload (subset we care about). Each action describes
// one user interaction — clicking a button, picking from a select, etc.
type Action = {
  action_id?: string;
  value?: string;
  selected_option?: { value?: string };
  selected_options?: Array<{ value?: string }>;
};

type Payload = {
  type?: string;
  actions?: Action[];
  message?: { ts?: string };
  container?: { message_ts?: string };
};

type SocketArgs = {
  body?: Payload;
  ack: () => Promise<void>;
};

// Action IDs used in the block-kit messages built by the ask_user tool.
export const ASK_ACTION_BUTTON = 'ask_user.button'; // value = chosen option
export const ASK_ACTION_SELECT = 'ask_user.select'; // selected_option.value = chosen
export const ASK_ACTION_MULTI = 'ask_user.multi'; // selected_options[].value (capture only)
export const ASK_ACTION_SUBMIT = 'ask_user.submit'; // resolves with the captured selection
export const ASK_ACTION_CANCEL = 'ask_user.cancel'; // rejects with "cancelled"

export function listenInteractive(socket: SocketModeClient): void {
  socket.on('interactive', async (args: SocketArgs) => {
    await args.ack();
    try {
      const payload = args.body;
      if (!payload || payload.type !== 'block_actions') return;
      const messageTs = payload.message?.ts ?? payload.container?.message_ts;
      if (!messageTs) return;
      const ask = getPendingAskByTs(messageTs);
      if (!ask) {
        // Stale click (timed out, cancelled, or bot restarted). Acknowledged
        // already; nothing else to do.
        log.info('interactive', `ignoring click on ${messageTs} — no pending ask`);
        return;
      }
      const action = payload.actions?.[0];
      if (!action) return;
      dispatch(ask, action);
    } catch (err) {
      log.error('interactive', 'handler threw', err);
    }
  });
}

function dispatch(ask: ReturnType<typeof getPendingAskByTs>, action: Action): void {
  if (!ask) return;
  const id = action.action_id ?? '';
  // Buttons use a per-option suffix (ASK_ACTION_BUTTON.<index>) because
  // Slack requires unique action_ids; the chosen value is in action.value.
  if (id.startsWith(`${ASK_ACTION_BUTTON}.`) || id === ASK_ACTION_BUTTON) {
    const v = action.value;
    if (typeof v === 'string') ask.resolve(v);
    return;
  }
  switch (id) {
    case ASK_ACTION_SELECT: {
      const v = action.selected_option?.value;
      if (typeof v === 'string') ask.resolve(v);
      return;
    }
    case ASK_ACTION_MULTI: {
      // Capture the latest selection set; don't resolve until Submit.
      const values = (action.selected_options ?? [])
        .map((o) => o.value)
        .filter((v): v is string => typeof v === 'string');
      ask.multiSelected = values;
      return;
    }
    case ASK_ACTION_SUBMIT: {
      ask.resolve(JSON.stringify(ask.multiSelected));
      return;
    }
    case ASK_ACTION_CANCEL: {
      ask.reject('cancelled');
      return;
    }
    default:
      log.warn('interactive', `unknown action_id: ${id}`);
  }
}
