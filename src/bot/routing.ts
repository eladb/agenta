// Pure routing decision for the bot dispatch loop (#253).
//
// Pulled out of `index.ts` so unit tests can exercise the full decision tree
// without importing the entry module (which acquires the lockfile, opens
// Socket Mode, and exits if env vars are missing). Pure function: a Slack
// envelope + tenants config + xoxb in → a `RoutingDecision` out.
//
// Extracts (team_id, channel_id?) from two distinct Slack payload shapes:
//   - event_callback: top-level `team_id`, channel inside `event.channel`.
//   - interactive   : top-level `team.id`, `channel.id`.
// Falls through to `null` for either when the field is missing — the caller
// drops the event with reason `no-team` or `unrouted`.

import { resolveRoute } from '../shared/routes';
import type { EventEnvelope, TenantsConfig } from '../shared/types';
import type { SocketEnvelope } from './socket';

export type RoutingDecision =
  | { kind: 'dropped'; reason: 'no-team' | 'unrouted'; teamId?: string; channelId?: string }
  | { kind: 'routed'; tenant: string; envelope: EventEnvelope };

export function extractTeamId(payload: Record<string, unknown>): string | null {
  const direct = payload.team_id;
  if (typeof direct === 'string') return direct;
  const team = payload.team;
  if (team && typeof team === 'object' && typeof (team as { id?: unknown }).id === 'string') {
    return (team as { id: string }).id;
  }
  return null;
}

export function extractChannelId(payload: Record<string, unknown>): string | undefined {
  const event = payload.event;
  if (event && typeof event === 'object') {
    const c = (event as { channel?: unknown }).channel;
    if (typeof c === 'string') return c;
  }
  const channel = payload.channel;
  if (channel && typeof channel === 'object') {
    const id = (channel as { id?: unknown }).id;
    if (typeof id === 'string') return id;
  }
  return undefined;
}

export function decideRoute(
  socketEnv: SocketEnvelope,
  config: TenantsConfig,
  xoxb: string,
): RoutingDecision {
  const teamId = extractTeamId(socketEnv.payload);
  if (!teamId) return { kind: 'dropped', reason: 'no-team' };
  const channelId = extractChannelId(socketEnv.payload);
  const target = resolveRoute(config, teamId, channelId);
  if (!target) return { kind: 'dropped', reason: 'unrouted', teamId, channelId };
  // Spec restricts envelope `type` to event_callback | interactive; the
  // socket layer only registers handlers for those two, so a third value
  // would never reach here. Narrow at the boundary.
  const type: EventEnvelope['type'] =
    socketEnv.type === 'interactive' ? 'interactive' : 'event_callback';
  const envelope: EventEnvelope = {
    envelope_id: socketEnv.envelope_id,
    type,
    workspace_id: teamId,
    xoxb,
    home: target.home,
    payload: socketEnv.payload,
  };
  return { kind: 'routed', tenant: target.tenant, envelope };
}
