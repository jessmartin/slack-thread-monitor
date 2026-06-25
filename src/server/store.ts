import { Context, Effect, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"
import type { CardStatus, ThreadCard, ThreadReference } from "../shared/types"
import { buildExcerpt, buildThreadKey, parseCardStatus, type ReferenceDraft, type SlackMessageProjectionInput } from "./domain"

interface CardRow {
  readonly thread_key: string
  readonly team_id: string | null
  readonly channel_id: string
  readonly channel_name: string | null
  readonly root_thread_ts: string
  readonly status: string
  readonly first_seen_at: string
  readonly last_message_at: string | null
  readonly last_message_user_id: string | null
  readonly last_message_user_name: string | null
  readonly last_message_text: string | null
  readonly slack_permalink: string | null
  readonly updated_at: string
}

interface ReferenceRow {
  readonly provider: string
  readonly reference_type: string
  readonly display_key: string
  readonly url: string
  readonly title: string | null
  readonly state: string | null
}

export interface ManualStatusInput {
  readonly teamId: string | null
  readonly channelId: string
  readonly channelName: string | null
  readonly rootThreadTs: string
  readonly actorUserId: string
  readonly status: CardStatus
  readonly source: string
  readonly fallbackText: string | null
  readonly slackPermalink: string | null
  readonly rawJson: string | null
}

export interface ReferenceMetadataInput {
  readonly provider: string
  readonly displayKey: string
  readonly url: string
  readonly title: string | null
  readonly state: string | null
}

const slackUserIdSettingKey = "slack_user_id"
const slackPublicPollSecondsSettingKey = "slack_public_poll_seconds"

const nowIso = Effect.sync(() => new Date().toISOString())

const referenceFromRow = (row: ReferenceRow): ThreadReference => ({
  provider: row.provider === "linear" ? "linear" : "github",
  referenceType: row.reference_type === "pull_request" ? "pull_request" : row.reference_type === "url" ? "url" : "issue",
  displayKey: row.display_key,
  url: cleanReferenceUrl(row.url),
  title: row.title,
  state: row.state
})

const cleanReferenceUrl = (value: string): string => {
  const withoutSlackLabel = value.split("|")[0] ?? value
  return withoutSlackLabel.replace(/[>,.)\]]+$/g, "")
}

const referenceIdentity = (reference: ThreadReference): string =>
  `${reference.provider}:${reference.displayKey}`

const shouldPreferReference = (
  next: ThreadReference,
  current: ThreadReference
): boolean => {
  if (next.referenceType === "pull_request" && current.referenceType !== "pull_request") {
    return true
  }
  if (current.title === null && next.title !== null) {
    return true
  }
  if (current.state === null && next.state !== null) {
    return true
  }
  if (current.url.includes("|") && !next.url.includes("|")) {
    return true
  }
  if (!current.url.includes("|") && next.url.includes("|")) {
    return false
  }
  return next.url.length > current.url.length
}

const dedupeThreadReferences = (
  references: ReadonlyArray<ThreadReference>
): ReadonlyArray<ThreadReference> => {
  let deduped: ReadonlyArray<ThreadReference> = []

  for (const reference of references) {
    const existing = deduped.find((candidate) => referenceIdentity(candidate) === referenceIdentity(reference))
    if (existing === undefined) {
      deduped = [...deduped, reference]
    } else if (shouldPreferReference(reference, existing)) {
      deduped = deduped.map((candidate) =>
        referenceIdentity(candidate) === referenceIdentity(reference) ? reference : candidate
      )
    }
  }

  return deduped
}

const cardFromRow = (
  row: CardRow,
  references: ReadonlyArray<ThreadReference>
): ThreadCard => ({
  threadKey: row.thread_key,
  teamId: row.team_id,
  channelId: row.channel_id,
  channelName: row.channel_name,
  rootThreadTs: row.root_thread_ts,
  status: parseCardStatus(row.status),
  firstSeenAt: row.first_seen_at,
  lastMessageAt: row.last_message_at,
  lastMessageUserId: row.last_message_user_id,
  lastMessageUserName: row.last_message_user_name,
  lastMessageText: row.last_message_text,
  lastMessageExcerpt: row.last_message_text === null ? null : buildExcerpt(row.last_message_text),
  slackPermalink: row.slack_permalink,
  references: dedupeThreadReferences(references),
  updatedAt: row.updated_at
})

