# Slack Thread Monitor

A local Kanban board for Slack threads that need attention.

The app listens to Slack Events API messages over Socket Mode, stores raw Slack event payloads plus projected cards in SQLite, and renders a three-column board in your local browser.

## Behavior

- Live Slack events arrive over Socket Mode; there is no continuous history polling loop.
- Backfill is still available as an explicit action from `/settings`.
- A card is created when the tracked Slack user authors a message, is mentioned, owns the parent/root message, or already has a card for that thread.
- Any new message in a tracked thread moves the card back to `New Message`.
- Cards can be moved to `Awaiting Reply` or `Resolved`.
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

## Install For Elicit Internal

Create a Slack app in the **Elicit Internal** workspace:

1. Open [api.slack.com/apps](https://api.slack.com/apps).
2. Choose **Create New App**.
3. Choose **From an app manifest**.
4. Select the **Elicit Internal** workspace.
5. Paste `slack-app-manifest.yml`.
6. Create the app.
7. On **Basic Information**, create an app-level token with `connections:write`. Copy the `xapp-...` token into `SLACK_APP_TOKEN`.
8. On **OAuth & Permissions**, install the app to the workspace. Copy the **User OAuth Token** into `SLACK_USER_TOKEN`.
9. Reinstall the app after any manifest or scope changes.

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
MY_SLACK_USER_ID=U1234567890
DATABASE_FILE=./slack-thread-monitor.sqlite
PORT=8787
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

## Choosing The Tracked User

`MY_SLACK_USER_ID` is the fallback user ID used at boot. The Settings page can change the tracked user later.

Because there are multiple Jess Martin accounts, verify the member ID carefully in Slack:

1. Open the person profile.
2. Use the overflow menu.
3. Choose **Copy member ID**.
4. Paste that value into `/settings`.

Changing the tracked user affects future live events and future backfills. Existing cards stay in the local database until you move them or clear the DB.

## Backfill

Backfill is not polling. It is a manual scan for existing threads.

Use `/settings` to run a backfill for any number of days. The app scans conversations readable by the user token, fetches replies for candidate threads, creates missing cards when the tracked user is involved, and refreshes cards it already knows about.

Run backfill after first install, after changing the tracked user, or after clearing the database.

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
