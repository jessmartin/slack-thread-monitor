import { SqliteClient } from "@effect/sql-sqlite-node"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type { BackfillResponse, SlackWorkspace, TrackedSlackUser } from "../shared/types"
import { buildSlackNativeMessageUrl, readableSlackActorLabel } from "../shared/slack"
import { AppConfigService, type AppConfig } from "./config"
import { buildThreadKey, type SlackMessageProjectionInput } from "./domain"
import { ConfigError, ExternalApiError } from "./errors"
import { ReferenceEnricher } from "./metadata"
import { ThreadStore } from "./store"
import { ThreadWorkflows } from "./workflows"

type SlackTokenKind = "app" | "user"

interface SlackAuthIdentity {
  readonly workspace: SlackWorkspace
  readonly userId: string | null
}

interface SlackActorProfile {
  readonly name: string | null
  readonly imageUrl: string | null
}

interface SocketMessageEventSource {
  readonly message: unknown
  readonly isMessageChanged: boolean
  readonly fallbackChannelId: string | null
  readonly fallbackTeamId: string | null
}

interface SocketMessageProjectionResult {
  readonly message: SlackMessageProjectionInput
  readonly shouldFetchThread: boolean
}

const ignoredMessageSubtypes = new Set([
  "channel_archive",
  "channel_join",
  "channel_leave",
  "channel_name",
  "channel_purpose",
  "channel_topic",
  "channel_unarchive",
  "group_archive",
  "group_join",
  "group_leave",
  "group_name",
  "group_purpose",
  "group_topic",
  "group_unarchive",
  "message_deleted",
  "message_replied"
])

const causeMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

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

const stringifySlackPayload = (value: unknown): string =>
  JSON.stringify(value, (key: string, field: unknown) =>
    key === "token" && typeof field === "string" ? "[redacted]" : field
  ) ?? "{}"

const fetchSlackJson = (
  method: string,
  token: string,
  params: Readonly<Record<string, string>>
) =>
  Effect.tryPromise({
    try: async () => {
      const body = new URLSearchParams()
      for (const [key, value] of Object.entries(params)) {
        body.set(key, value)
      }

      const response = await fetch(`https://slack.com/api/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body
      })

      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`)
      }

      return await response.json()
    },
    catch: (cause) =>
      ExternalApiError.make({
        provider: "slack",
        message: `Failed to call Slack ${method}`,
        cause: causeMessage(cause)
      })
  })

const getSlackEventActorName = (event: unknown): string | null => {
  const botProfile = getObjectField(event, "bot_profile")
  return readableSlackActorLabel(getStringField(botProfile, "name")) ??
    readableSlackActorLabel(getStringField(event, "username"))
}

const getSlackEventActorImageUrl = (event: unknown): string | null => {
  const botProfile = getObjectField(event, "bot_profile")
  const icons = getObjectField(botProfile, "icons")
  return getStringField(icons, "image_72") ??
    getStringField(icons, "image_48") ??
    getStringField(botProfile, "image_72") ??
    getStringField(botProfile, "image_48")
}

const getSlackEventActorProfile = (event: unknown): SlackActorProfile => ({
  name: getSlackEventActorName(event),
  imageUrl: getSlackEventActorImageUrl(event)
})

const getSlackUserProfileName = (user: unknown): string | null => {
  const profile = getObjectField(user, "profile")
  return readableSlackActorLabel(getStringField(profile, "display_name_normalized")) ??
    readableSlackActorLabel(getStringField(profile, "display_name")) ??
    readableSlackActorLabel(getStringField(profile, "real_name_normalized")) ??
    readableSlackActorLabel(getStringField(profile, "real_name")) ??
    readableSlackActorLabel(getStringField(user, "name"))
}

const trackedUserFromSlackUser = (slackUserId: string, user: unknown): TrackedSlackUser => {
  const profile = getObjectField(user, "profile")
  return {
    id: slackUserId,
    name: getSlackUserProfileName(user),
    imageUrl: getStringField(profile, "image_72") ?? getStringField(profile, "image_48")
  }
}

