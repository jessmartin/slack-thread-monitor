import { ManagedRuntime } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type { BackfillResponse } from "../shared/types"
import { AppConfigService, type AppConfig } from "./config"
import { buildThreadKey, type NormalizedSlackMessage } from "./domain"
import { ReferenceEnricher } from "./metadata"
import { ThreadStore } from "./store"
import { ThreadWorkflows } from "./workflows"
import { readableSlackActorLabel } from "../shared/slack"

type AppRuntime = ManagedRuntime.ManagedRuntime<
  AppConfigService | SqliteClient.SqliteClient | SqlClient.SqlClient | ThreadStore | ReferenceEnricher | ThreadWorkflows,
  never
>

interface ScanSlackThreadsOptions {
  readonly includeExisting: boolean
}

const getObjectField = (value: unknown, key: string): unknown => {
  if (typeof value !== "object" || value === null) {
    return undefined
  }
  return Reflect.get(value, key)
}

const getStringField = (value: unknown, key: string): string | null => {
  const field = getObjectField(value, key)
  return typeof field === "string" ? field : null
}

const getNumberField = (value: unknown, key: string): number | null => {
  const field = getObjectField(value, key)
  return typeof field === "number" ? field : null
}

const getBooleanField = (value: unknown, key: string): boolean =>
  getObjectField(value, key) === true

const getArrayField = (value: unknown, key: string): ReadonlyArray<unknown> => {
  const field = getObjectField(value, key)
  return Array.isArray(field) ? field : []
}

const slackReadToken = (config: AppConfig): string | null =>
  config.slackUserToken

const stringifySlackPayload = (value: unknown): string =>
  JSON.stringify(value, (key: string, field: unknown) =>
    key === "token" && typeof field === "string" ? "[redacted]" : field
  )

const getSlackEventActorName = (event: unknown): string | null => {
  const botProfile = getObjectField(event, "bot_profile")
  return readableSlackActorLabel(getStringField(botProfile, "name")) ??
    readableSlackActorLabel(getStringField(event, "username"))
}

const getSlackUserProfileName = (user: unknown): string | null => {
  const profile = getObjectField(user, "profile")
  return readableSlackActorLabel(getStringField(profile, "display_name_normalized")) ??
    readableSlackActorLabel(getStringField(profile, "display_name")) ??
    readableSlackActorLabel(getStringField(profile, "real_name_normalized")) ??
    readableSlackActorLabel(getStringField(profile, "real_name")) ??
    readableSlackActorLabel(getStringField(user, "name"))
}

