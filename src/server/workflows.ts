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
      ingestSlackMessage: Effect.fn("ThreadWorkflows.ingestSlackMessage")(function*(message: SlackMessageProjectionInput) {
        const config = yield* AppConfigService
        const store = yield* ThreadStore
        const enricher = yield* ReferenceEnricher
        const threadKey = buildThreadKey(message.teamId, message.channelId, message.rootThreadTs)

        yield* store.recordSlackEvent(message)

        const exists = yield* store.cardExists(threadKey)
        if (!shouldTrackMessage(message, exists)) {
          return null
        }

        const references = extractReferences(message.text, {
          linearWorkspaceUrl: config.linearWorkspaceUrl
        })
        const updatedThreadKey = yield* store.upsertMessageProjection(message, references)
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
        return yield* store.setStatus({
          teamId,
          channelId,
          channelName: null,
          rootThreadTs,
          actorUserId: config.mySlackUserId,
          status,
          source: "board",
          fallbackText: null,
          slackPermalink: null,
          rawJson: null
        })
      })
    })
  }
) {
  static readonly layer = Layer.effect(this, this.make)
}
