import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { Effect, ManagedRuntime } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type { CardStatus, SettingsResponse, SlackWorkspace, TrackedSlackUser } from "../shared/types"
import { AppConfigService } from "./config"
import { ReferenceEnricher } from "./metadata"
import { backfillSlackThreads, SlackApiClient } from "./slack"
import { ThreadStore } from "./store"
import { ThreadWorkflows } from "./workflows"

type AppRuntime = ManagedRuntime.ManagedRuntime<
  AppConfigService | SqliteClient.SqliteClient | SqlClient.SqlClient | ThreadStore | ReferenceEnricher | ThreadWorkflows | SlackApiClient,
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

const unknownSlackWorkspace = (): SlackWorkspace => ({
  id: null,
  name: null,
  url: null
})

const parsePositiveDays = (value: unknown): number | null => {
  const numericValue = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number.parseFloat(value)
      : Number.NaN
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : null
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

  const getTrackedSlackUser = async (slackUserId: string): Promise<TrackedSlackUser> =>
    await runtime.runPromise(
      SlackApiClient.use((slack) =>
        slack.getUser(slackUserId).pipe(
          Effect.catchCause(() =>
            Effect.succeed({
              id: slackUserId,
              name: null,
              imageUrl: null
            })
          )
        )
      )
    )

  const getSlackWorkspace = async (): Promise<SlackWorkspace> =>
    await runtime.runPromise(
      SlackApiClient.use((slack) =>
        slack.authTest().pipe(Effect.catchCause(() => Effect.succeed(unknownSlackWorkspace())))
      )
    )

  const settingsResponse = async (): Promise<SettingsResponse> => {
    const slackUserId = await runtime.runPromise(
      ThreadWorkflows.use((workflows) => workflows.getTrackedSlackUserId())
    )
    const [trackedUser, workspace] = await Promise.all([
      getTrackedSlackUser(slackUserId),
      getSlackWorkspace()
    ])
    return {
      slackUserId,
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

    const result = await backfillSlackThreads(runtime, days)
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