export class ThreadStore extends Context.Service<ThreadStore>()(
  "ThreadStore",
  {
    make: Effect.succeed({
      migrate: Effect.fn("ThreadStore.migrate")(function*() {
        const sql = yield* SqlClient.SqlClient
        yield* sql`
          create table if not exists slack_events (
            id integer primary key autoincrement,
            team_id text,
            event_id text not null unique,
            event_ts text not null,
            received_at text not null,
            type text not null,
            channel_id text,
            message_ts text,
            thread_ts text,
            user_id text,
            raw_json text not null
          )
        `
        yield* sql`
          create table if not exists manual_actions (
            id integer primary key autoincrement,
            created_at text not null,
            source text not null,
            actor_user_id text not null,
            team_id text,
            channel_id text not null,
            root_thread_ts text not null,
            action text not null,
            raw_json text
          )
        `
        yield* sql`
          create table if not exists thread_cards (
            thread_key text primary key,
            team_id text,
            channel_id text not null,
            channel_name text,
            root_thread_ts text not null,
            status text not null,
            first_seen_at text not null,
            last_message_at text,
            last_message_user_id text,
            last_message_user_name text,
            last_message_text text,
            slack_permalink text,
            updated_at text not null
          )
        `
        yield* sql`
          create table if not exists thread_messages (
            id integer primary key autoincrement,
            thread_key text not null,
            message_ts text not null,
            user_id text,
            text text not null,
            created_at text not null,
            unique(thread_key, message_ts)
          )
        `
        yield* sql`
          create table if not exists thread_references (
            id integer primary key autoincrement,
            thread_key text not null,
            provider text not null,
            reference_type text not null,
            display_key text not null,
            url text not null,
            title text,
            state text,
            raw_json text,
            updated_at text not null,
            unique(thread_key, provider, url)
          )
        `
        yield* sql`
          create table if not exists app_settings (
            key text primary key,
            value text not null,
            updated_at text not null
          )
        `
      }),

      ensureSlackUserId: Effect.fn("ThreadStore.ensureSlackUserId")(function*(slackUserId: string) {
        const sql = yield* SqlClient.SqlClient
        const now = yield* nowIso
        yield* sql`
          insert into app_settings (
            key,
            value,
            updated_at
          ) values (
            ${slackUserIdSettingKey},
            ${slackUserId},
            ${now}
          )
          on conflict(key) do nothing
        `
      }),

      ensureSlackPublicPollSeconds: Effect.fn("ThreadStore.ensureSlackPublicPollSeconds")(function*(seconds: number) {
        const sql = yield* SqlClient.SqlClient
        const now = yield* nowIso
        yield* sql`
          insert into app_settings (
            key,
            value,
            updated_at
          ) values (
            ${slackPublicPollSecondsSettingKey},
            ${String(Math.max(0, Math.floor(seconds)))},
            ${now}
          )
          on conflict(key) do nothing
        `
      }),

      getSlackUserId: Effect.fn("ThreadStore.getSlackUserId")(function*(fallback: string) {
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql<{ readonly value: string }>`
          select value from app_settings where key = ${slackUserIdSettingKey} limit 1
        `
        return rows[0]?.value ?? fallback
      }),

      getSlackPublicPollSeconds: Effect.fn("ThreadStore.getSlackPublicPollSeconds")(function*(fallback: number) {
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql<{ readonly value: string }>`
          select value from app_settings where key = ${slackPublicPollSecondsSettingKey} limit 1
        `
        const parsed = Number.parseInt(rows[0]?.value ?? "", 10)
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
      }),

      setSlackUserId: Effect.fn("ThreadStore.setSlackUserId")(function*(slackUserId: string) {
        const sql = yield* SqlClient.SqlClient
        const now = yield* nowIso
        yield* sql`
          insert into app_settings (
            key,
            value,
            updated_at
          ) values (
            ${slackUserIdSettingKey},
            ${slackUserId},
            ${now}
          )
          on conflict(key) do update set
            value = excluded.value,
            updated_at = excluded.updated_at
        `
      }),

      setSlackPublicPollSeconds: Effect.fn("ThreadStore.setSlackPublicPollSeconds")(function*(seconds: number) {
        const sql = yield* SqlClient.SqlClient
        const now = yield* nowIso
        yield* sql`
          insert into app_settings (
            key,
            value,
            updated_at
          ) values (
            ${slackPublicPollSecondsSettingKey},
            ${String(Math.max(0, Math.floor(seconds)))},
            ${now}
          )
          on conflict(key) do update set
            value = excluded.value,
            updated_at = excluded.updated_at
        `
      }),

      clearDatabase: Effect.fn("ThreadStore.clearDatabase")(function*() {
        const sql = yield* SqlClient.SqlClient
        const settings = yield* sql<{ readonly key: string; readonly value: string }>`
          select key, value from app_settings
        `

        yield* sql`delete from thread_references`
        yield* sql`delete from thread_messages`
        yield* sql`delete from thread_cards`
        yield* sql`delete from manual_actions`
        yield* sql`delete from slack_events`
        yield* sql`delete from app_settings`

        const now = yield* nowIso
        yield* Effect.forEach(settings, (setting) =>
          sql`
            insert into app_settings (
              key,
              value,
              updated_at
            ) values (
              ${setting.key},
              ${setting.value},
              ${now}
            )
          `,
          { discard: true }
        )
      }),

      cardExists: Effect.fn("ThreadStore.cardExists")(function*(threadKey: string) {
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql<{ readonly thread_key: string }>`
          select thread_key from thread_cards where thread_key = ${threadKey} limit 1
        `
        return rows.length > 0
      }),

      recordSlackEvent: Effect.fn("ThreadStore.recordSlackEvent")(function*(message: SlackMessageProjectionInput) {
        const sql = yield* SqlClient.SqlClient
        const receivedAt = yield* nowIso
        yield* sql`
          insert into slack_events (
            team_id,
            event_id,
            event_ts,
            received_at,
            type,
            channel_id,
            message_ts,
            thread_ts,
            user_id,
            raw_json
          ) values (
            ${message.teamId},
            ${message.eventId},
            ${message.eventTs},
            ${receivedAt},
            ${"message"},
            ${message.channelId},
            ${message.messageTs},
            ${message.rootThreadTs},
            ${message.userId},
            ${message.rawJson}
          )
          on conflict(event_id) do nothing
        `
      }),

      upsertMessageProjection: Effect.fn("ThreadStore.upsertMessageProjection")(function*(
        message: SlackMessageProjectionInput,
        references: ReadonlyArray<ReferenceDraft>
      ) {
        const sql = yield* SqlClient.SqlClient
        const threadKey = buildThreadKey(message.teamId, message.channelId, message.rootThreadTs)
        const now = yield* nowIso

        yield* sql`
          insert into thread_cards (
            thread_key,
            team_id,
            channel_id,
            channel_name,
            root_thread_ts,
            status,
            first_seen_at,
            last_message_at,
            last_message_user_id,
            last_message_user_name,
            last_message_text,
            slack_permalink,
            updated_at
          ) values (
            ${threadKey},
            ${message.teamId},
            ${message.channelId},
            ${message.channelName},
            ${message.rootThreadTs},
            ${"new_message"},
            ${now},
            ${message.eventTs},
            ${message.userId},
            ${message.userName},
            ${message.text},
            ${message.slackPermalink},
            ${now}
          )
          on conflict(thread_key) do update set
            team_id = excluded.team_id,
            channel_id = excluded.channel_id,
            channel_name = coalesce(excluded.channel_name, thread_cards.channel_name),
            status = case
              when cast(excluded.last_message_at as real) > cast(coalesce(thread_cards.last_message_at, '0') as real)
              then 'new_message'
              else thread_cards.status
            end,
            last_message_at = case
              when cast(excluded.last_message_at as real) > cast(coalesce(thread_cards.last_message_at, '0') as real)
              then excluded.last_message_at
              else thread_cards.last_message_at
            end,
            last_message_user_id = case
              when cast(excluded.last_message_at as real) > cast(coalesce(thread_cards.last_message_at, '0') as real)
              then excluded.last_message_user_id
              else thread_cards.last_message_user_id
            end,
            last_message_user_name = case
              when cast(excluded.last_message_at as real) > cast(coalesce(thread_cards.last_message_at, '0') as real)
              then coalesce(excluded.last_message_user_name, thread_cards.last_message_user_name)
              when thread_cards.last_message_user_name is null
              then excluded.last_message_user_name
              else thread_cards.last_message_user_name
            end,
            last_message_text = case
              when cast(excluded.last_message_at as real) > cast(coalesce(thread_cards.last_message_at, '0') as real)
              then excluded.last_message_text
              else thread_cards.last_message_text
            end,
            slack_permalink = case
              when thread_cards.slack_permalink like 'slack://%' then coalesce(excluded.slack_permalink, thread_cards.slack_permalink)
              else coalesce(thread_cards.slack_permalink, excluded.slack_permalink)
            end,
            updated_at = case
              when cast(excluded.last_message_at as real) > cast(coalesce(thread_cards.last_message_at, '0') as real)
              then excluded.updated_at
              else thread_cards.updated_at
            end
        `

        yield* sql`
          insert into thread_messages (
            thread_key,
            message_ts,
            user_id,
            text,
            created_at
          ) values (
            ${threadKey},
            ${message.messageTs},
            ${message.userId},
            ${message.text},
            ${message.eventTs}
          )
          on conflict(thread_key, message_ts) do update set
            text = excluded.text,
            user_id = excluded.user_id
        `

        yield* Effect.forEach(references, (reference) =>
          sql`
            insert into thread_references (
              thread_key,
              provider,
              reference_type,
              display_key,
              url,
              title,
              state,
              raw_json,
              updated_at
            ) values (
              ${threadKey},
              ${reference.provider},
              ${reference.referenceType},
              ${reference.displayKey},
              ${reference.url},
              ${null},
              ${null},
              ${null},
              ${now}
            )
            on conflict(thread_key, provider, url) do update set
              display_key = excluded.display_key,
              reference_type = excluded.reference_type,
              updated_at = excluded.updated_at
          `,
          { discard: true }
        )

        return threadKey
      }),

      setStatus: Effect.fn("ThreadStore.setStatus")(function*(input: ManualStatusInput) {
        const sql = yield* SqlClient.SqlClient
        const threadKey = buildThreadKey(input.teamId, input.channelId, input.rootThreadTs)
        const now = yield* nowIso

        yield* sql`
          insert into manual_actions (
            created_at,
            source,
            actor_user_id,
            team_id,
            channel_id,
            root_thread_ts,
            action,
            raw_json
          ) values (
            ${now},
            ${input.source},
            ${input.actorUserId},
            ${input.teamId},
            ${input.channelId},
            ${input.rootThreadTs},
            ${input.status},
            ${input.rawJson}
          )
        `

        yield* sql`
          insert into thread_cards (
            thread_key,
            team_id,
            channel_id,
            channel_name,
            root_thread_ts,
            status,
            first_seen_at,
            last_message_at,
            last_message_user_id,
            last_message_user_name,
            last_message_text,
            slack_permalink,
            updated_at
          ) values (
            ${threadKey},
            ${input.teamId},
            ${input.channelId},
            ${input.channelName},
            ${input.rootThreadTs},
            ${input.status},
            ${now},
            ${now},
            ${input.actorUserId},
            ${null},
            ${input.fallbackText},
            ${input.slackPermalink},
            ${now}
          )
          on conflict(thread_key) do update set
            status = excluded.status,
            channel_name = coalesce(excluded.channel_name, thread_cards.channel_name),
            slack_permalink = case
              when thread_cards.slack_permalink like 'slack://%' then coalesce(excluded.slack_permalink, thread_cards.slack_permalink)
              else coalesce(thread_cards.slack_permalink, excluded.slack_permalink)
            end,
            updated_at = excluded.updated_at
        `

        return threadKey
      }),

      listCards: Effect.fn("ThreadStore.listCards")(function*() {
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql<CardRow>`
          select
            thread_key,
            team_id,
            channel_id,
            channel_name,
            root_thread_ts,
            status,
            first_seen_at,
            last_message_at,
            last_message_user_id,
            last_message_user_name,
            last_message_text,
            slack_permalink,
            updated_at
          from thread_cards
          order by
            case status
              when 'new_message' then 0
              when 'awaiting_reply' then 1
              else 2
            end,
            coalesce(last_message_at, updated_at) desc
        `

        return yield* Effect.forEach(
          rows,
          (row) =>
            Effect.gen(function*() {
              const references = yield* sql<ReferenceRow>`
                select
                  provider,
                  reference_type,
                  display_key,
                  url,
                  title,
                  state
                from thread_references
                where thread_key = ${row.thread_key}
                order by provider asc, display_key asc
              `
              return cardFromRow(row, references.map(referenceFromRow))
            })
        )
      }),

      listReferencesForThread: Effect.fn("ThreadStore.listReferencesForThread")(function*(threadKey: string) {
        const sql = yield* SqlClient.SqlClient
        const references = yield* sql<ReferenceRow>`
          select
            provider,
            reference_type,
            display_key,
            url,
            title,
            state
          from thread_references
          where thread_key = ${threadKey}
          order by provider asc, display_key asc
        `
        return dedupeThreadReferences(references.map(referenceFromRow))
      }),

      updateReferenceMetadata: Effect.fn("ThreadStore.updateReferenceMetadata")(function*(
        threadKey: string,
        metadata: ReferenceMetadataInput
      ) {
        const sql = yield* SqlClient.SqlClient
        const now = yield* nowIso
        yield* sql`
          update thread_references set
            url = ${metadata.url},
            title = ${metadata.title},
            state = ${metadata.state},
            updated_at = ${now}
          where
            thread_key = ${threadKey} and
            provider = ${metadata.provider} and
            display_key = ${metadata.displayKey}
        `
      })
    })
  }
) {
  static readonly layer = Layer.effect(this, this.make)
}

export type StoreError = SqlError
