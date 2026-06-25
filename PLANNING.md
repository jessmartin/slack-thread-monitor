# Slack Thread Monitor Planning Doc

## Goal

Build a small personal utility that watches Slack threads I participate in and turns them into a local Kanban queue.

The tool should help answer:

- Which Slack threads have new messages I need to process?
- Which threads am I waiting on?
- Which threads have I resolved for now?
- What Linear or GitHub issues are related to the conversation?
- How do I jump directly back to the Slack thread?

This is a one-user utility. It does not need multi-tenant auth, hosted infrastructure, billing, team settings, marketplace distribution, Socket Mode, a Slack bot user, or Slack-side commands.

## Current Architecture

Use a local polling app:

- Node.js + TypeScript
- Hono HTTP API
- SQLite persistence
- Vite + React local UI
- Slack Web API reads authenticated with a user OAuth token

The app polls Slack as the configured user. This is intentionally different from a bot-token design:

- A bot token can only read public channels where the bot is a member.
- A user token with the relevant `*:history` scopes can read all public conversations and private conversations the user belongs to.
- This avoids adding a visible app/bot member to every public channel.

## Slack Token Model

Use one user OAuth token in `.env`:

```bash
SLACK_USER_TOKEN=xoxp-...
MY_SLACK_USER_ID=U...
DATABASE_FILE=./slack-thread-monitor.sqlite
```

Required user scopes:

- `channels:history`
- `channels:read`
- `groups:history`
- `groups:read`
- `im:history`
- `im:read`
- `mpim:history`
- `mpim:read`
- `users:read`

The checked-in `slack-app-manifest.yml` is only a minimal helper for issuing this user token. The running app does not need Socket Mode, event subscriptions, interactivity, shortcuts, or bot token behavior.

## Verified Access Behavior

Bot-token test against `#new-channel-3` (`C0BDY83Q3BJ`):

- `conversations.info`: succeeds and reports `is_member=false`
- `conversations.history`: fails with `not_in_channel`
- `conversations.replies`: fails with `not_in_channel`

User-token test against the same channel and missed thread:

- `conversations.info`: succeeds and reports `is_member=false`
- `conversations.history`: succeeds for root `1782383252.286689`
- `conversations.replies`: succeeds and returns the missed reply `1782384080.252949`

Slack docs supporting the model:

- `conversations.history`: user tokens can access all public conversations and private conversations the user is a member of.
- `conversations.list`: user tokens support the same read scopes used by this app.

## Product Shape

The primary interface is a local Kanban board with three states:

- `New Message`
- `Awaiting Reply`
- `Resolved`

Each Slack thread maps to one card. Cards should be lightweight and scannable. A separate card detail screen is not required.

Card face should show:

- Slack channel or DM display name, when available
- Latest sender display name
- Latest message excerpt, around 3 to 4 visible lines
- Direct native Slack link to the thread
- Direct links to detected Linear issues
- Direct links to detected GitHub issues or pull requests
- Basic timestamps, such as latest message time and first seen time

## Data Model

Persist:

- Raw Slack message payloads for replay/reprojection
- Thread cards
- Thread messages
- Manual board status changes
- Extracted references
- Local settings such as tracked Slack user ID and polling interval

The event log matters because display logic can change over time. The app should be able to reprocess retained Slack events to update cards in place.

## Polling Strategy

On startup and on each poll:

1. List accessible public and private conversations.
2. Scan recent history for candidate root messages.
3. Fetch replies for candidate threads.
4. Track a thread if the configured user authored the root, replied, was the parent user, was mentioned, or already has a card.
5. Store raw events and update the projected card.

The settings page controls:

- Tracked Slack user ID
- Public polling interval in seconds
- Backfill days
- Clear local database

`Refresh Slack` triggers the same poll immediately.

## Reference Extraction

Detect and link:

- Linear bare IDs such as `ABC-123`
- Linear URLs
- GitHub issue and pull request URLs
- GitHub shorthand such as `owner/repo#123`

References should be deduplicated per thread by provider and display key.

Optional enrichment:

- Linear API token fetches title/state/URL.
- GitHub token fetches issue or pull request title/state.

## Open Follow-Ups

- Add incremental cursors so polling does not rescan the full recent window every time.
- Add a reprocess button that rebuilds cards from retained Slack events.
- Consider a local launch-at-login wrapper after the behavior settles.
