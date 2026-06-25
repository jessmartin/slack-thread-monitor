import { Context, Effect, Layer } from "effect"
import type { ThreadReference } from "../shared/types"
import { ExternalApiError } from "./errors"
import { AppConfigService } from "./config"
import { ThreadStore, type ReferenceMetadataInput } from "./store"

interface GitHubParts {
  readonly owner: string
  readonly repo: string
  readonly number: string
}

interface ExternalIssueMetadata {
  readonly url: string
  readonly title: string | null
  readonly state: string | null
}

const githubParts = (reference: ThreadReference): GitHubParts | null => {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)/.exec(reference.url)
  if (match === null) {
    return null
  }
  return {
    owner: match[1],
    repo: match[2],
    number: match[3]
  }
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

const fetchJson = (
  provider: string,
  url: string,
  init: RequestInit
) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, init)
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`)
      }
      return await response.json()
    },
    catch: (cause) =>
      ExternalApiError.make({
        provider,
        message: `Failed to fetch ${url}`,
        cause: String(cause)
      })
  })

const enrichGitHub = (reference: ThreadReference) =>
  Effect.gen(function*() {
    const config = yield* AppConfigService
    const parts = githubParts(reference)
    if (parts === null) {
      return null
    }

    const headers = new Headers({
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    })
    if (config.githubToken !== null) {
      headers.set("Authorization", `Bearer ${config.githubToken}`)
    }

    const payload = yield* fetchJson(
      "github",
      `https://api.github.com/repos/${parts.owner}/${parts.repo}/issues/${parts.number}`,
      { headers }
    )

    const title = getStringField(payload, "title")
    const state = getStringField(payload, "state")
    const htmlUrl = getStringField(payload, "html_url") ?? reference.url

    return {
      url: htmlUrl,
      title,
      state
    }
  })

const enrichLinear = (reference: ThreadReference) =>
  Effect.gen(function*() {
    const config = yield* AppConfigService
    if (config.linearApiKey === null) {
      return null
    }

    const payload = yield* fetchJson(
      "linear",
      "https://api.linear.app/graphql",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${config.linearApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          query: `
            query Issue($id: String!) {
              issue(id: $id) {
                identifier
                title
                url
                state { name }
              }
            }
          `,
          variables: {
            id: reference.displayKey
          }
        })
      }
    )

    const data = getObjectField(payload, "data")
    const issue = getObjectField(data, "issue")
    if (issue === undefined || issue === null) {
      return null
    }

    const state = getObjectField(issue, "state")
    return {
      url: getStringField(issue, "url") ?? reference.url,
      title: getStringField(issue, "title"),
      state: getStringField(state, "name")
    }
  })

const metadataInput = (
  reference: ThreadReference,
  metadata: ExternalIssueMetadata
): ReferenceMetadataInput => ({
  provider: reference.provider,
  displayKey: reference.displayKey,
  url: metadata.url,
  title: metadata.title,
  state: metadata.state
})

export class ReferenceEnricher extends Context.Service<ReferenceEnricher>()(
  "ReferenceEnricher",
  {
    make: Effect.succeed({
      enrichThread: Effect.fn("ReferenceEnricher.enrichThread")(function*(threadKey: string) {
        const store = yield* ThreadStore
        const references = yield* store.listReferencesForThread(threadKey)

        yield* Effect.forEach(
          references,
          (reference) =>
            Effect.gen(function*() {
              const metadata = yield* (
                reference.provider === "github" ? enrichGitHub(reference) : enrichLinear(reference)
              ).pipe(
                Effect.catchCause(() => Effect.succeed(null))
              )

              if (metadata !== null) {
                yield* store.updateReferenceMetadata(threadKey, metadataInput(reference, metadata))
              }
            }),
          { discard: true }
        )
      })
    })
  }
) {
  static readonly layer = Layer.effect(this, this.make)
}