const slackApiGet = async (
  config: AppConfig,
  method: string,
  params: Readonly<Record<string, string>>
): Promise<unknown> => {
  const token = slackReadToken(config)
  if (token === null) {
    throw new Error("SLACK_USER_TOKEN is required for Slack API calls.")
  }

  const url = new URL(`https://slack.com/api/${method}`)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }

  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`
    }
  })
  const body: unknown = await response.json()
  if (!getBooleanField(body, "ok")) {
    throw new Error(`${method} failed: ${getStringField(body, "error") ?? "unknown_error"}`)
  }
  return body
}

const slackPagedItems = async (
  config: AppConfig,
  method: string,
  collectionKey: string,
  params: Readonly<Record<string, string>>
): Promise<ReadonlyArray<unknown>> => {
  let cursor: string | null = null
  let items: ReadonlyArray<unknown> = []

  do {
    const body = await slackApiGet(config, method, {
      ...params,
      limit: "200",
      ...(cursor === null ? {} : { cursor })
    })
    items = [...items, ...getArrayField(body, collectionKey)]
    const metadata = getObjectField(body, "response_metadata")
    const nextCursor = getStringField(metadata, "next_cursor")
    cursor = nextCursor === null || nextCursor === "" ? null : nextCursor
  } while (cursor !== null)

  return items
}

const getSlackTeamId = async (config: AppConfig): Promise<string | null> => {
  try {
    const body = await slackApiGet(config, "auth.test", {})
    return getStringField(body, "team_id")
  } catch {
    return null
  }
}

const slackPermalinkFromApi = async (
  config: AppConfig,
  channelId: string,
  messageTs: string
): Promise<string | null> => {
  try {
    const body = await slackApiGet(config, "chat.getPermalink", {
      channel: channelId,
      message_ts: messageTs
    })
    return getStringField(body, "permalink")
  } catch {
    return null
  }
}

const getSlackUserNameFromApi = async (
  config: AppConfig,
  userId: string | null
): Promise<string | null> => {
  if (userId === null) {
    return null
  }

  try {
    if (userId.startsWith("B")) {
      const body = await slackApiGet(config, "bots.info", { bot: userId })
      const bot = getObjectField(body, "bot")
      return readableSlackActorLabel(getStringField(bot, "name"))
    }

    const body = await slackApiGet(config, "users.info", { user: userId })
    return getSlackUserProfileName(getObjectField(body, "user")) ?? readableSlackActorLabel(userId)
  } catch {
    return null
  }
}

const makeSlackActorNameResolver = (
  config: AppConfig
): ((message: unknown, userId: string | null) => Promise<string | null>) => {
  const cache = new Map<string, Promise<string | null>>()

  return async (message: unknown, userId: string | null): Promise<string | null> => {
    const eventName = getSlackEventActorName(message)
    if (eventName !== null) {
      return eventName
    }
    if (userId === null) {
      return null
    }

    const cached = cache.get(userId)
    if (cached !== undefined) {
      return await cached
    }

    const loaded = getSlackUserNameFromApi(config, userId)
    cache.set(userId, loaded)
    return await loaded
  }
}

const slackMessageFromHistory = (
  message: unknown,
  teamId: string | null,
  channelId: string,
  channelName: string | null,
  rootThreadTs: string,
  slackPermalink: string | null,
  userName: string | null,
  fallbackMySlackUserId: string
): NormalizedSlackMessage & {
  readonly mySlackUserId: string
  readonly slackPermalink: string | null
  readonly linearWorkspaceUrl: string | null
} | null => {
  const messageTs = getStringField(message, "ts")
  if (messageTs === null) {
    return null
  }

  const userId = getStringField(message, "user") ?? getStringField(message, "bot_id")
  const eventId = `backfill:${channelId}:${messageTs}`

  return {
    teamId,
    eventId,
    eventTs: messageTs,
    channelId,
    channelName,
    messageTs,
    rootThreadTs,
    userId,
    parentUserId: getStringField(message, "parent_user_id"),
    userName,
    text: getStringField(message, "text") ?? "",
    rawJson: stringifySlackPayload({
      team_id: teamId,
      event_id: eventId,
      event: message
    }),
    mySlackUserId: fallbackMySlackUserId,
    slackPermalink,
    linearWorkspaceUrl: null
  }
}

export const backfillSlackThreads = async (
  config: AppConfig,
  runtime: AppRuntime,
  days: number,
  options: ScanSlackThreadsOptions = { includeExisting: false }
): Promise<BackfillResponse> => {
  if (slackReadToken(config) === null) {
    throw new Error("SLACK_USER_TOKEN is required for backfill.")
  }
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error("Backfill days must be a positive number.")
  }

  const trackedSlackUserId = await runtime.runPromise(
    ThreadWorkflows.use((workflows) => workflows.getTrackedSlackUserId())
  )
  const teamId = await getSlackTeamId(config)
  const resolveActorName = makeSlackActorNameResolver(config)
  const oldest = `${Math.floor(Date.now() / 1000) - Math.floor(days * 24 * 60 * 60)}`
  const conversations = await slackPagedItems(config, "conversations.list", "channels", {
    types: "public_channel,private_channel",
    exclude_archived: "true"
  })
  const readableChannels = conversations.filter((channel) => {
    const isPrivate = getBooleanField(channel, "is_private")
    const isMember = getBooleanField(channel, "is_member")
    return isPrivate ? isMember : true
  })

  let channelsScanned = 0
  let threadsScanned = 0
  let threadsCreated = 0
  let messagesIngested = 0

  for (const channel of readableChannels) {
    const channelId = getStringField(channel, "id")
    if (channelId === null) {
      continue
    }
    channelsScanned += 1
    const channelName = getStringField(channel, "name")
    let history: ReadonlyArray<unknown>
    try {
      history = await slackPagedItems(config, "conversations.history", "messages", {
        channel: channelId,
        oldest
      })
    } catch {
      continue
    }

    for (const rootMessage of history) {
      const rootTs = getStringField(rootMessage, "ts")
      if (rootTs === null || (getNumberField(rootMessage, "reply_count") ?? 0) <= 0) {
        continue
      }

      threadsScanned += 1
      const threadKey = buildThreadKey(teamId, channelId, rootTs)
      const exists = await runtime.runPromise(
        ThreadStore.use((store) => store.cardExists(threadKey))
      )
      if (exists && !options.includeExisting) {
        continue
      }

      let replies: ReadonlyArray<unknown>
      try {
        replies = await slackPagedItems(config, "conversations.replies", "messages", {
          channel: channelId,
          ts: rootTs
        })
      } catch {
        continue
      }
      const involved = replies.some((reply) =>
        getStringField(reply, "user") === trackedSlackUserId ||
        getStringField(reply, "parent_user_id") === trackedSlackUserId ||
        getStringField(rootMessage, "user") === trackedSlackUserId
      )
      if (!involved) {
        continue
      }

      const rootPermalink = await slackPermalinkFromApi(config, channelId, rootTs)
      let createdThisThread = false
      for (const reply of replies.toSorted((left, right) =>
        (getStringField(left, "ts") ?? "").localeCompare(getStringField(right, "ts") ?? "")
      )) {
        const userId = getStringField(reply, "user") ?? getStringField(reply, "bot_id")
        const normalized = slackMessageFromHistory(
          reply,
          teamId,
          channelId,
          channelName,
          rootTs,
          rootPermalink,
          await resolveActorName(reply, userId),
          trackedSlackUserId
        )
        if (normalized === null) {
          continue
        }
        const result = await runtime.runPromise(
          ThreadWorkflows.use((workflows) => workflows.ingestSlackMessage({
            ...normalized,
            linearWorkspaceUrl: config.linearWorkspaceUrl
          }))
        )
        messagesIngested += 1
        if (result !== null) {
          createdThisThread = true
        }
      }
      if (createdThisThread) {
        threadsCreated += 1
      }
    }
  }

  return {
    ok: true,
    channelsScanned,
    threadsScanned,
    threadsCreated,
    messagesIngested
  }
}

export const startSlackPublicChannelPoller = (
  config: AppConfig,
  runtime: AppRuntime
): (() => void) => {
  if (slackReadToken(config) === null) {
    return () => undefined
  }

  let running = false
  let lastStartedAt = 0
  const poll = async () => {
    if (running) {
      return
    }
    const pollSeconds = await runtime.runPromise(
      ThreadWorkflows.use((workflows) => workflows.getSlackPublicPollSeconds())
    )
    if (pollSeconds <= 0) {
      return
    }

    const now = Date.now()
    if (now - lastStartedAt < pollSeconds * 1000) {
      return
    }

    running = true
    lastStartedAt = now
    try {
      await backfillSlackThreads(config, runtime, config.slackPublicPollDays, { includeExisting: true })
    } catch (cause) {
      console.warn(cause instanceof Error ? cause.message : "Slack public channel poll failed.")
    } finally {
      running = false
    }
  }

  void poll()
  const intervalId = setInterval(() => {
    void poll()
  }, 1000)

  return () => clearInterval(intervalId)
}
