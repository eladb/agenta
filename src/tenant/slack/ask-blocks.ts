import {
  ASK_ACTION_BUTTON,
  ASK_ACTION_CANCEL,
  ASK_ACTION_MULTI,
  ASK_ACTION_SELECT,
  ASK_ACTION_SUBMIT,
} from './interactive';

// biome-ignore lint/suspicious/noExplicitAny: block kit shapes are untyped on Web API
type Block = any;

// Slack caps option labels at 75 chars; truncate to be safe.
function shortOpt(s: string): string {
  return s.length > 75 ? `${s.slice(0, 74)}…` : s;
}

export function buildAskBlocks(
  kind: 'buttons' | 'select' | 'multi_select' | 'text',
  question: string,
  options: string[],
  placeholder?: string,
): Block[] {
  const header: Block = {
    type: 'section',
    text: { type: 'mrkdwn', text: question },
  };
  switch (kind) {
    case 'buttons': {
      // Slack requires action_id to be unique per block element. We use the
      // shared prefix ASK_ACTION_BUTTON so the dispatcher can match all
      // option buttons with a single startsWith() check; the index disambiguates.
      const buttons = options.slice(0, 25).map((opt, i) => ({
        type: 'button',
        text: { type: 'plain_text', text: shortOpt(opt) },
        value: opt,
        action_id: `${ASK_ACTION_BUTTON}.${i}`,
      }));
      return [header, { type: 'actions', elements: buttons }];
    }
    case 'select': {
      return [
        {
          ...header,
          accessory: {
            type: 'static_select',
            action_id: ASK_ACTION_SELECT,
            placeholder: { type: 'plain_text', text: placeholder ?? 'Choose…' },
            options: options.slice(0, 100).map((opt) => ({
              text: { type: 'plain_text', text: shortOpt(opt) },
              value: opt,
            })),
          },
        },
      ];
    }
    case 'multi_select': {
      return [
        {
          ...header,
          accessory: {
            type: 'multi_static_select',
            action_id: ASK_ACTION_MULTI,
            placeholder: { type: 'plain_text', text: placeholder ?? 'Choose any…' },
            options: options.slice(0, 100).map((opt) => ({
              text: { type: 'plain_text', text: shortOpt(opt) },
              value: opt,
            })),
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Submit' },
              style: 'primary',
              action_id: ASK_ACTION_SUBMIT,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Cancel' },
              action_id: ASK_ACTION_CANCEL,
            },
          ],
        },
      ];
    }
    case 'text': {
      return [
        header,
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: placeholder
                ? `_Reply in this thread — ${placeholder}_`
                : '_Reply in this thread._',
            },
          ],
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Cancel' },
              action_id: ASK_ACTION_CANCEL,
            },
          ],
        },
      ];
    }
  }
}
