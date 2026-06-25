import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { Effect, ManagedRuntime } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type { CardStatus, SettingsResponse, SlackWorkspace, TrackedSlackUser } from "../shared/types"
import { readableSlackActorLabel } from "../shared/slack"
import { AppConfigService, type AppConfig } from "./config"
import { ReferenceEnricher } from "./metadata"
import { backfillSlackThreads } from "./slack"
import { ThreadStore } from "./store"
import { ThreadWorkflows } from "./workflows"

type AppRuntime = ManagedRuntime.ManagedRuntime<
  AppConfigService | SqliteClient.SqliteClient | SqlClient.SqlClient | ThreadStore | ReferenceEnricher | ThreadWorkflows,
  never
>

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

const getBooleanField = (value: unknown, key: string): boolean =>
  getObjectField(value, key) === true

const slackReadToken = (config: AppConfig): string | null =>
  config.slackUserToken

const getTrackedSlackUser = async (config: AppConfig, slackUserId: string): Promise<TrackedSlackUser> => {
  const token = slackReadToken(config)
  if (token === null) {
    return {
      id: slackUserId,
      name: null,
      imageUrl: null
    }
  }

  try {
    const response = await fetch("https://slack.com/api/users.info", {
      headers: {
        authorization: `Bearer ${token}`
      },
      method: "POST",
      body: new URLSearchParams({
        user: slackUserId
      })
    })
    const body: unknown = await response.json()
    const user = getObjectField(body, "user")
    const profile = getObjectField(user, "profile")
    return {
      id: slackUserId,
      name: readableSlackActorLabel(getStringField(profile, "display_name")) ??
        readableSlackActorLabel(getStringField(profile, "real_name")) ??
        readableSlackActorLabel(getStringField(user, "name")),
      imageUrl: getStringField(profile, "image_72") ?? getStringField(profile, "image_48")
    }
  } catch {
    return {
      id: slackUserId,
      name: null,
      imageUrl: null
    }
  }
}

const unknownSlackWorkspace = (): SlackWorkspace => ({
  id: null,
  name: null,
  url: null
})

const getSlackWorkspace = async (config: AppConfig): Promise<SlackWorkspace> => {
  const token = slackReadToken(config)
  if (token === null) {
    return unknownSlackWorkspace()
  }

  try {
    const response = await fetch("https://slack.com/api/auth.test", {
      headers: {
        authorization: `Bearer ${token}`
      },
      method: "POST"
    })
    const body: unknown = await response.json()
    if (!getBooleanField(body, "ok")) {
      return unknownSlackWorkspace()
    }

    return {
      id: getStringField(body, "team_id"),
      name: getStringField(body, "team"),
      url: getStringField(body, "url")
    }
  } catch {
    return unknownSlackWorkspace()
  }
}

const parsePositiveDays = (value: unknown): number | null => {
  const numericValue = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number.parseFloat(value)
      : Number.NaN
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : null
}

const parseNonNegativeSeconds = (value: unknown): number | null => {
  const numericValue = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number.parseFloat(value)
      : Number.NaN
  return Number.isFinite(numericValue) && numericValue >= 0 ? Math.floor(numericValue) : null
}

const parseStatus = (value: string | null): CardStatus | null => {
  if (value === "new_message" || value === "awaiting_reply" || value === "resolved") {
    return value
  }
  return null
}

