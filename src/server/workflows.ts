import { Context, Effect, Layer } from "effect"
import type { CardStatus } from "../shared/types"
import { AppConfigService } from "./config"
import { buildThreadKey, extractReferences, shouldTrackMessage, type SlackMessageProjectionInput } from "./domain"
import { ReferenceEnricher } from "./metadata"
import { ThreadStore, type ManualStatusInput } from "./store"

export class ThreadWorkflows extends Context.Service<ThreadWorkflows>()(
  "ThreadWorkflows",
  {
    make: Effect.succeed({
      getTrackedSlackUserId: Effect.fn("ThreadWorkflows.getTrackedSlackUserId")(function*() {
        const config = yield* AppConfigService
        const store = yield* ThreadStore
        return yield* store.getSlackUserId(config.mySlackUserId)
      }),

      setTrackedSlackUserId: Effect.fn("ThreadWorkflows.setTrackedSlackUserId")(function*(slackUserId: string) {
        const store = yield* ThreadStore
        yield* store.setSlackUserId(slackUserId)
        return slackUserId
      }),

      getSlackPublicPollSeconds: Effect.fn("ThreadWorkflows.getSlackPublicPollSeconds")(function*() {
        const config = yield* AppConfigService
        const store = yield* ThreadStore
        return yield* store.getSlackPublicPollSeconds(config.slackPublicPollSeconds)
      }),

      setSlackPublicPollSeconds: Effect.fn("ThreadWorkflows.setSlackPublicPollSeconds")(function*(seconds: number) {
        const store = yield* ThreadStore
        yield* store.setSlackPublicPollSeconds(seconds)
        return Math.max(0, Math.floor(seconds))
      }),

      ingestSlackMessage: Effect.fn("ThreadWorkflows.ingestSlackMessage")(function*(message: SlackMessageProjectionInput) {
        const config = yield* AppConfigService
        const store = yield* ThreadStore
        const enricher = yield* ReferenceEnricher
        const mySlackUserId = yield* store.getSlackUserId(config.mySlackUserId)
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
        const config = yield* AppConfigService
        const store = yield* ThreadStore
        const actorUserId = yield* store.getSlackUserId(config.mySlackUserId)
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
