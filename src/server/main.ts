import "dotenv/config"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Layer, ManagedRuntime } from "effect"
import { AppConfigService, readConfig } from "./config"
import { ReferenceEnricher } from "./metadata"
import { startHttpServer } from "./http"
import { SlackApiClient, startSlackEventListener } from "./slack"
import { ThreadStore } from "./store"
import { ThreadWorkflows } from "./workflows"

const config = readConfig()

const AppLayer = Layer.mergeAll(
  AppConfigService.layerFromConfig(config),
  SqliteClient.layer({
    filename: config.databaseFile
  }),
  ThreadStore.layer,
  ReferenceEnricher.layer,
  SlackApiClient.layer,
  ThreadWorkflows.layer
)

const runtime = ManagedRuntime.make(AppLayer)

const boot = Effect.gen(function*() {
  const store = yield* ThreadStore
  yield* store.migrate()
  yield* store.ensureSlackUserId(config.mySlackUserId)
})

await runtime.runPromise(boot)

const server = startHttpServer(config.port, runtime)
const stopSlackEvents = startSlackEventListener(config, runtime)

const shutdown = async () => {
  console.log("Shutting down Slack Thread Monitor.")
  stopSlackEvents()
  server.close()
  await runtime.dispose()
}

process.once("SIGINT", () => {
  shutdown().finally(() => process.exit(0))
})

process.once("SIGTERM", () => {
  shutdown().finally(() => process.exit(0))
})
