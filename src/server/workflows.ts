import { Context, Effect, Layer } from "effect"
import type { CardStatus } from "../shared/types"
import { AppConfigService } from "./config"
import { buildThreadKey, extractReferences, shouldTrackMessage, type SlackMessageProjectionInput } from "./domain"
import { ConfigError } from "./errors"
import { ReferenceEnricher } from "./metadata"
import { ThreadStore, type ManualStatusInput } from "./store"

const getConfiguredTrackedSlackUserId = Effect.fn("ThreadWorkflows.getConfiguredTrackedSlackUserId")(function*() {
  const store = yield* ThreadStore
  const slackUserId = yield* store.getSlackUserId()
  if (slackUserId === null) {
    return yield* Effect.fail(
      ConfigError.make({
        message: "Tracked Slack user is not configured. Set SLACK_USER_TOKEN and restart the app."
      })
    )
  }
  return slackUserId
})

export class ThreadWorkflows extends Context.Service<ThreadWorkflows>()(
  "ThreadWorkflows",
  {
    make: Effect.succeed({
      getTrackedSlackUserId: Effect.fn("ThreadWorkflows.getTrackedSlackUserId")(function*() {
        return yield* getConfiguredTrackedSlackUserId()
      }),

      ingestSlackMessage: Effect.fn("ThreadWorkflows.ingestSlackMessage")(function*(message: SlackMessageProjectionInput) {
        const store = yield* ThreadStore
        const enricher = yield* ReferenceEnricher
        const config = yield* AppConfigService
        const mySlackUserId = yield* getConfiguredTrackedSlackUserId()
        const messageForTracking = {
          ...message,
          mySlackUserId
        }
        const threadKey = buildThreadKey(message.teamId, message.channelId, message.rootThreadTs)

        yield* store.recordSlackEvent(messageForTracking)

        const exists = yield* store.cardExists(threadKey)
        if (!shouldTrackMessage(messageForTracking, exists)) {
          return null
        }

        const references = extractReferences(message.text, {
          linearWorkspaceUrl: config.linearWorkspaceUrl
        })
        const updatedThreadKey = yield* store.upsertMessageProjection(messageForTracking, references)
        yield* enricher.enrichThread(updatedThreadKey)
        return updatedThreadKey
      }),

      setThreadStatus: Effect.fn("ThreadWorkflows.setThreadStatus")(function*(input: ManualStatusInput) {
        const store = yield* ThreadStore
        return yield* store.setStatus(input)
      }),

      listCards: Effect.fn("ThreadWorkflows.listCards")(function*() {
        const store = yield* ThreadStore
        return yield* store.listCards()
      }),

      setStatusFromBoard: Effect.fn("ThreadWorkflows.setStatusFromBoard")(function*(
        threadKey: string,
        status: CardStatus
      ) {
        const parts = threadKey.split(":")
        const teamId = parts[0] === "unknown" ? null : parts[0] ?? null
        const channelId = parts[1] ?? ""
        const rootThreadTs = parts.slice(2).join(":")
        const store = yield* ThreadStore
        const actorUserId = yield* getConfiguredTrackedSlackUserId()
        return yield* store.setStatus({
          teamId,
          channelId,
          channelName: null,
          rootThreadTs,
          actorUserId,
          status,
          source: "board",
          fallbackText: null,
          slackPermalink: null,
          rawJson: null
        })
      }),

      clearDatabase: Effect.fn("ThreadWorkflows.clearDatabase")(function*() {
        const store = yield* ThreadStore
        return yield* store.clearDatabase()
      })
    })
  }
) {
  static readonly layer = Layer.effect(this, this.make)
}
