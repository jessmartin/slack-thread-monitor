# Slack Thread Monitor Planning Doc

## Goal

Build a small personal utility that watches Slack threads I participate in and turns them into a local Kanban queue.

The tool should help answer:

- Which Slack threads have new messages I need to process?
- Which threads am I waiting on?
- Which threads have I resolved for now?
- What Linear or GitHub issues are related to the conversation?
- How do I jump directly back to the Slack thread?

This is a one-user utility. It does not need multi-tenant auth, hosted infrastructure, billing, team settings, or marketplace distribution.

## Product Shape

The primary interface is a local Kanban board with three states:

- `New Message`
- `Waiting Reply`
- `Resolved`

Each Slack thread maps to one card. Cards should be lightweight and scannable. A separate card detail screen is not required for the MVP.

Card face should show:

- Slack channel or DM display name, when available
- Latest sender display name
- Latest message excerpt, around 3 to 4 visible lines
- Direct link to the Slack thread
- Direct links to detected Linear issues
- Direct links to detected GitHub issues or pull requests
- Basic timestamps, such as latest message time and first seen time

## Recommended Stack

Use a local single-process app:

- Node.js + TypeScript
- Slack Bolt for JavaScript in Socket Mode
- SQLite
- Vite + React for the local web UI
- Hono, Express, or Fastify for the local HTTP API
- `@dnd-kit` for drag and drop
- Optional later: package as a desktop app or launch-at-login service

Rationale:

- Socket Mode avoids exposing a public webhook URL.
- SQLite keeps persistence simple and inspectable.
- React/Vite is enough for a polished local board without adding product infrastructure.
- A single local process can run the Slack listener, API server, and UI dev server during early development.

Relevant Slack docs:

- Slack Events API: https://docs.slack.dev/apis/events-api/
- Slack Socket Mode: https://docs.slack.dev/apis/events-api/using-socket-mode/
- Bolt for JavaScript Socket Mode: https://docs.slack.dev/tools/bolt-js/concepts/socket-mode/
- Slack message events: https://docs.slack.dev/reference/events/message/
- Slack `chat.getPermalink`: https://docs.slack.dev/reference/methods/chat.getPermalink/
- Slack `conversations.replies`: https://docs.slack.dev/reference/methods/conversations.replies/
- Slack rate limits: https://docs.slack.dev/apis/web-api/rate-limits/
- Slack shortcuts: https://docs.slack.dev/tools/bolt-js/concepts/shortcuts/
- Slack slash commands: https://docs.slack.dev/interactivity/implementing-slash-commands/

## Slack App Model

Create one Slack app for the workspace.

Use:

- Socket Mode for events and interactions
- Bot token for Web API calls
- App-level token for Socket Mode
- Event subscriptions for messages
- Message shortcuts for quick state changes from Slack