const actorProfileFromSlackUser = (user: unknown): SlackActorProfile => {
  const profile = getObjectField(user, "profile")
  return {
    name: getSlackUserProfileName(user),
    imageUrl: getStringField(profile, "image_72") ?? getStringField(profile, "image_48")
  }
}

const actorProfileFromSlackBot = (bot: unknown): SlackActorProfile => {
  const icons = getObjectField(bot, "icons")
  return {
    name: readableSlackActorLabel(getStringField(bot, "name")),
    imageUrl: getStringField(icons, "image_72") ?? getStringField(icons, "image_48")
  }
}

const unknownWorkspace = (): SlackWorkspace => ({
  id: null,
  name: null,
  url: null
})

const slackApiCall = Effect.fn("SlackApiClient.apiCall")(function*(
  method: string,
  params: Readonly<Record<string, string>>,
  tokenKind: SlackTokenKind
) {
  const config = yield* AppConfigService
  const token = tokenKind === "app" ? config.slackAppToken : config.slackUserToken
  if (token === null) {
    return yield* Effect.fail(
      ConfigError.make({
        message: tokenKind === "app"
          ? "SLACK_APP_TOKEN is required for Slack Socket Mode."
          : "SLACK_USER_TOKEN is required for Slack Web API calls."
      })
    )
  }

  const body = yield* fetchSlackJson(method, token, params)
  if (!getBooleanField(body, "ok")) {
    return yield* Effect.fail(
      ExternalApiError.make({
        provider: "slack",
        message: `${method} failed`,
        cause: getStringField(body, "error") ?? "unknown_error"
      })
    )
  }

  return body
})

const slackPagedItems = Effect.fn("SlackApiClient.pagedItems")(function*(
  method: string,
  collectionKey: string,
  params: Readonly<Record<string, string>>
) {
  let cursor: string | null = null
  let items: ReadonlyArray<unknown> = []

  do {
    const body = yield* slackApiCall(
      method,
      {
        ...params,
        limit: "200",
        ...(cursor === null ? {} : { cursor })
      },
      "user"
    )
    items = [...items, ...getArrayField(body, collectionKey)]
    const metadata = getObjectField(body, "response_metadata")
    const nextCursor = getStringField(metadata, "next_cursor")
    cursor = nextCursor === null || nextCursor === "" ? null : nextCursor
  } while (cursor !== null)

  return items
})

const slackAuthTest = Effect.fn("SlackApiClient.authTest")(function*() {
  const body = yield* slackApiCall("auth.test", {}, "user")
  return {
    id: getStringField(body, "team_id"),
    name: getStringField(body, "team"),
    url: getStringField(body, "url")
  }
})

const slackAuthIdentity = Effect.fn("SlackApiClient.authIdentity")(function*() {
  const body = yield* slackApiCall("auth.test", {}, "user")
  const identity: SlackAuthIdentity = {
    workspace: {
      id: getStringField(body, "team_id"),
      name: getStringField(body, "team"),
      url: getStringField(body, "url")
    },
    userId: getStringField(body, "user_id")
  }
  return identity
})

const slackActorName = Effect.fn("SlackApiClient.getActorName")(function*(actorId: string | null) {
  if (actorId === null) {
    return null
  }

  if (actorId.startsWith("B")) {
    const body = yield* slackApiCall("bots.info", { bot: actorId }, "user")
    const bot = getObjectField(body, "bot")
    return readableSlackActorLabel(getStringField(bot, "name"))
  }

  const body = yield* slackApiCall("users.info", { user: actorId }, "user")
  return getSlackUserProfileName(getObjectField(body, "user")) ?? readableSlackActorLabel(actorId)
})

