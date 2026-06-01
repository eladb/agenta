# SETUP

Both Slack apps are created via the manifest API from this repo. You provide a one-time configuration token; the script does the rest.

## 0. Get a Slack configuration token (once per 12h)

1. Visit <https://api.slack.com/reference/manifests#config-tokens>.
2. Pick your workspace, click **Generate Token**.
3. Copy both values into your shell:

```sh
export SLACK_CONFIG_ACCESS_TOKEN=xoxe.xoxp-...
export SLACK_CONFIG_REFRESH_TOKEN=xoxe-...
```

The script auto-refreshes when the access token expires (the refresh token is long-lived).

## 1. Run setup

```sh
bun install
bun run setup
```

The script will:

1. Create the **agent** app from `slack-manifests/agent.json`.
2. Create the **tester** app from `slack-manifests/tester.json`.
3. Print install URLs for both — you click "Install to Workspace" in each.
4. Prompt you to paste each app's Bot User OAuth Token (`xoxb-...`).
5. Print deep-links to each app's **App-Level Token** page — click "Generate Token and Scopes" with scope `connections:write`, copy the `xapp-...` value, paste back.
6. Prompt for `TEST_CHANNEL_ID` (the channel both bots will live in).
7. Write `.env`.

App IDs are cached in `.slack-apps.json` so re-running is idempotent (skips already-created apps).

## 2. Invite both bots to the test channel

```
/invite @agenta
/invite @agenta-tester
```

## 3. Run

- Unit tests:   `bun run test`
- E2E tests:    `bun run e2e`
- Start agent:  `bun start`

## Tear down

```sh
bun run setup --delete
```

Deletes both apps via `apps.manifest.delete` and clears the cache. `.env` is left in place — remove it manually if you also want to wipe tokens.

## Re-create from scratch

```sh
bun run setup --delete
rm .env
bun run setup --force
```
