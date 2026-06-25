# Slack Thread Monitor

A local Kanban board for the Slack threads you need to process, wait on, or close out.

Slack Thread Monitor polls Slack as your Slack user, stores raw events and projected cards in SQLite, and renders a small React board in your local browser. It is built for one person: your Slack activity, your local database, your local machine.

## What It Does

- Polls recent Slack history with a user OAuth token.
- Reads public channels as the authorized user, including public channels the app is not a member of.
- Reads private channels, DMs, and group DMs that the authorized user can access.
- Creates a card when the configured Slack user participates in a thread, is mentioned, authored the parent message, or already has a tracked card.
- Keeps each thread in one of three states: `New Message`, `Awaiting Reply`, or `Resolved`.
- Lets you drag cards between columns.
- Extracts Slack links, Linear issue IDs, Linear URLs, GitHub issues, and GitHub pull requests.
- Optionally enriches Linear and GitHub references when API credentials are provided.
- Stores everything locally in SQLite so the data is inspectable and private to your machine.

## Architecture

- `src/server/main.ts` boots the local HTTP API, SQLite store, and Slack polling loop.
- `src/server/slack.ts` scans Slack history and normalizes messages.
- `src/server/workflows.ts` contains the tracking and status workflows.
- `src/server/store.ts` owns migrations and SQLite persistence.
- `src/client/App.tsx` renders the board and settings UI.
- `slack-app-manifest.yml` describes the minimal OAuth app used to issue a user token.

## Prerequisites

- Node.js 22+ and npm.
- A Slack workspace where you can create or request installation of a private OAuth app.
- A Slack user ID for the person whose threads should be tracked.
- A Slack user token with the read scopes listed below.
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

Open the board:

```text
http://127.0.0.1:5173
```

The API listens on `http://127.0.0.1:8787` by default. The Vite dev server proxies API calls to that port.

## Slack Token Setup

The runtime does not need Socket Mode, event subscriptions, a bot user, slash commands, or message shortcuts. It only needs a user OAuth token.

The checked-in `slack-app-manifest.yml` configures a minimal private Slack app with these **User Token Scopes**:

- `channels:history`
- `channels:read`
- `groups:history`
- `groups:read`
- `im:history`
- `im:read`
- `mpim:history`
- `mpim:read`
- `users:read`

To create the token:

1. Go to [api.slack.com/apps](https://api.slack.com/apps).
2. Choose **Create New App**.
3. Choose **From an app manifest**.
4. Pick your workspace.
5. Paste the contents of `slack-app-manifest.yml`.
6. Create and install the app.
7. On **OAuth & Permissions**, copy the **User OAuth Token** that starts with `xoxp-`.
8. Put that value in `SLACK_USER_TOKEN`.

Reinstall the app whenever you change user scopes.

## Finding `MY_SLACK_USER_ID`

In Slack, open your profile, use the overflow menu, and copy your member ID. It should look like `U1234567890`.

This value is required at boot. The settings page can update the tracked user later, but the server needs an initial fallback value so it can start and migrate the database.

## Backfilling Existing Threads

The settings page includes a **Backfill** control. It scans recent Slack history, finds threads involving the tracked Slack user, and creates cards for matching threads.

With `SLACK_USER_TOKEN`, public channels do not require the app to be a channel member. Private channels, DMs, and group DMs are limited to what the authorized user can access.

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
npm run dev        # Start API, polling loop, and Vite UI
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

**Slack sync fails because a token is missing**

Set `SLACK_USER_TOKEN` in `.env`.

**Backfill finds nothing**

Confirm `SLACK_USER_TOKEN` belongs to the expected workspace and that the tracked Slack user ID is correct on the settings page.

**Port conflict**

Change `PORT` in `.env` for the API. Vite defaults to `5173`; if that port is busy, Vite will print the alternate URL.
