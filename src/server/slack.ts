import { App as SlackBoltApp, LogLevel } from "@slack/bolt"
import type { WebClient } from "@slack/web-api"
import { ManagedRuntime } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { AppConfigService, type AppConfig } from "./config"
import { type NormalizedSlackMessage } from "./domain"
import { ReferenceEnricher } from "./metadata"
import { ThreadStore } from "./store"
import { ThreadWorkflows } from "./workflows"

type AppRuntime = ManagedRuntime.ManagedRuntime<
  AppConfigService | SqliteClient.SqliteClient | SqlClient.SqlClient | ThreadStore | ReferenceEnricher | ThreadWorkflows,
  never
>

interface ShortcutInput {
  readonly teamId: string | null
  readonly channelId: string
  readonly channelName: string | null
  readonly rootThreadTs: string
  readonly actorUserId: string
  readonly fallbackText: string | null
  readonly rawJson: string
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

const eventIdFallback = (
  channelId: string,
  messageTs: string
): string => `message:${channelId}:${messageTs}`

const normalizeSlackMessage = (
  event: unknown,
  body: unknown,
  rawJson: string,
  userName: string | null,
  channelName: string | null
): NormalizedSlackMessage | null => {
  const subtype = getStringField(event, "subtype")
  if (subtype !== null && subtype !== "bot_message" && subtype !== "file_share") {
    return null
  }

  const channelId = getStringField(event, "channel")
  const messageTs = getStringField(event, "ts")
  if (channelId === null || messageTs === null) {
    return null
  }

  return {
    teamId: getStringField(body, "team_id"),
    eventId: getStringField(body, "event_id") ?? eventIdFallback(channelId, messageTs),
    eventTs: getStringField(event, "event_ts") ?? messageTs,
    channelId,
    channelName,
    messageTs,
    rootThreadTs: getStringField(event, "thread_ts") ?? messageTs,
    userId: getStringField(event, "user") ?? getStringField(event, "bot_id"),
    userName,
    text: getStringField(event, "text") ?? "",
    rawJson
  }
}

const normalizeShortcut = (shortcut: unknown, rawJson: string): ShortcutInput | null => {
  const user = getObjectField(shortcut, "user")
  const channel = getObjectField(shortcut, "channel")
  const team = getObjectField(shortcut, "team")
  const message = getObjectField(shortcut, "message")

  const actorUserId = getStringField(user, "id")
  const channelId = getStringField(channel, "id")
  const messageTs = getStringField(message, "ts")
  if (actorUserId === null || channelId === null || messageTs === null) {
    return null
  }

  return {
    teamId: getStringField(team, "id"),
    channelId,
    channelName: getStringField(channel, "name"),
    rootThreadTs: getStringField(message, "thread_ts") ?? messageTs,
    actorUserId,
    fallbackText: getStringField(message, "text"),
    rawJson
  }
}

const getSlackPermalink = async (
  client: WebClient,
  channelId: string,
  messageTs: string
): Promise<string | null> => {
  try {
    const response = await client.chat.getPermalink({
      channel: channelId,
      message_ts: messageTs
    })
    return typeof response.permalink === "string" ? response.permalink : null
  } catch {
    return null
  }
}

const getSlackUserName = async (
  client: WebClient,
  userId: string | null
): Promise<string | null> => {
  if (userId === null || userId.startsWith("B")) {
    return userId
  }

  try {
    const response = await client.users.info({ user: userId })
    const profile = response.user?.profile
    return profile?.display_name_normalized ??
      profile?.display_name ??
      profile?.real_name_normalized ??
      profile?.real_name ??
      response.user?.name ??
      userId
  } catch {
    return userId
  }
}

const getSlackChannelName = async (
  client: WebClient,
  channelId: string
): Promise<string | null> => {
  try {
    const response = await client.conversations.info({ channel: channelId })
    return response.channel?.name ?? channelId
  } catch {
    return channelId
  }
}

export const startSlack = async (
  config: AppConfig,
  runtime: AppRuntime
): Promise<SlackBoltApp | null> => {
  if (config.slackBotToken === null || config.slackAppToken === null) {
    console.log("Slack listener disabled because SLACK_BOT_TOKEN or SLACK_APP_TOKEN is missing.")
    return null
  }

  const app = new SlackBoltApp({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
    logLevel: LogLevel.INFO
  })

  app.event("message", async ({ event, body, client }) => {
    const rawJson = JSON.stringify(body)
    const provisionalUserId = getStringField(event, "user") ?? getStringField(event, "bot_id")
    const channelId = getStringField(event, "channel")

    const userName = await getSlackUserName(client, provisionalUserId)
    const channelName = channelId === null ? null : await getSlackChannelName(client, channelId)
    const normalized = normalizeSlackMessage(event, body, rawJson, userName, channelName)
    if (normalized === null) {
      return
    }

    const permalink = await getSlackPermalink(client, normalized.channelId, normalized.messageTs)
    await runtime.runPromise(
      ThreadWorkflows.use((workflows) =>
        workflows.ingestSlackMessage({
          ...normalized,
          mySlackUserId: config.mySlackUserId,
          slackPermalink: permalink,
          linearWorkspaceUrl: config.linearWorkspaceUrl
        })
      )
    )
  })

  app.shortcut({ callback_id: "resolve_thread", type: "message_action" }, async ({ shortcut, ack, respond, client }) => {
    await ack()
    const input = normalizeShortcut(shortcut, JSON.stringify(shortcut))
    if (input === null) {
      await respond("Could not identify this Slack thread.")
      return
    }
    if (input.actorUserId !== config.mySlackUserId) {
      await respond("This queue is private.")
      return
    }

    const permalink = await getSlackPermalink(client, input.channelId, input.rootThreadTs)
    await runtime.runPromise(
      ThreadWorkflows.use((workflows) =>
        workflows.setThreadStatus({
          ...input,
          status: "resolved",
          source: "slack_shortcut",
          slackPermalink: permalink
        })
      )
    )
    await respond("Marked resolved.")
  })

  app.shortcut({ callback_id: "wait_for_reply", type: "message_action" }, async ({ shortcut, ack, respond, client }) => {
    await ack()
    const input = normalizeShortcut(shortcut, JSON.stringify(shortcut))
    if (input === null) {
      await respond("Could not identify this Slack thread.")
      return
    }
    if (input.actorUserId !== config.mySlackUserId) {
      await respond("This queue is private.")
      return
    }

    const permalink = await getSlackPermalink(client, input.channelId, input.rootThreadTs)
    await runtime.runPromise(
      ThreadWorkflows.use((workflows) =>
        workflows.setThreadStatus({
          ...input,
          status: "awaiting_reply",
          source: "slack_shortcut",
          slackPermalink: permalink
        })
      )
    )
    await respond("Moved to Awaiting Reply.")
  })

  await app.start()
  console.log("Slack Socket Mode listener started.")
  return app
}