const slackActorProfile = Effect.fn("SlackApiClient.getActorProfile")(function*(actorId: string | null) {
  if (actorId === null) {
    return {
      name: null,
      imageUrl: null
    }
  }

  if (actorId.startsWith("B")) {
    const body = yield* slackApiCall("bots.info", { bot: actorId }, "user")
    return actorProfileFromSlackBot(getObjectField(body, "bot"))
  }

  const body = yield* slackApiCall("users.info", { user: actorId }, "user")
  return actorProfileFromSlackUser(getObjectField(body, "user"))
})

const slackActorProfileFromName = (name: string | null): SlackActorProfile => ({
  name,
  imageUrl: null
})

const slackChannelName = Effect.fn("SlackApiClient.getChannelName")(function*(channelId: string) {
  const body = yield* slackApiCall("conversations.info", { channel: channelId }, "user")
  const channel = getObjectField(body, "channel")
  return getStringField(channel, "name")
})

const slackUser = Effect.fn("SlackApiClient.getUser")(function*(slackUserId: string) {
  const body = yield* slackApiCall("users.info", { user: slackUserId }, "user")
  return trackedUserFromSlackUser(slackUserId, getObjectField(body, "user"))
})

const slackUserMentionLabels = Effect.fn("SlackApiClient.getUserMentionLabels")(function*(
  userIds: ReadonlyArray<string>
) {
  const labels: Record<string, string | null> = {}

  yield* Effect.forEach(
    userIds,
    (userId) =>
      Effect.gen(function*() {
        const user = yield* slackUser(userId).pipe(Effect.catchCause(() => Effect.succeed(null)))
        labels[userId] = user?.name ?? null
      }),
    { discard: true }
  )

  return labels
})

const slackSubteamMentionLabels = Effect.fn("SlackApiClient.getSubteamMentionLabels")(function*(
  subteamIds: ReadonlyArray<string>
) {
  const labels: Record<string, string | null> = {}
  for (const subteamId of subteamIds) {
    labels[subteamId] = null
  }

  if (subteamIds.length === 0) {
    return labels
  }

  const body = yield* slackApiCall(
    "usergroups.list",
    {
      include_users: "false",
      include_disabled: "true",
      include_count: "false"
    },
    "user"
  ).pipe(Effect.catchCause(() => Effect.succeed(null)))

  if (body === null) {
    return labels
  }

  for (const usergroup of getArrayField(body, "usergroups")) {
    const id = getStringField(usergroup, "id")
    if (id === null || labels[id] === undefined) {
      continue
    }
    labels[id] = getStringField(usergroup, "handle") ?? getStringField(usergroup, "name")
  }

  return labels
})

const slackSocketUrl = Effect.fn("SlackApiClient.openSocketUrl")(function*() {
  const body = yield* slackApiCall("apps.connections.open", {}, "app")
  const url = getStringField(body, "url")
  if (url === null) {
    return yield* Effect.fail(
      ExternalApiError.make({
        provider: "slack",
        message: "apps.connections.open did not return a websocket URL",
        cause: "missing_url"
      })
    )
  }
  return url
})

export class SlackApiClient extends Context.Service<SlackApiClient>()(
  "SlackApiClient",
  {
    make: Effect.succeed({
      apiCall: slackApiCall,
      authIdentity: slackAuthIdentity,
      authTest: slackAuthTest,
      getActorName: slackActorName,
      getActorProfile: slackActorProfile,
      getChannelName: slackChannelName,
      getSubteamMentionLabels: slackSubteamMentionLabels,
      getUser: slackUser,
      getUserMentionLabels: slackUserMentionLabels,
      openSocketUrl: slackSocketUrl,
      pagedItems: slackPagedItems
    })
  }
) {
  static readonly layer = Layer.effect(this, this.make)
}

type AppRuntime = ManagedRuntime.ManagedRuntime<
  AppConfigService | SqliteClient.SqliteClient | SqlClient.SqlClient | ThreadStore | ReferenceEnricher | ThreadWorkflows | SlackApiClient,
  never
