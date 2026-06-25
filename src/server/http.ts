import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { ManagedRuntime } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type { CardStatus } from "../shared/types"
import { AppConfigService } from "./config"
import { ReferenceEnricher } from "./metadata"
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

  app.get("/api/health", (context) =>
    context.json({
      ok: true
    })
  )

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

  const server = serve({
    fetch: app.fetch,
    hostname: "127.0.0.1",
    port
  })

  console.log(`HTTP API listening on http://127.0.0.1:${port}`)
  return server
}
