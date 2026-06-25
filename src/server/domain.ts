import type { CardStatus, ReferenceProvider, ReferenceType, ThreadReference } from "../shared/types"
import { renderSlackPlainText } from "../shared/slack"

export interface ExtractReferencesOptions {
  readonly linearWorkspaceUrl: string | null
}

export interface ReferenceDraft {
  readonly provider: ReferenceProvider
  readonly referenceType: ReferenceType
  readonly displayKey: string
  readonly url: string
}

export interface NormalizedSlackMessage {
  readonly teamId: string | null
  readonly eventId: string
  readonly eventTs: string
  readonly channelId: string
  readonly channelName: string | null
  readonly messageTs: string
  readonly rootThreadTs: string
  readonly userId: string | null
  readonly parentUserId: string | null
  readonly userName: string | null
  readonly text: string
  readonly rawJson: string
}

export interface SlackMessageProjectionInput extends NormalizedSlackMessage {
  readonly mySlackUserId: string
  readonly slackPermalink: string | null
  readonly linearWorkspaceUrl: string | null
}

export const parseCardStatus = (value: string): CardStatus =>
  value === "awaiting_reply" || value === "resolved" ? value : "new_message"

export const buildThreadKey = (
  teamId: string | null,
  channelId: string,
  rootThreadTs: string
) => `${teamId ?? "unknown"}:${channelId}:${rootThreadTs}`

export const normalizeWhitespace = (value: string): string =>
  value.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim()

export const buildExcerpt = (value: string, maxLines = 4, maxChars = 360): string => {
  const normalized = normalizeWhitespace(renderSlackPlainText(value))
  const lines = normalized.split("\n").slice(0, maxLines)
  const excerpt = lines.join("\n")
  return excerpt.length > maxChars ? `${excerpt.slice(0, maxChars - 1)}...` : excerpt
}

export const isMentioned = (text: string, slackUserId: string): boolean =>
  text.includes(`<@${slackUserId}>`)

export const shouldTrackMessage = (
  message: SlackMessageProjectionInput,
  existingCard: boolean
): boolean =>
  existingCard ||
  message.userId === message.mySlackUserId ||
  message.parentUserId === message.mySlackUserId ||
  isMentioned(message.text, message.mySlackUserId)

const trimUrl = (value: string): string => {
  const withoutSlackLabel = value.split("|")[0] ?? value
  return withoutSlackLabel.replace(/[>,.)\]]+$/g, "")
}

const normalizeLinearBase = (value: string | null): string | null => {
  if (value === null || value.trim() === "") {
    return null
  }
  return value.replace(/\/+$/g, "")
}

const bareLinearUrl = (issueId: string, workspaceUrl: string | null): string =>
  workspaceUrl === null ? `https://linear.app/issue/${issueId}` : `${workspaceUrl}/issue/${issueId}`

const addUnique = (
  existing: ReadonlyArray<ReferenceDraft>,
  draft: ReferenceDraft
): ReadonlyArray<ReferenceDraft> => {
  const exists = existing.some((reference) =>
    reference.provider === draft.provider && reference.displayKey === draft.displayKey
  )
  if (!exists) {
    return [...existing, draft]
  }

  return existing.map((reference) => {
    if (reference.provider !== draft.provider || reference.displayKey !== draft.displayKey) {
      return reference
    }
    if (draft.referenceType === "pull_request" && reference.referenceType !== "pull_request") {
      return draft
    }
    return draft.url.length > reference.url.length ? draft : reference
  })
}

export const extractReferences = (
  text: string,
  options: ExtractReferencesOptions
): ReadonlyArray<ReferenceDraft> => {
  const linearWorkspaceUrl = normalizeLinearBase(options.linearWorkspaceUrl)
  let references: ReadonlyArray<ReferenceDraft> = []

  for (const match of text.matchAll(/https:\/\/linear\.app\/[^\s<>|)]+/g)) {
    const url = trimUrl(match[0])
    const issueId = /([A-Z][A-Z0-9]+-\d+)/.exec(url)?.[1] ?? "Linear"
    references = addUnique(references, {
      provider: "linear",
      referenceType: "issue",
      displayKey: issueId,
      url
    })
  }

  for (const match of text.matchAll(/\b([A-Z][A-Z0-9]{1,12}-\d+)\b/g)) {
    const issueId = match[1]
    references = addUnique(references, {
      provider: "linear",
      referenceType: "issue",
      displayKey: issueId,
      url: bareLinearUrl(issueId, linearWorkspaceUrl)
    })
  }

  for (const match of text.matchAll(/https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(issues|pull)\/(\d+)/g)) {
    const owner = match[1]
    const repo = match[2]
    const kind = match[3]
    const number = match[4]
    references = addUnique(references, {
      provider: "github",
      referenceType: kind === "pull" ? "pull_request" : "issue",
      displayKey: `${owner}/${repo}#${number}`,
      url: `https://github.com/${owner}/${repo}/${kind}/${number}`
    })
  }

  for (const match of text.matchAll(/\b([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)\b/g)) {
    const owner = match[1]
    const repo = match[2]
    const number = match[3]
    references = addUnique(references, {
      provider: "github",
      referenceType: "issue",
      displayKey: `${owner}/${repo}#${number}`,
      url: `https://github.com/${owner}/${repo}/issues/${number}`
    })
  }

  return references
}

export const blankReference = (draft: ReferenceDraft): ThreadReference => ({
  provider: draft.provider,
  referenceType: draft.referenceType,
  displayKey: draft.displayKey,
  url: draft.url,
  title: null,
  state: null
})