Suggested `.env`:

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
MY_SLACK_USER_ID=U...
LINEAR_API_KEY=optional
GITHUB_TOKEN=optional
DATABASE_URL=file:./slack-thread-monitor.sqlite
```

### Slack Admin Requirement

You may not need to be a Slack admin.

Slack says that by default, workspace members can install apps, but Workspace Owners can enable app approval. If app approval is enabled, the app must be requested and approved before install.

Practical path:

1. Try to create and install the app.
2. If Slack blocks install, submit it for approval.
3. Package the request as a private internal utility with local-only storage and clearly listed scopes.

Relevant Slack docs:

- Add apps to your workspace: https://slack.com/help/articles/202035138-Add-apps-to-your-Slack-workspace
- Manage app approval: https://slack.com/help/articles/222386767-Manage-app-approval-for-your-workspace

## Slash Command Versus Message Shortcut

The desired Slack-side action is:

> From inside Slack, mark this thread resolved, privately, without posting a visible message to the channel.

A normal custom slash command is not the right primitive because Slack docs say developer-created slash commands cannot be invoked in message threads. Built-in Slack commands and Giphy are special exceptions.

Use Slack message shortcuts instead.

Suggested shortcuts:

- `Resolve thread`
  - Callback ID: `resolve_thread`
  - Moves the card to `Resolved`
- `Wait for reply`
  - Callback ID: `wait_for_reply`
  - Moves the card to `Waiting Reply`

Behavior:

1. User clicks the message `...` menu in Slack.
2. User selects the shortcut.
3. App immediately acknowledges the interaction.
4. App checks `user_id === MY_SLACK_USER_ID`.
5. App computes the thread key from `channel_id` and `message.thread_ts ?? message.ts`.
6. App appends a manual action event.
7. App updates the card projection.
8. App sends a private ephemeral confirmation where possible.

If anyone else invokes the shortcut, the app should no-op and respond privately with something like:

```text
This queue is private.
```

## Tracking Rules

Each thread has a stable key:

```text
thread_key = `${team_id}:${channel_id}:${root_thread_ts}`
```

Where:

- `root_thread_ts` is `event.thread_ts` if present
- otherwise `event.ts` for the parent message

The app tracks a thread when:

- I authored a message in the thread
- I was mentioned in the thread
- the thread is already being tracked
- optionally, I manually add or resolve it via Slack shortcut

Do not try to infer Slack's internal "following thread" state for the MVP.

## State Machine

Card states:

- `new_message`
- `waiting_reply`
- `resolved`

State transitions:

- New relevant thread appears: `new_message`
- I drag card to Waiting Reply: `waiting_reply`
- I run "Wait for reply" shortcut: `waiting_reply`
- I drag card to Resolved: `resolved`
- I run "Resolve thread" shortcut: `resolved`
- New message from someone else in tracked thread: `new_message`
- New message from me: keep current state, but update latest message metadata

Important nuance:

Even if a card is `resolved`, a later message from someone else should move it back to `new_message`.

## Event-Log Architecture

Keep raw Slack events and manual actions, then build the visible Kanban board as a projection.

This gives several benefits:

- Reprocess old events when display logic changes
- Debug why a thread is in a state
- Add GitHub/Linear enrichment later without losing original context
- Rebuild the board projection from scratch
- Keep external API calls minimal

Suggested event tables:

```text
slack_events
manual_actions
external_reference_snapshots
projection_runs
```

Suggested projection tables:

```text
thread_cards
thread_messages
thread_participants
thread_references
users
conversations
```

The raw event log should be append-only. Projections can be updated in place.

## Suggested SQLite Schema

Initial tables:

```sql
create table slack_events (
  id integer primary key autoincrement,
  team_id text,
  event_id text unique,
  event_ts text,
  received_at text not null,
  type text not null,
  channel_id text,
  message_ts text,
  thread_ts text,
  user_id text,
  raw_json text not null
);

create table manual_actions (
  id integer primary key autoincrement,
  created_at text not null,
  source text not null,
  actor_user_id text not null,
  team_id text,
  channel_id text not null,
  root_thread_ts text not null,
  action text not null,
  raw_json text
);

create table thread_cards (
  thread_key text primary key,
  team_id text,
  channel_id text not null,
  root_thread_ts text not null,
  status text not null,
  first_seen_at text not null,
  last_message_at text,
  last_message_user_id text,
  last_message_text text,
  slack_permalink text,
  updated_at text not null
);

create table thread_references (
  id integer primary key autoincrement,
  thread_key text not null,
  provider text not null,
  reference_type text not null,
  display_key text not null,
  url text not null,
  title text,
  state text,
  raw_json text,
  updated_at text not null
);
```

This can be refined during implementation, but the important split is:

- immutable input events
- mutable board projection
- mutable external reference enrichment

## Slack Event Handling

For each Slack message event:

1. Ignore unsupported message subtypes at first.
2. Store the raw event payload.
3. Normalize `team_id`, `channel_id`, `message_ts`, `root_thread_ts`, `user_id`, and text.
4. Decide whether the thread should be tracked.
5. Extract references from the message text.
6. Upsert message/user/channel metadata when available.
7. Update the `thread_cards` projection.
8. Notify connected UI clients over local WebSocket or server-sent events.

Avoid calling `conversations.replies` on every event. Slack's current rate-limit docs make it risky to design around heavy thread-history fetching. Treat incoming events as the primary source of truth.

Use Slack Web API sparingly:

- `chat.getPermalink` once per thread or when missing
- user info lookup only when display names are missing
- conversation info lookup only when channel names are missing
- `conversations.replies` only for manual backfill, repair, or explicit sync

## Reference Extraction

Detect references first with regex, then enrich later.

### Linear

Detect:

- Full Linear issue URLs
- Bare Linear issue identifiers like `ABC-123`

Enrich with Linear GraphQL if `LINEAR_API_KEY` is configured.

Useful fields:

- issue identifier
- title
- state
- assignee
- priority
- URL

Relevant docs:

- Linear GraphQL API: https://linear.app/developers/graphql

### GitHub

Detect:

- `https://github.com/org/repo/issues/123`
- `https://github.com/org/repo/pull/123`
- `org/repo#123`

