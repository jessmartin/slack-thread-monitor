const slackInternalIdPattern = /^[BUW][A-Z0-9]{8,}$/

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

const appendTextSegment = (
  segments: ReadonlyArray<SlackTextSegment>,
  text: string
): ReadonlyArray<SlackTextSegment> =>
  text === ""
    ? segments
    : [...segments, { kind: "text", text: decodeSlackEntities(text) }]

const parseAngleToken = (token: string): SlackTextSegment => {
  const separatorIndex = token.indexOf("|")
  const rawTarget = separatorIndex === -1 ? token : token.slice(0, separatorIndex)
  const rawLabel = separatorIndex === -1 ? null : token.slice(separatorIndex + 1)
  const target = decodeSlackEntities(rawTarget)
  const label = rawLabel === null ? null : decodeSlackEntities(rawLabel)

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

  if (target.startsWith("@")) {
    return {
      kind: "text",
      text: label ?? "Slack user"
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

export const parseSlackText = (value: string): ReadonlyArray<SlackTextSegment> => {
  let segments: ReadonlyArray<SlackTextSegment> = []
  let cursor = 0

  for (const match of value.matchAll(/<([^>\n]+)>/g)) {
    const index = match.index
    const token = match[1]
    if (index === undefined || token === undefined) {
      continue
    }

    segments = appendTextSegment(segments, value.slice(cursor, index))
    segments = [...segments, parseAngleToken(token)]
    cursor = index + match[0].length
  }

  return appendTextSegment(segments, value.slice(cursor))
}

export const renderSlackPlainText = (value: string): string =>
  parseSlackText(value)
    .map((segment) => segment.kind === "link" ? segment.label : segment.text)
    .join("")
