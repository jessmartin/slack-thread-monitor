# Slack Thread Monitor

A local Kanban board for Slack threads that need attention.

The app listens to Slack Events API messages over Socket Mode, stores raw Slack event payloads plus projected cards in SQLite, and renders a three-column board in your local browser.

![Slack Thread Monitor board](docs/slack-thread-monitor.png)

## Behavior

- Live Slack events arrive over Socket Mode; there is no continuous history polling loop.
- Backfill is still available as an explicit action from `/settings`.
- A card is created only for a real Slack thread with at least one threaded reply where the tracked Slack user authored the root message or one of the replies.
- Top-level messages without replies, unrelated visible threads, and mentions alone are retained as raw events but do not create cards.
- Any new message in a tracked thread moves the card back to `New Message`.
- Cards can be moved to `Awaiting Reply` or `Resolved`.
- Resolved cards can be archived to hide them from the board; archived cards return when a newer Slack message arrives.
- Slack links use the native `slack://channel?...` URL so the Mac app opens by default.
- Linear issue IDs/URLs and GitHub issue/PR references are extracted and deduplicated.
- Optional Linear and GitHub tokens enrich references with title/state metadata.

## Architecture

- `src/server/main.ts` boots SQLite, the local HTTP API, and the Slack Socket Mode listener.
- `src/server/slack.ts` owns Slack Web API calls, Socket Mode event normalization, and one-shot backfill.
- `src/server/workflows.ts` contains thread tracking and status workflows.
- `src/server/store.ts` owns migrations and SQLite persistence.
- `src/client/App.tsx` renders the board and settings UI.
- `slack-app-manifest.yml` defines the Slack app scopes and user event subscriptions.

## Slack App Setup

Create a Slack app in the target workspace. For current testing, that workspace is **Elicit Internal**.

1. Open [api.slack.com/apps](https://api.slack.com/apps).
2. Choose **Create New App**.
3. Choose **From an app manifest**.
4. Select the target workspace.
5. Paste `slack-app-manifest.yml`.
6. Create the app.
7. On **Basic Information**, create an app-level token with `connections:write`. Copy the `xapp-...` token into `SLACK_APP_TOKEN`.
8. On **OAuth & Permissions**, install the app to the workspace. Copy the **User OAuth Token** into `SLACK_USER_TOKEN`.
9. Reinstall the app after any manifest or scope changes.

The two Slack tokens are separate:

- `SLACK_APP_TOKEN`: an `xapp-...` app-level token used only to open the Socket Mode connection.
- `SLACK_USER_TOKEN`: an `xoxp-...` user OAuth token used to identify the authorized Slack user and make user-scoped Web API calls.

`SLACK_APP_TOKEN` does not create or contain `SLACK_USER_TOKEN`. You get the user token by installing/authorizing the Slack app.

The manifest subscribes to these user events:

- `message.channels`
- `message.groups`
- `message.im`
- `message.mpim`

It requests these user token scopes:

- `channels:history`
- `channels:read`
- `groups:history`
- `groups:read`
- `im:history`
- `im:read`
- `mpim:history`
- `mpim:read`
- `usergroups:read`
- `users:read`

## Local Setup

Install dependencies:

```bash
npm install
```

Create your local environment file:

```bash
cp .env.example .env
```

Fill in `.env`:

```bash
SLACK_APP_TOKEN=xapp-your-app-level-token
SLACK_USER_TOKEN=xoxp-your-user-token
DATABASE_FILE=./slack-thread-monitor.sqlite
PORT=8787
```

These are optional:

```bash
LINEAR_API_KEY=
LINEAR_WORKSPACE_URL=
GITHUB_TOKEN=
```

Start the app:

```bash
npm run dev
```

Open:

```text
http://127.0.0.1:5173
```

The API listens on `http://127.0.0.1:8787`; Vite proxies local API calls there.

## Auto-start on macOS

Install and start the local LaunchAgent:

```bash
./scripts/install-launch-agent.sh
```

This creates `~/Library/LaunchAgents/com.jessmartin.slack-thread-monitor.plist`, starts `npm run dev`, and restarts it on login after reboot.

Useful commands:

```bash
launchctl print "gui/$(id -u)/com.jessmartin.slack-thread-monitor"
launchctl bootout "gui/$(id -u)/com.jessmartin.slack-thread-monitor"
./scripts/install-launch-agent.sh
```

Logs are written to `logs/launchd.out.log` and `logs/launchd.err.log`.

## Tracked User

The app tracks the Slack user who authorized `SLACK_USER_TOKEN`. On startup, it calls Slack `auth.test` and uses that `user_id` as the tracked user.

`/settings` shows the tracked Slack user and connected workspace as read-only values. The tracked user cannot be changed from the UI.

To track a different Slack account, authorize the Slack app as that account, replace `SLACK_USER_TOKEN`, restart the app, and run Backfill again.

## Backfill

Backfill is not polling. It is a manual scan for existing threads.

Use `/settings` to run a backfill for any number of days. The app scans conversations readable by the user token, fetches replies for candidate threads, creates missing cards when the tracked user is involved, and refreshes cards it already knows about.

Run backfill after first install, after changing the authorized Slack user token, or after clearing the database.

## Optional Integrations

Set these for Linear metadata:

```bash
LINEAR_WORKSPACE_URL=https://linear.app/your-workspace
LINEAR_API_KEY=lin_api_...
```

Set this for authenticated GitHub metadata:

```bash
GITHUB_TOKEN=github_pat_...
```

## Commands

```bash
npm run dev        # Start API, Socket Mode listener, and Vite UI
npm run build      # Typecheck and build the web app
npm run typecheck  # Run TypeScript without emitting files
npm test           # Run Vitest
```

## Notes

- `.env` is ignored and should never be committed.
- `*.sqlite`, `*.sqlite-shm`, and `*.sqlite-wal` files are ignored.
- Slack tokens should be treated like passwords.
- Private channels and DMs are limited to what the authorized Slack user can access.
- If live events do not appear after install, confirm `SLACK_APP_TOKEN`, Socket Mode, user event subscriptions, and the installed workspace.
