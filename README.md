# Slack Thread Monitor

A local Kanban board for the Slack threads you need to process, wait on, or close out.

Slack Thread Monitor listens to Slack in Socket Mode, stores events in SQLite, and projects the threads you care about into a small React board. It is built for one person: your Slack activity, your local database, your local browser.

![Slack Thread Monitor board](docs/slack-thread-monitor.png)

## What It Does

- Watches Slack message events in channels, private channels, DMs, and group DMs that the bot can access.
- Creates a card when the configured Slack user participates in a thread, is mentioned, authored the parent message, or already has a tracked card.
- Keeps each thread in one of three states: `New Message`, `Awaiting Reply`, or `Resolved`.
- Lets you drag cards between columns or use Slack message shortcuts to mark a thread as waiting or resolved.
- Extracts Slack permalinks, Linear issue IDs, Linear URLs, GitHub issues, and GitHub pull requests.
- Optionally enriches Linear and GitHub references when API credentials are provided.
- Stores everything locally in SQLite so the data is inspectable and private to your machine.

## Architecture

- `src/server/main.ts` boots the local HTTP API, SQLite store, and Slack Socket Mode listener.
- `src/server/slack.ts` normalizes Slack message events, handles message shortcuts, and runs backfills.
- `src/server/workflows.ts` contains the tracking and status workflows.
- `src/server/store.ts` owns migrations and SQLite persistence.
- `src/client/App.tsx` renders the board and settings UI.
- `slack-app-manifest.yml` describes the Slack app features, scopes, events, shortcuts, and Socket Mode settings.

## Prerequisites

- Node.js 22+ and npm.
- A Slack workspace where you can create or request installation of a private Slack app.
- A Slack user ID for the person whose threads should be tracked.
- Optional: Linear and GitHub API tokens for richer issue metadata.

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
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-level-token
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

Open the board:

```text
http://127.0.0.1:5173
```

The API listens on `http://127.0.0.1:8787` by default. The Vite dev server proxies API calls to that port.

## Slack App Setup

The fastest path is to create a Slack app from the checked-in manifest:

1. Go to [api.slack.com/apps](https://api.slack.com/apps).
2. Choose **Create New App**.
3. Choose **From an app manifest**.
4. Pick your workspace.
5. Paste the contents of `slack-app-manifest.yml`.
6. Review the generated configuration and create the app.

Slack app manifests are designed for reusable YAML or JSON app configuration. Slack's manifest docs are here: [App manifests](https://docs.slack.dev/app-manifests/) and [Configuring apps with app manifests](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests).

### What Must Exist In Slack

Create one private Slack app with:

- **Bot user**
  - Display name: `Thread Monitor`
- **Socket Mode**
  - Enabled
  - An app-level token with the `connections:write` scope
  - Token value copied into `SLACK_APP_TOKEN`
- **OAuth bot scopes**
  - `channels:history`
  - `channels:read`
  - `groups:history`
  - `groups:read`
  - `im:history`
  - `im:read`
  - `mpim:history`
  - `mpim:read`
  - `users:read`
  - `commands`
- **Event subscriptions**
  - `message.channels`
  - `message.groups`
  - `message.im`
  - `message.mpim`
- **Interactivity**
  - Enabled
- **Message shortcuts**
  - `Resolve thread`
    - Type: message shortcut
    - Callback ID: `resolve_thread`
  - `Wait for reply`
    - Type: message shortcut
    - Callback ID: `wait_for_reply`

Slack's Socket Mode docs explain the app-level `xapp-` token flow: [Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode), [`connections:write`](https://docs.slack.dev/reference/scopes/connections.write), and [Bolt for JavaScript Socket Mode](https://docs.slack.dev/tools/bolt-js/concepts/socket-mode/). Slack's shortcut docs explain message shortcuts and callback IDs: [Listening and responding to shortcuts](https://docs.slack.dev/tools/bolt-js/concepts/shortcuts) and [Shortcuts interaction payloads](https://docs.slack.dev/reference/interaction-payloads/shortcuts-interaction-payload).

### Install The App

After creating the app:

1. Install it to the workspace from the Slack app configuration page.
2. Copy the bot token that starts with `xoxb-` into `SLACK_BOT_TOKEN`.
3. Create the app-level Socket Mode token that starts with `xapp-` and put it in `SLACK_APP_TOKEN`.
4. Invite the bot to any public or private channels you want monitored.
5. Reinstall the app whenever you change scopes, event subscriptions, shortcuts, or interactivity settings.

For private channels, the bot must be invited before it can see message history. Backfill scans channels where the bot is a member.

## Finding `MY_SLACK_USER_ID`

In Slack, open your profile, use the overflow menu, and copy your member ID. It should look like `U1234567890`.

This value is required at boot. The settings page can update the tracked user later, but the server needs an initial fallback value so it can start and migrate the database.

## Backfilling Existing Threads

The settings page includes a **Backfill** control. It scans recent Slack history for channels the bot belongs to, finds threads involving the tracked Slack user, and creates cards for matching threads.

Backfill needs `SLACK_BOT_TOKEN` because it calls Slack Web API methods such as conversation history, thread replies, permalinks, and workspace auth checks.

## Optional Integrations

### Linear

Set these when you want Linear issue links and metadata:

```bash
LINEAR_WORKSPACE_URL=https://linear.app/your-workspace
LINEAR_API_KEY=lin_api_...
```

`LINEAR_WORKSPACE_URL` is used to turn bare issue IDs such as `ABC-123` into links. `LINEAR_API_KEY` is used to fetch issue title, URL, and state.

### GitHub

Set this when you want authenticated GitHub metadata lookups:

```bash
GITHUB_TOKEN=github_pat_...
```

Without a token, the app still detects GitHub issue and pull request URLs, but authenticated requests are more reliable for private repositories and rate limits.

## Useful Commands

```bash
npm run dev        # Start API, Slack listener, and Vite UI
npm run build      # Typecheck and build the web app
npm run typecheck  # Run TypeScript without emitting files
npm test           # Run Vitest
```

## Data And Security

- `.env` is ignored and should never be committed.
- `*.sqlite`, `*.sqlite-shm`, and `*.sqlite-wal` files are ignored.
- Slack tokens should be treated like passwords.
- The app is designed for local use. It does not include multi-user auth, hosting, billing, or marketplace distribution.

## Troubleshooting

**`MY_SLACK_USER_ID is required`**

Add `MY_SLACK_USER_ID` to `.env`.

**Slack listener says tokens are missing**

Set both `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`. Without both tokens, the local board still starts, but Slack events and shortcuts are disabled.

**Events are not appearing**

Check that Socket Mode is enabled, the app-level token has `connections:write`, the bot token is installed, event subscriptions include the four `message.*` events, and the bot has been invited to the channels you expect to monitor.

**Message shortcuts do not work**

Check that Interactivity is enabled, both message shortcuts exist with the exact callback IDs, and the app was reinstalled after changing shortcut settings.

**Backfill finds nothing**

Confirm the bot is a member of the channels you expect to scan and that the tracked Slack user ID is correct on the settings page.

**Port conflict**

Change `PORT` in `.env` for the API. Vite defaults to `5173`; if that port is busy, Vite will print the alternate URL.