>

const rawSlackThreadMatchesTrackingRule = (
  messages: ReadonlyArray<unknown>,
  trackedSlackUserId: string,
  rootThreadTs: string
): boolean => {
  const hasThreadedReply = messages.some((message) => {
    const messageTs = getStringField(message, "ts")
    return messageTs !== null && messageTs !== rootThreadTs
  })
  const hasTrackedUserMessage = messages.some((message) =>
    getStringField(message, "user") === trackedSlackUserId ||
    getStringField(message, "parent_user_id") === trackedSlackUserId
  )
  return hasThreadedReply && hasTrackedUserMessage
}

const shouldIgnoreSlackMessageEvent = (event: unknown): boolean => {
  const subtype = getStringField(event, "subtype")
  if (subtype === "message_changed") {
    return getObjectField(event, "message") === undefined
  }

  if (getBooleanField(event, "hidden")) {
    return true
  }

  return subtype !== null && ignoredMessageSubtypes.has(subtype)
}

const socketMessageEventSource = (event: unknown): SocketMessageEventSource | null => {
  if (getStringField(event, "type") !== "message" || shouldIgnoreSlackMessageEvent(event)) {
    return null
  }

  if (getStringField(event, "subtype") === "message_changed") {
    return {
      message: getObjectField(event, "message"),
      isMessageChanged: true,
      fallbackChannelId: getStringField(event, "channel"),
      fallbackTeamId: getStringField(event, "team")
    }
  }

  return {
    message: event,
    isMessageChanged: false,
    fallbackChannelId: null,
    fallbackTeamId: null
  }
}

const slackMessageFromApiMessage = (
  message: unknown,
  eventIdPrefix: string,
  teamId: string | null,
  channelId: string,
  channelName: string | null,
  rootThreadTs: string,
  actorProfile: SlackActorProfile,
  fallbackMySlackUserId: string,
  linearWorkspaceUrl: string | null
): SlackMessageProjectionInput | null => {
  const messageTs = getStringField(message, "ts")
  if (messageTs === null) {
    return null
  }

  const userId = getStringField(message, "user") ?? getStringField(message, "bot_id")
  const eventId = `${eventIdPrefix}:${channelId}:${messageTs}`

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
    userName: actorProfile.name,
    userImageUrl: actorProfile.imageUrl,
    text: getStringField(message, "text") ?? "",
    rawJson: stringifySlackPayload({
      team_id: teamId,
      event_id: eventId,
      event: message
    }),
    mySlackUserId: fallbackMySlackUserId,
    slackPermalink: buildSlackNativeMessageUrl(teamId, channelId, rootThreadTs),
    linearWorkspaceUrl
  }
}

