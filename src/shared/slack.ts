import { gemoji } from "gemoji"

const slackInternalIdPattern = /^[BUW][A-Z0-9]{8,}$/
const slackEmojiAliasPattern = /:([A-Za-z0-9_+-]+(?:-[A-Za-z0-9_+-]+)*):/g
const slackUserMentionIdPattern = /^@([UW][A-Z0-9]+)$/
const slackSubteamMentionIdPattern = /^!subteam\^([A-Z0-9]+)$/
const emojiByName = new Map(
  gemoji.flatMap((emoji) => emoji.names.map((name) => [name, emoji.emoji] as const))
)

const slackEmojiAliases = new Map<string, string>([
  ["women-with-bunny-ears-partying", "👯‍♀️"],
  ["woman-with-bunny-ears-partying", "👯‍♀️"],
  ["men-with-bunny-ears-partying", "👯‍♂️"],
  ["man-with-bunny-ears-partying", "👯‍♂️"]
])

export type SlackTextSegment =
  | {
    readonly kind: "text"
    readonly text: string
  }
  | {
    readonly kind: "link"
    readonly label: string
    readonly url: string
  }

export interface SlackMentionLabels {
  readonly users: Readonly<Record<string, string | null>>
  readonly subteams: Readonly<Record<string, string | null>>
}

export interface SlackMentionIds {
  readonly userIds: ReadonlyArray<string>
  readonly subteamIds: ReadonlyArray<string>
}

const emptyMentionLabels: SlackMentionLabels = {
  users: {},
  subteams: {}
}

export const readableSlackActorLabel = (value: string | null): string | null => {
  if (value === null) {
    return null
  }

  const trimmed = value.trim()
  if (trimmed === "" || slackInternalIdPattern.test(trimmed)) {
    return null
  }

  return trimmed
}

export const normalizeSlackMessageTs = (value: string): string => {
  const trimmed = value.trim()
  if (/^\d{10}\.\d+$/.test(trimmed)) {
    return trimmed
  }

  const compact = trimmed.startsWith("p") ? trimmed.slice(1) : trimmed
  if (/^\d{11,}$/.test(compact)) {
    return `${compact.slice(0, 10)}.${compact.slice(10)}`
  }

  return trimmed
}

export const buildSlackNativeMessageUrl = (
  teamId: string | null,
  channelId: string,
  messageTs: string
): string | null => {
  if (teamId === null || teamId.trim() === "" || channelId.trim() === "" || messageTs.trim() === "") {
    return null
  }

  const params = new URLSearchParams({
    team: teamId,
    id: channelId,
    message: normalizeSlackMessageTs(messageTs)
  })
  return `slack://channel?${params.toString()}`
}

export const decodeSlackEntities = (value: string): string =>
  value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")

export const renderSlackEmojiAliases = (value: string): string =>
  value.replace(slackEmojiAliasPattern, (token: string, name: string) => {
    const normalizedName = name.replace(/-/g, "_")
    return emojiByName.get(name) ??
      emojiByName.get(normalizedName) ??
      slackEmojiAliases.get(name) ??
      slackEmojiAliases.get(normalizedName) ??
      token
  })

const displayMentionLabel = (label: string | null, fallbackId: string): string => {
  const readable = readableSlackActorLabel(label)
  if (readable === null) {
    return `@${fallbackId}`
  }
  return readable.startsWith("@") ? readable : `@${readable}`
}

const mergeUnique = (
  values: ReadonlyArray<string>,
  value: string
): ReadonlyArray<string> =>
  values.includes(value) ? values : [...values, value]

export const extractSlackMentionIds = (value: string): SlackMentionIds => {
  let userIds: ReadonlyArray<string> = []
  let subteamIds: ReadonlyArray<string> = []

  for (const match of value.matchAll(/<([^>\n]+)>/g)) {
    const token = match[1]
    if (token === undefined) {
      continue
    }
    const target = decodeSlackEntities(token.split("|")[0] ?? token)
    const userMatch = slackUserMentionIdPattern.exec(target)
    if (userMatch !== null) {
      userIds = mergeUnique(userIds, userMatch[1])
      continue
    }
    const subteamMatch = slackSubteamMentionIdPattern.exec(target)
    if (subteamMatch !== null) {
      subteamIds = mergeUnique(subteamIds, subteamMatch[1])
    }
  }

  return {
    userIds,
    subteamIds
  }
}

const appendTextSegment = (
  segments: ReadonlyArray<SlackTextSegment>,
  text: string
): ReadonlyArray<SlackTextSegment> =>
  text === ""
    ? segments
    : [...segments, { kind: "text", text: renderSlackEmojiAliases(decodeSlackEntities(text)) }]

const parseAngleToken = (token: string, mentionLabels: SlackMentionLabels): SlackTextSegment => {
  const separatorIndex = token.indexOf("|")
  const rawTarget = separatorIndex === -1 ? token : token.slice(0, separatorIndex)
  const rawLabel = separatorIndex === -1 ? null : token.slice(separatorIndex + 1)
  const target = decodeSlackEntities(rawTarget)
  const label = rawLabel === null ? null : renderSlackEmojiAliases(decodeSlackEntities(rawLabel))
  const userMatch = slackUserMentionIdPattern.exec(target)
  const subteamMatch = slackSubteamMentionIdPattern.exec(target)

  if (target.startsWith("http://") || target.startsWith("https://")) {
    return {
      kind: "link",
      label: label ?? target,
      url: target
    }
  }

  if (target.startsWith("#")) {
    return {
      kind: "text",
      text: label === null ? "#channel" : `#${label}`
    }
  }

  if (userMatch !== null) {
    return {
      kind: "text",
      text: displayMentionLabel(label ?? mentionLabels.users[userMatch[1]] ?? null, userMatch[1])
    }
  }

  if (subteamMatch !== null) {
    return {
      kind: "text",
      text: displayMentionLabel(label ?? mentionLabels.subteams[subteamMatch[1]] ?? null, subteamMatch[1])
    }
  }

  if (target.startsWith("!")) {
    return {
      kind: "text",
      text: label ?? target.slice(1)
    }
  }

  return {
    kind: "text",
    text: label ?? target
  }
}

export const parseSlackText = (
  value: string,
  mentionLabels: SlackMentionLabels = emptyMentionLabels
): ReadonlyArray<SlackTextSegment> => {
  let segments: ReadonlyArray<SlackTextSegment> = []
  let cursor = 0

  for (const match of value.matchAll(/<([^>\n]+)>/g)) {
    const index = match.index
    const token = match[1]
    if (index === undefined || token === undefined) {
      continue
    }

    segments = appendTextSegment(segments, value.slice(cursor, index))
    segments = [...segments, parseAngleToken(token, mentionLabels)]
    cursor = index + match[0].length
  }

  return appendTextSegment(segments, value.slice(cursor))
}

export const renderSlackPlainText = (
  value: string,
  mentionLabels: SlackMentionLabels = emptyMentionLabels
): string =>
  parseSlackText(value, mentionLabels)
    .map((segment) => segment.kind === "link" ? segment.label : segment.text)
    .join("")