At first, direct links are enough. If `GITHUB_TOKEN` is configured, enrich later.

Useful fields:

- title
- state
- labels
- author
- merged status for PRs
- URL

Relevant docs:

- GitHub REST Issues API: https://docs.github.com/rest/issues
- GitHub GraphQL API: https://docs.github.com/en/graphql

## Local API

Minimum endpoints:

```text
GET    /api/cards
PATCH  /api/cards/:threadKey/status
GET    /api/settings
POST   /api/reprocess
GET    /api/events/recent
```

Optional:

```text
POST   /api/sync/thread
POST   /api/enrich/references
GET    /api/health
```

The UI should not talk to Slack directly. Slack credentials stay server-side.

## UI Notes

The board should be dense and utility-focused.

MVP UI:

- Three columns
- Card count per column
- Drag cards between columns
- New-message cards show latest excerpt prominently
- Cards expose direct links to Slack, Linear, and GitHub
- Search/filter by channel, participant, reference, or text
- Manual refresh or reprocess button

Avoid:

- Marketing-style landing page
- Large hero sections
- Nested cards
- Overly decorative visuals
- Requiring users to open card detail views for basic actions

## Security And Privacy

This app stores Slack message data locally.

Design assumptions:

- Single local user
- SQLite database stays on local disk
- No hosted backend
- No telemetry
- No external writes except Slack interaction responses and optional GitHub/Linear fetches

Admin-facing explanation:

- The app is an internal, local-only personal queue.
- It stores Slack events on the user's machine.
- It does not post public messages.
- It uses Slack shortcuts only for private state changes.
- GitHub and Linear tokens are optional and only used to fetch linked issue metadata.

## MVP Milestones

### Milestone 1: Local Board Skeleton

- Set up Node + TypeScript project
- Add SQLite schema and migrations
- Add local API
- Add React Kanban board
- Support manual cards and drag/drop status changes

### Milestone 2: Slack Event Intake

- Create Slack app
- Enable Socket Mode
- Subscribe to message events
- Store raw Slack events
- Normalize thread keys
- Create/update cards from events
- Generate Slack permalinks

### Milestone 3: State Automation

- Implement participant detection
- Move tracked cards to `New Message` on new messages from others
- Preserve state on my own replies
- Add manual reprocess from event log

### Milestone 4: Slack Shortcuts

- Add `Resolve thread` message shortcut
- Add `Wait for reply` message shortcut
- Restrict shortcut effects to `MY_SLACK_USER_ID`
- Add private confirmation responses

### Milestone 5: Reference Extraction

- Extract Linear URLs and issue IDs
- Extract GitHub issue and PR URLs
- Extract GitHub shorthand references
- Show links on card faces

### Milestone 6: Reference Enrichment

- Add optional Linear API fetch
- Add optional GitHub API fetch
- Store snapshots separately from raw Slack events
- Display title/state metadata when available

## Open Questions

- Which Slack surfaces should be monitored: public channels only, private channels, DMs, group DMs?
- Is a bot-only install sufficient, or is user-token access needed for the channels/DMs I care about?
- Should the app auto-track threads where I am merely mentioned, or only where I reply?
- Should muted/archived channels be excluded?
- Should messages from bots move cards back to `New Message`?
- How long should raw Slack events be retained?
- Should resolved cards hide by default, or remain visible in the third column?

## Default Decisions

Unless later testing proves otherwise:

- Use Socket Mode.
- Use message shortcuts, not slash commands, for Slack-side state changes.
- Keep all raw Slack events.
- Use event replay to build the board projection.
- Avoid heavy Slack history fetching.
- Keep the app local-only.
- Build for one user first.