const backfillProgram = (days: number) =>
  Effect.gen(function*() {
    if (!Number.isFinite(days) || days <= 0) {
      return yield* Effect.fail(ConfigError.make({ message: "Backfill days must be a positive number." }))
    }

    const config = yield* AppConfigService
    const slack = yield* SlackApiClient
    const workflows = yield* ThreadWorkflows
    const store = yield* ThreadStore
    const trackedSlackUserId = yield* workflows.getTrackedSlackUserId()
    const workspace = yield* slack.authTest().pipe(Effect.catchCause(() => Effect.succeed(unknownWorkspace())))
    const oldest = `${Math.floor(Date.now() / 1000) - Math.floor(days * 24 * 60 * 60)}`

    const conversations = yield* slack.pagedItems("conversations.list", "channels", {
      types: "public_channel,private_channel,im,mpim",
      exclude_archived: "true"
    })

    const readableConversations = conversations.filter((conversation) => {
      const isPrivate = getBooleanField(conversation, "is_private")
      const isIm = getBooleanField(conversation, "is_im")
      const isMpim = getBooleanField(conversation, "is_mpim")
      const isMember = getBooleanField(conversation, "is_member")
      return isIm || isMpim || (isPrivate ? isMember : true)
    })

    let channelsScanned = 0
    let threadsScanned = 0
    let threadsCreated = 0
    let messagesIngested = 0

    for (const conversation of readableConversations) {
      const channelId = getStringField(conversation, "id")
      if (channelId === null) {
        continue
      }

      channelsScanned += 1
      const channelName = getStringField(conversation, "name")
      const history: ReadonlyArray<unknown> = yield* slack.pagedItems("conversations.history", "messages", {
        channel: channelId,
        oldest
      }).pipe(Effect.catchCause(() => Effect.succeed<ReadonlyArray<unknown>>([])))

      const candidateRootThreadTs = new Set<string>()
      for (const message of history) {
        const messageTs = getStringField(message, "ts")
        if (messageTs === null) {
          continue
        }

        const threadTs = getStringField(message, "thread_ts")
        const rootThreadTs = threadTs ?? ((getNumberField(message, "reply_count") ?? 0) > 0 ? messageTs : null)
        if (rootThreadTs !== null) {
          candidateRootThreadTs.add(rootThreadTs)
        }
      }

      for (const rootTs of candidateRootThreadTs) {
        threadsScanned += 1
        const threadKey = buildThreadKey(workspace.id, channelId, rootTs)
        const exists = yield* store.cardExists(threadKey)
        const replies: ReadonlyArray<unknown> = yield* slack.pagedItems("conversations.replies", "messages", {
          channel: channelId,
          ts: rootTs
        }).pipe(Effect.catchCause(() => Effect.succeed<ReadonlyArray<unknown>>([])))

        if (!rawSlackThreadMatchesTrackingRule(replies, trackedSlackUserId, rootTs)) {
          continue
        }

        const normalizedMessages: Array<SlackMessageProjectionInput> = []
        for (const reply of replies.toSorted((left, right) =>
          (getStringField(left, "ts") ?? "").localeCompare(getStringField(right, "ts") ?? "")
        )) {
          const userId = getStringField(reply, "user") ?? getStringField(reply, "bot_id")
          const actorProfile = yield* slack.getActorProfile(userId).pipe(
            Effect.catchCause(() => Effect.succeed(slackActorProfileFromName(null)))
          )
          const normalized = slackMessageFromApiMessage(
            reply,
            "backfill",
            workspace.id,
            channelId,
            channelName,
            rootTs,
            actorProfile,
            trackedSlackUserId,
            config.linearWorkspaceUrl
          )
          if (normalized === null) {
            continue
          }

          normalizedMessages.push(normalized)
        }

        const result = yield* workflows.ingestSlackThread(normalizedMessages)
        messagesIngested += normalizedMessages.length
        if (result !== null) {
          threadsCreated += exists ? 0 : 1
        }
      }
    }

    const response: BackfillResponse = {
      ok: true,
      channelsScanned,
      threadsScanned,
      threadsCreated,
      messagesIngested
    }
    return response
  })

export const backfillSlackThreads = async (
  runtime: AppRuntime,
  days: number
): Promise<BackfillResponse> =>
  await runtime.runPromise(backfillProgram(days))

const cachedLookup = <Value>(
  cache: Map<string, Promise<Value>>,
  key: string,
  load: () => Promise<Value>
): Promise<Value> => {
  const existing = cache.get(key)
  if (existing !== undefined) {
    return existing
  }

  const loaded = load()
  cache.set(key, loaded)
  return loaded
}

const webSocketPayloadText = (data: unknown): string | null => {
  if (typeof data === "string") {
    return data
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data)
  }
  return null
}

