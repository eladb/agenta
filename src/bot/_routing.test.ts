// Routing-decision unit tests (#253). Exercises `decideRoute` against
// realistic Slack envelope shapes — event_callback (channel inside `event`)
// and interactive (top-level `channel.id` / `team.id`) — plus the two drop
// reasons (no team_id, unrouted workspace). No real Slack, no HTTP.

import { describe, expect, test } from 'bun:test';
import type { TenantsConfig } from '../shared/types';
import { decideRoute } from './routing';
import type { SocketEnvelope } from './socket';

const TENANTS: TenantsConfig['tenants'] = {
  agentalabs: { url: 'https://tenant-a.internal/', auth_env: 'TENANT_A_SECRET' },
  acme: { url: 'https://tenant-b.internal/', auth_env: 'TENANT_B_SECRET' },
};

const HOME_DEFAULT = {
  remote: 'https://github.com/eladb/agenta-test-home',
  auth_env: 'GITHUB_TOKEN',
};
const HOME_ALT = {
  remote: 'git@github.com:eladb/agenta-test-home-alone.git',
  auth_env: 'AGENTA_TEST_HOME_ALONE_DEPLOY_KEY',
};

const XOXB = 'xoxb-stub-123';

function eventCallback(team: string, channel: string): SocketEnvelope {
  return {
    envelope_id: 'env-1',
    type: 'event_callback',
    payload: {
      team_id: team,
      event: { type: 'message', channel, text: 'hi', ts: '1234.5678' },
    },
  };
}

function interactive(team: string, channel: string): SocketEnvelope {
  return {
    envelope_id: 'env-2',
    type: 'interactive',
    payload: {
      team: { id: team },
      channel: { id: channel },
      type: 'block_actions',
    },
  };
}

function configWith(routes: TenantsConfig['routes']): TenantsConfig {
  return { tenants: TENANTS, routes };
}

describe('decideRoute', () => {
  test('event_callback with workspace-default route resolves to the default tenant', () => {
    const cfg = configWith({
      T0B304AJPUZ: { default: { tenant: 'agentalabs', home: HOME_DEFAULT } },
    });
    const decision = decideRoute(eventCallback('T0B304AJPUZ', 'C_ANY'), cfg, XOXB);
    expect(decision.kind).toBe('routed');
    if (decision.kind !== 'routed') return;
    expect(decision.tenant).toBe('agentalabs');
    expect(decision.envelope.workspace_id).toBe('T0B304AJPUZ');
    expect(decision.envelope.xoxb).toBe(XOXB);
    expect(decision.envelope.home.remote).toBe(HOME_DEFAULT.remote);
    expect(decision.envelope.type).toBe('event_callback');
  });

  test('event_callback channel override beats workspace default', () => {
    const cfg = configWith({
      T: {
        default: { tenant: 'agentalabs', home: HOME_DEFAULT },
        channels: { C_SPECIAL: { tenant: 'acme', home: HOME_ALT } },
      },
    });
    const decision = decideRoute(eventCallback('T', 'C_SPECIAL'), cfg, XOXB);
    expect(decision.kind).toBe('routed');
    if (decision.kind !== 'routed') return;
    expect(decision.tenant).toBe('acme');
    expect(decision.envelope.home.remote).toBe(HOME_ALT.remote);
  });

  test('interactive envelope resolves via team.id + channel.id', () => {
    const cfg = configWith({
      T: { default: { tenant: 'agentalabs', home: HOME_DEFAULT } },
    });
    const decision = decideRoute(interactive('T', 'C1'), cfg, XOXB);
    expect(decision.kind).toBe('routed');
    if (decision.kind !== 'routed') return;
    expect(decision.tenant).toBe('agentalabs');
    expect(decision.envelope.type).toBe('interactive');
    expect(decision.envelope.workspace_id).toBe('T');
  });

  test('unrouted workspace is dropped with reason "unrouted"', () => {
    const cfg = configWith({
      T_KNOWN: { default: { tenant: 'agentalabs', home: HOME_DEFAULT } },
    });
    const decision = decideRoute(eventCallback('T_UNKNOWN', 'C'), cfg, XOXB);
    expect(decision.kind).toBe('dropped');
    if (decision.kind !== 'dropped') return;
    expect(decision.reason).toBe('unrouted');
  });

  test('channels-only workspace drops a non-matching channel', () => {
    const cfg = configWith({
      T: { channels: { C1: { tenant: 'acme', home: HOME_DEFAULT } } },
    });
    const decision = decideRoute(eventCallback('T', 'C_MISS'), cfg, XOXB);
    expect(decision.kind).toBe('dropped');
    if (decision.kind !== 'dropped') return;
    expect(decision.reason).toBe('unrouted');
  });

  test('missing team_id drops with reason "no-team"', () => {
    const cfg = configWith({
      T: { default: { tenant: 'agentalabs', home: HOME_DEFAULT } },
    });
    const decision = decideRoute(
      {
        envelope_id: 'env-x',
        type: 'event_callback',
        payload: { event: { channel: 'C1' } },
      },
      cfg,
      XOXB,
    );
    expect(decision.kind).toBe('dropped');
    if (decision.kind !== 'dropped') return;
    expect(decision.reason).toBe('no-team');
  });

  test('event_callback without a channel still resolves via workspace default', () => {
    // app_mention DM-style or workspace-level events without a `channel` field
    // are rare but possible; we treat them as workspace-level and let the
    // default route catch them.
    const cfg = configWith({
      T: { default: { tenant: 'agentalabs', home: HOME_DEFAULT } },
    });
    const decision = decideRoute(
      {
        envelope_id: 'env-no-chan',
        type: 'event_callback',
        payload: { team_id: 'T', event: { type: 'app_uninstalled' } },
      },
      cfg,
      XOXB,
    );
    expect(decision.kind).toBe('routed');
    if (decision.kind !== 'routed') return;
    expect(decision.tenant).toBe('agentalabs');
  });

  test('forwards the original payload by reference (lossless)', () => {
    const cfg = configWith({
      T: { default: { tenant: 'agentalabs', home: HOME_DEFAULT } },
    });
    const env = eventCallback('T', 'C');
    const decision = decideRoute(env, cfg, XOXB);
    expect(decision.kind).toBe('routed');
    if (decision.kind !== 'routed') return;
    expect(decision.envelope.payload).toBe(env.payload);
    expect(decision.envelope.envelope_id).toBe(env.envelope_id);
  });
});
