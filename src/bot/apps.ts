// Slack app list for the ingress bot — supports N workspaces, one Socket Mode
// connection per app (no OAuth; operator-configured).
//
// Multi-app: SLACK_APPS_JSON is a JSON array of { appTokenEnv, botTokenEnv } —
// each names (does NOT inline) the xapp-/xoxb- env vars the bot resolves from
// its own env, mirroring the auth_env indirection in tenants.json. The bot
// opens one Socket Mode connection per entry and threads that app's bot token
// as the per-event xoxb.
//
// Single-app fallback (back-compat, pre-multi-workspace): SLACK_APP_TOKEN +
// SLACK_BOT_TOKEN.
//
// Pure + env-injected so it's unit-testable without process.env.

export type SlackApp = { appToken: string; botToken: string };

type Env = Record<string, string | undefined>;

function nonEmpty(v: string | undefined): v is string {
  return typeof v === 'string' && v.length > 0;
}

export function parseSlackApps(env: Env): SlackApp[] {
  const raw = env.SLACK_APPS_JSON;
  if (nonEmpty(raw) && raw.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`SLACK_APPS_JSON is not valid JSON: ${(err as Error).message}`);
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('SLACK_APPS_JSON must be a non-empty array of {appTokenEnv, botTokenEnv}');
    }
    const seenTokens = new Set<string>();
    return parsed.map((entry, i) => {
      if (typeof entry !== 'object' || entry === null) {
        throw new Error(`SLACK_APPS_JSON[${i}] must be an object`);
      }
      const { appTokenEnv, botTokenEnv } = entry as Record<string, unknown>;
      if (typeof appTokenEnv !== 'string' || appTokenEnv.length === 0) {
        throw new Error(`SLACK_APPS_JSON[${i}].appTokenEnv required (non-empty string)`);
      }
      if (typeof botTokenEnv !== 'string' || botTokenEnv.length === 0) {
        throw new Error(`SLACK_APPS_JSON[${i}].botTokenEnv required (non-empty string)`);
      }
      const appToken = env[appTokenEnv];
      const botToken = env[botTokenEnv];
      if (!nonEmpty(appToken)) {
        throw new Error(`SLACK_APPS_JSON[${i}]: env var ${appTokenEnv} is unset/empty`);
      }
      if (!nonEmpty(botToken)) {
        throw new Error(`SLACK_APPS_JSON[${i}]: env var ${botTokenEnv} is unset/empty`);
      }
      // Two connections on the same xapp would split-brain Slack delivery.
      if (seenTokens.has(appToken)) {
        throw new Error(`SLACK_APPS_JSON[${i}]: duplicate app token (via ${appTokenEnv})`);
      }
      seenTokens.add(appToken);
      return { appToken, botToken };
    });
  }

  // Single-app fallback.
  const appToken = env.SLACK_APP_TOKEN;
  const botToken = env.SLACK_BOT_TOKEN;
  if (!nonEmpty(appToken) || !nonEmpty(botToken)) {
    throw new Error('SLACK_APP_TOKEN and SLACK_BOT_TOKEN required (or set SLACK_APPS_JSON)');
  }
  return [{ appToken, botToken }];
}