const parseJson = (value: string): unknown | null => {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

const cachedChannelName = (
  runtime: AppRuntime,
  cache: Map<string, Promise<string | null>>,
  channelId: string
): Promise<string | null> =>
  cachedLookup(cache, channelId, () =>
    runtime.runPromise(
      SlackApiClient.use((slack) =>
        slack.getChannelName(channelId).pipe(Effect.catchCause(() => Effect.succeed(null)))
      )
    )
  )

const cachedActorName = (
  runtime: AppRuntime,
  cache: Map<string, Promise<SlackActorProfile>>,
  actorId: string | null,
  event: unknown
): Promise<SlackActorProfile> => {
  const eventProfile = getSlackEventActorProfile(event)
  if (eventProfile.name !== null || eventProfile.imageUrl !== null || actorId === null) {
    return Promise.resolve(eventProfile)
  }

  return cachedLookup(cache, actorId, () =>
    runtime.runPromise(
      SlackApiClient.use((slack) =>
        slack.getActorProfile(actorId).pipe(
          Effect.catchCause(() => Effect.succeed(slackActorProfileFromName(null)))
        )
      )
    )
  )
}

const socketMessageProjection = async (
  config: AppConfig,
  runtime: AppRuntime,
  channelNameCache: Map<string, Promise<string | null>>,
  actorNameCache: Map<string, Promise<SlackActorProfile>>,
  payload: unknown,
  event: unknown
): Promise<SocketMessageProjectionResult | null> => {
  const source = socketMessageEventSource(event)
  if (source === null) {
    return null
  }

  const message = source.message
  const channelId = getStringField(message, "channel") ?? source.fallbackChannelId
  const messageTs = getStringField(message, "ts")
  if (channelId === null || messageTs === null) {
    return null
  }

  const rootThreadTs = getStringField(message, "thread_ts") ?? messageTs
  const teamId = getStringField(payload, "team_id") ?? getStringField(message, "team") ?? source.fallbackTeamId
  const userId = getStringField(message, "user") ?? getStringField(message, "bot_id")
  const [channelName, actorProfile, trackedSlackUserId] = await Promise.all([
    cachedChannelName(runtime, channelNameCache, channelId),
    cachedActorName(runtime, actorNameCache, userId, message),
    runtime.runPromise(ThreadWorkflows.use((workflows) => workflows.getTrackedSlackUserId()))
  ])

  const projection: SlackMessageProjectionInput = {
    teamId,
    eventId: getStringField(payload, "event_id") ?? `socket:${channelId}:${messageTs}`,
    eventTs: messageTs,
    channelId,
    channelName,
    messageTs,
    rootThreadTs,
    userId,
    parentUserId: getStringField(message, "parent_user_id"),
    userName: actorProfile.name,
    userImageUrl: actorProfile.imageUrl,
    text: getStringField(message, "text") ?? "",
    rawJson: stringifySlackPayload(payload),
    mySlackUserId: trackedSlackUserId,
    slackPermalink: buildSlackNativeMessageUrl(teamId, channelId, rootThreadTs),
    linearWorkspaceUrl: config.linearWorkspaceUrl
  }

  return {
    message: projection,
    shouldFetchThread: source.isMessageChanged || messageTs !== rootThreadTs
  }
}

const socketThreadProjections = async (
  config: AppConfig,
  runtime: AppRuntime,
  actorNameCache: Map<string, Promise<SlackActorProfile>>,
  eventProjection: SlackMessageProjectionInput,
  shouldFetchThread: boolean
): Promise<ReadonlyArray<SlackMessageProjectionInput>> => {
  if (!shouldFetchThread) {
    return [eventProjection]
  }

  const replies = await runtime.runPromise(
    SlackApiClient.use((slack) =>
      slack.pagedItems("conversations.replies", "messages", {
        channel: eventProjection.channelId,
        ts: eventProjection.rootThreadTs
      }).pipe(Effect.catchCause(() => Effect.succeed<ReadonlyArray<unknown>>([])))
    )
  )

  const projections: Array<SlackMessageProjectionInput> = [eventProjection]
  for (const reply of replies.toSorted((left, right) =>
    (getStringField(left, "ts") ?? "").localeCompare(getStringField(right, "ts") ?? "")
  )) {
    if (shouldIgnoreSlackMessageEvent(reply)) {
      continue
    }

    const userId = getStringField(reply, "user") ?? getStringField(reply, "bot_id")
    const actorProfile = await cachedActorName(runtime, actorNameCache, userId, reply)
    const normalized = slackMessageFromApiMessage(
      reply,
      "thread",
      eventProjection.teamId,
      eventProjection.channelId,
      eventProjection.channelName,
      eventProjection.rootThreadTs,
      actorProfile,
      eventProjection.mySlackUserId,
      config.linearWorkspaceUrl
    )
    if (normalized !== null) {
      projections.push(normalized)
    }
  }

  return projections
}

const acknowledgeEnvelope = (socket: WebSocket, envelope: unknown): void => {
  const envelopeId = getStringField(envelope, "envelope_id")
  if (envelopeId !== null && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ envelope_id: envelopeId }))
  }
}