export const startHttpServer = (
  port: number,
  runtime: AppRuntime
) => {
  const app = new Hono()

  const runtimeConfig = () =>
    runtime.runPromise(
      Effect.gen(function*() {
        return yield* AppConfigService
      })
    )

  const settingsResponse = async (): Promise<SettingsResponse> => {
    const config = await runtimeConfig()
    const slackUserId = await runtime.runPromise(
      ThreadWorkflows.use((workflows) => workflows.getTrackedSlackUserId())
    )
    const slackPublicPollSeconds = await runtime.runPromise(
      ThreadWorkflows.use((workflows) => workflows.getSlackPublicPollSeconds())
    )
    const [trackedUser, workspace] = await Promise.all([
      getTrackedSlackUser(config, slackUserId),
      getSlackWorkspace(config)
    ])
    return {
      slackUserId,
      slackPublicPollSeconds,
      trackedUser,
      workspace
    }
  }

  app.get("/api/health", (context) =>
    context.json({
      ok: true
    })
  )

  app.get("/api/meta", async (context) =>
    context.json({
      trackedUser: (await settingsResponse()).trackedUser
    })
  )

  app.get("/api/settings", async (context) =>
    context.json(await settingsResponse())
  )

  app.patch("/api/settings", async (context) => {
    const body: unknown = await context.req.json().catch(() => null)
    const slackUserId = getStringField(body, "slackUserId")
    if (slackUserId !== null) {
      if (slackUserId.trim() === "") {
        return context.json({ error: "slackUserId cannot be blank" }, 400)
      }

      await runtime.runPromise(
        ThreadWorkflows.use((workflows) => workflows.setTrackedSlackUserId(slackUserId.trim()))
      )
    }

    const rawPollSeconds = getObjectField(body, "slackPublicPollSeconds")
    if (rawPollSeconds !== undefined) {
      const slackPublicPollSeconds = parseNonNegativeSeconds(rawPollSeconds)
      if (slackPublicPollSeconds === null) {
        return context.json({ error: "slackPublicPollSeconds must be a non-negative number" }, 400)
      }

      await runtime.runPromise(
        ThreadWorkflows.use((workflows) => workflows.setSlackPublicPollSeconds(slackPublicPollSeconds))
      )
    }

    return context.json(await settingsResponse())
  })

  app.get("/api/cards", async (context) => {
    const cards = await runtime.runPromise(
      ThreadWorkflows.use((workflows) => workflows.listCards())
    )
    return context.json({ cards })
  })

  app.patch("/api/cards/:threadKey/status", async (context) => {
    const threadKey = context.req.param("threadKey")
    const body: unknown = await context.req.json().catch(() => null)
    const status = parseStatus(getStringField(body, "status"))

    if (status === null) {
      return context.json({ error: "Invalid status" }, 400)
    }

    await runtime.runPromise(
      ThreadWorkflows.use((workflows) => workflows.setStatusFromBoard(threadKey, status))
    )
    return context.json({ ok: true })
  })

  app.post("/api/dev/slack-message", async (context) => {
    const body: unknown = await context.req.json().catch(() => null)
    const channelId = getStringField(body, "channelId")
    const messageTs = getStringField(body, "messageTs")
    const text = getStringField(body, "text")
    const mySlackUserId = getStringField(body, "mySlackUserId")

    if (channelId === null || messageTs === null || text === null || mySlackUserId === null) {
      return context.json({ error: "channelId, messageTs, text, and mySlackUserId are required" }, 400)
    }

    const teamId = getStringField(body, "teamId")
    const eventTs = getStringField(body, "eventTs") ?? messageTs
    const rootThreadTs = getStringField(body, "rootThreadTs") ?? messageTs

    const threadKey = await runtime.runPromise(
      ThreadWorkflows.use((workflows) =>
        workflows.ingestSlackMessage({
          teamId,
          eventId: getStringField(body, "eventId") ?? `dev:${channelId}:${messageTs}`,
          eventTs,
          channelId,
          channelName: getStringField(body, "channelName"),
          messageTs,
          rootThreadTs,
          userId: getStringField(body, "userId"),
          parentUserId: getStringField(body, "parentUserId"),
          userName: getStringField(body, "userName"),
          text,
          rawJson: JSON.stringify(body),
          mySlackUserId,
          slackPermalink: getStringField(body, "slackPermalink"),
          linearWorkspaceUrl: getStringField(body, "linearWorkspaceUrl")
        })
      )
    )

    return context.json({ ok: true, threadKey })
  })

  app.post("/api/reprocess", (context) =>
    context.json({
      ok: true,
      message: "Raw events are retained; full replay will be added after the MVP lifecycle is verified."
    })
  )

  app.post("/api/backfill", async (context) => {
    const body: unknown = await context.req.json().catch(() => null)
    const days = parsePositiveDays(getObjectField(body, "days"))
    if (days === null) {
      return context.json({ error: "days must be a positive number" }, 400)
    }

    const result = await backfillSlackThreads(await runtimeConfig(), runtime, days)
    return context.json(result)
  })

  app.post("/api/sync", async (context) => {
    const config = await runtimeConfig()
    const result = await backfillSlackThreads(config, runtime, config.slackPublicPollDays, { includeExisting: true })
    return context.json(result)
  })

  app.post("/api/admin/clear-db", async (context) => {
    await runtime.runPromise(
      ThreadWorkflows.use((workflows) => workflows.clearDatabase())
    )
    return context.json({ ok: true })
  })

  const server = serve({
    fetch: app.fetch,
    hostname: "127.0.0.1",
    port
  })

  console.log(`HTTP API listening on http://127.0.0.1:${port}`)
  return server
}