export const startSlackEventListener = (
  config: AppConfig,
  runtime: AppRuntime
): (() => void) => {
  if (config.slackAppToken === null) {
    console.warn("SLACK_APP_TOKEN is not set; Slack live events are disabled.")
    return () => undefined
  }

  let stopped = false
  let socket: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectDelayMs = 1000
  const channelNameCache = new Map<string, Promise<string | null>>()
  const actorNameCache = new Map<string, Promise<SlackActorProfile>>()

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer !== null) {
      return
    }

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void connect()
    }, reconnectDelayMs)
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000)
  }

  const handleEnvelope = async (envelope: unknown) => {
    if (getStringField(envelope, "type") !== "events_api") {
      return
    }

    const payload = getObjectField(envelope, "payload")
    const event = getObjectField(payload, "event")
    const projectionResult = await socketMessageProjection(config, runtime, channelNameCache, actorNameCache, payload, event)
    if (projectionResult === null) {
      return
    }

    const projections = await socketThreadProjections(
      config,
      runtime,
      actorNameCache,
      projectionResult.message,
      projectionResult.shouldFetchThread
    )
    const threadKey = await runtime.runPromise(
      ThreadWorkflows.use((workflows) => workflows.ingestSlackThread(projections))
    )
    if (threadKey !== null) {
      console.log(`Updated Slack thread ${threadKey}`)
    }
  }

  const connect = async () => {
    if (stopped) {
      return
    }

    try {
      const url = await runtime.runPromise(SlackApiClient.use((slack) => slack.openSocketUrl()))
      if (stopped) {
        return
      }

      const nextSocket = new WebSocket(url)
      socket = nextSocket

      nextSocket.addEventListener("open", () => {
        reconnectDelayMs = 1000
        console.log("Slack Socket Mode listener connected.")
      })

      nextSocket.addEventListener("message", (event) => {
        const text = webSocketPayloadText(event.data)
        if (text === null) {
          return
        }

        const envelope = parseJson(text)
        if (envelope === null) {
          return
        }

        acknowledgeEnvelope(nextSocket, envelope)
        void handleEnvelope(envelope).catch((cause) => {
          console.warn(`Slack event handling failed: ${causeMessage(cause)}`)
        })
      })

      nextSocket.addEventListener("error", () => {
        console.warn("Slack Socket Mode connection errored.")
      })

      nextSocket.addEventListener("close", () => {
        if (socket === nextSocket) {
          socket = null
        }
        if (!stopped) {
          console.warn("Slack Socket Mode listener disconnected; reconnecting.")
          scheduleReconnect()
        }
      })
    } catch (cause) {
      console.warn(`Slack Socket Mode listener failed to connect: ${causeMessage(cause)}`)
      scheduleReconnect()
    }
  }

  void connect()

  return () => {
    stopped = true
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (socket !== null) {
      socket.close()
      socket = null
    }
  }
}
