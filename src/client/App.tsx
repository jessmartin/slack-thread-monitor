import { Archive, CheckCircle2, Clock3, ExternalLink, Inbox, Settings as SettingsIcon } from "lucide-react"
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { buildSlackNativeMessageUrl, parseSlackText, readableSlackActorLabel, renderSlackPlainText } from "../shared/slack"
import { cardStatuses, statusLabels, type AppMetaResponse, type BackfillResponse, type CardStatus, type CardsResponse, type SettingsResponse, type SlackWorkspace, type ThreadCard, type TrackedSlackUser } from "../shared/types"

const statusIcon = (status: CardStatus) => {
  if (status === "awaiting_reply") {
    return <Clock3 size={17} />
  }
  if (status === "resolved") {
    return <CheckCircle2 size={17} />
  }
  return <Inbox size={17} />
}

const loadCards = async (): Promise<ReadonlyArray<ThreadCard>> => {
  const response = await fetch("/api/cards")
  if (!response.ok) {
    throw new Error("Failed to load cards")
  }
  const body: CardsResponse = await response.json()
  return body.cards
}

const loadMeta = async (): Promise<AppMetaResponse> => {
  const response = await fetch("/api/meta")
  if (!response.ok) {
    throw new Error("Failed to load app metadata")
  }
  return await response.json()
}

const loadSettings = async (): Promise<SettingsResponse> => {
  const response = await fetch("/api/settings")
  if (!response.ok) {
    throw new Error("Failed to load settings")
  }
  return await response.json()
}

const runBackfill = async (days: number): Promise<BackfillResponse> => {
  const response = await fetch("/api/backfill", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ days })
  })
  if (!response.ok) {
    throw new Error("Backfill failed")
  }
  return await response.json()
}

const clearDatabase = async (): Promise<void> => {
  const response = await fetch("/api/admin/clear-db", {
    method: "POST"
  })
  if (!response.ok) {
    throw new Error("Failed to clear database")
  }
}

const updateStatus = async (threadKey: string, status: CardStatus): Promise<void> => {
  const response = await fetch(`/api/cards/${encodeURIComponent(threadKey)}/status`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ status })
  })
  if (!response.ok) {
    throw new Error("Failed to update status")
  }
}

const slackTimestampDate = (value: string | null): Date | null => {
  if (value === null) {
    return null
  }
  const date = new Date(Number(value.split(".")[0]) * 1000)
  return Number.isNaN(date.getTime()) ? null : date
}

const formatAbsoluteTimestamp = (value: string | null): string => {
  const date = slackTimestampDate(value)
  if (date === null) {
    return value ?? ""
  }

  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date)
}

const formatTimeAgo = (value: string | null): string => {
  const date = slackTimestampDate(value)
  if (date === null) {
    return ""
  }

  const elapsedMs = Math.max(0, Date.now() - date.getTime())
  const minutes = Math.max(1, Math.floor(elapsedMs / 60_000))
  if (minutes < 60) {
    return `${minutes}m ago`
  }

  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h ago`
  }

  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

const channelLabel = (card: ThreadCard): string =>
  card.channelName === null ? card.channelId : `#${card.channelName}`

const actorLabel = (
  name: string | null,
  id: string | null,
  fallback: string
): string =>
  readableSlackActorLabel(name) ??
  readableSlackActorLabel(id) ??
  fallback

const rootAuthorLabel = (card: ThreadCard): string =>
  actorLabel(
    card.rootMessageUserName ?? card.lastMessageUserName,
    card.rootMessageUserId ?? card.lastMessageUserId,
    "Unknown sender"
  )

const latestAuthorLabel = (card: ThreadCard): string =>
  actorLabel(card.lastMessageUserName, card.lastMessageUserId, "Unknown sender")

const rootAuthorImageUrl = (card: ThreadCard): string | null =>
  card.rootMessageUserImageUrl ?? card.lastMessageUserImageUrl

const rootMessageText = (card: ThreadCard): string | null =>
  card.rootMessageText ?? card.lastMessageText

const previewTitle = (text: string, maxLines: number, maxChars: number): string => {
  const normalized = renderSlackPlainText(text)
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim()
  const preview = normalized.split("\n").slice(0, maxLines).join("\n")
  return preview.length > maxChars ? `${preview.slice(0, maxChars - 1)}...` : preview
}

const fallbackMessageText = "Original message unavailable"

const initialsFor = (value: string): string => {
  const parts = value.trim().split(/\s+/).filter((part) => part.length > 0)
  const first = parts[0]?.[0] ?? "?"
  const second = parts.length > 1 ? parts[1]?.[0] : undefined
  return `${first}${second ?? ""}`.toUpperCase()
}

const renderSlackInlineText = (text: string, keyPrefix: string): ReadonlyArray<ReactNode> => {
  let nodes: ReadonlyArray<ReactNode> = []
  let cursor = 0
  let tokenIndex = 0

  for (const match of text.matchAll(/(`[^`\n]+`|\*[^*\n]+\*|~[^~\n]+~)/g)) {
    const index = match.index
    const token = match[0]
    if (index === undefined) {
      continue
    }

    if (index > cursor) {
      nodes = [...nodes, text.slice(cursor, index)]
    }

    const key = `${keyPrefix}-${tokenIndex}`
    const content = token.slice(1, -1)
    if (token.startsWith("`")) {
      nodes = [...nodes, <code key={key}>{content}</code>]
    } else if (token.startsWith("*")) {
      nodes = [...nodes, <strong key={key}>{content}</strong>]
    } else if (token.startsWith("~")) {
      nodes = [...nodes, <s key={key}>{content}</s>]
    } else {
      nodes = [...nodes, token]
    }

    cursor = index + token.length
    tokenIndex += 1
  }

  return cursor >= text.length ? nodes : [...nodes, text.slice(cursor)]
}

const renderSlackPreview = (text: string): ReadonlyArray<ReactNode> => {
  let nodes: ReadonlyArray<ReactNode> = []
  let index = 0

  for (const segment of parseSlackText(text)) {
    const key = `slack-segment-${index}`
    if (segment.kind === "text") {
      nodes = [...nodes, ...renderSlackInlineText(segment.text, key)]
    } else {
      nodes = [
        ...nodes,
        <a className="excerpt-link" href={segment.url} key={key} rel="noreferrer" target="_blank">
          {renderSlackInlineText(segment.label, `${key}-label`)}
        </a>
      ]
    }
    index += 1
  }

  return nodes
}

const isBrowserUrl = (url: string): boolean =>
  url.startsWith("http://") || url.startsWith("https://")

const slackThreadUrl = (card: ThreadCard): string | null =>
  buildSlackNativeMessageUrl(card.teamId, card.channelId, card.rootThreadTs) ?? card.slackPermalink

interface ActorAvatarProps {
  readonly imageUrl: string | null
  readonly label: string
}

function ActorAvatar({ imageUrl, label }: ActorAvatarProps) {
  if (imageUrl === null) {
    return (
      <span className="card-avatar-fallback" title={label}>
        {initialsFor(label)}
      </span>
    )
  }

  return <img alt="" className="card-avatar" src={imageUrl} title={label} />
}

interface CardProps {
  readonly card: ThreadCard
  readonly onMove: (threadKey: string, status: CardStatus) => Promise<void>
  readonly onDragStart: (threadKey: string) => void
}

function ThreadCardView({ card, onMove, onDragStart }: CardProps) {
  const slackUrl = slackThreadUrl(card)
  const rootAuthor = rootAuthorLabel(card)
  const latestAuthor = latestAuthorLabel(card)
  const originalText = rootMessageText(card)

  return (
    <article
      className="thread-card"
      draggable
      onDragStart={() => onDragStart(card.threadKey)}
    >
      <div className="root-message-row">
        <ActorAvatar imageUrl={rootAuthorImageUrl(card)} label={rootAuthor} />
        <div className="root-message-meta">
          <div
            className="root-message-text"
            title={originalText === null ? fallbackMessageText : previewTitle(originalText, 8, 900)}
          >
            {originalText === null ? fallbackMessageText : renderSlackPreview(originalText)}
          </div>
          <div className="root-message-details">
            <span className="root-author-name">{rootAuthor}</span>
            <span className="root-detail-separator">·</span>
            <span className="root-channel">{channelLabel(card)}</span>
          </div>
        </div>
      </div>

      {card.lastMessageText !== null && (
        <div className="latest-comment">
          <p className="latest-comment-text">{renderSlackPreview(card.lastMessageText)}</p>
          <div className="latest-comment-meta">
            <ActorAvatar imageUrl={card.lastMessageUserImageUrl} label={latestAuthor} />
            <span className="latest-comment-sender">{latestAuthor}</span>
            <span className="timestamp" title={formatAbsoluteTimestamp(card.lastMessageAt)}>
              {formatTimeAgo(card.lastMessageAt)}
            </span>
          </div>
        </div>
      )}

      <div className="links-row">
        {card.references.map((reference) => (
          <a
            className={`pill ${reference.provider}-pill`}
            href={reference.url}
            key={`${reference.provider}:${reference.url}`}
            target="_blank"
            rel="noreferrer"
            title={reference.title ?? reference.displayKey}
          >
            {reference.displayKey}
            {reference.state !== null && <span className="state"> {reference.state}</span>}
            <ExternalLink size={13} />
          </a>
        ))}
      </div>

      <div className="card-actions">
        <div className="status-actions">
          {card.status !== "awaiting_reply" && (
            <button type="button" className="icon-button" onClick={() => onMove(card.threadKey, "awaiting_reply")}>
              <Clock3 size={15} />
              Awaiting
            </button>
          )}
          {card.status !== "resolved" && (
            <button type="button" className="icon-button" onClick={() => onMove(card.threadKey, "resolved")}>
              <CheckCircle2 size={15} />
              Resolved
            </button>
          )}
          {card.status === "resolved" && (
            <button type="button" className="icon-button" onClick={() => onMove(card.threadKey, "archived")}>
              <Archive size={15} />
              Archive
            </button>
          )}
        </div>
        {slackUrl !== null && (
          <a
            aria-label="Open Slack thread"
            className="slack-card-link slack-thread-action"
            href={slackUrl}
            rel={isBrowserUrl(slackUrl) ? "noreferrer" : undefined}
            target={isBrowserUrl(slackUrl) ? "_blank" : undefined}
            title="Open Slack thread"
          >
            <ExternalLink size={16} />
          </a>
        )}
      </div>
    </article>
  )
}

interface ColumnProps {
  readonly status: CardStatus
  readonly cards: ReadonlyArray<ThreadCard>
  readonly draggedThreadKey: string | null
  readonly onDropCard: (status: CardStatus) => Promise<void>
  readonly onMove: (threadKey: string, status: CardStatus) => Promise<void>
  readonly onArchiveAll: () => Promise<void>
  readonly onDragStart: (threadKey: string) => void
}

function Column({ status, cards, draggedThreadKey, onArchiveAll, onDropCard, onMove, onDragStart }: ColumnProps) {
  return (
    <section
      className={`board-column column-${status}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={() => {
        if (draggedThreadKey !== null) {
          void onDropCard(status)
        }
      }}
    >
      <header className="column-header">
        <div className="column-title">
          {statusIcon(status)}
          <h2>{statusLabels[status]}</h2>
        </div>
        <div className="column-header-actions">
          {status === "resolved" && (
            <button
              aria-hidden={cards.length === 0}
              className={`archive-all-button${cards.length === 0 ? " archive-all-button-hidden" : ""}`}
              disabled={cards.length === 0}
              onClick={() => void onArchiveAll()}
              tabIndex={cards.length === 0 ? -1 : undefined}
              type="button"
            >
              <Archive size={14} />
              Archive all
            </button>
          )}
          <span className="count">{cards.length}</span>
        </div>
      </header>
      <div className="card-list">
        {cards.map((card) => (
          <ThreadCardView
            card={card}
            key={card.threadKey}
            onDragStart={onDragStart}
            onMove={onMove}
          />
        ))}
      </div>
    </section>
  )
}

interface UserChipProps {
  readonly user: TrackedSlackUser | null
  readonly large?: boolean
}

function UserChip({ large = false, user }: UserChipProps) {
  if (user === null) {
    return null
  }

  const label = user?.name ?? user?.id ?? "Unknown user"
  return (
    <div className={large ? "user-chip user-chip-large" : "user-chip"} title={label}>
      {user.imageUrl === null ? (
        <span className="user-avatar-fallback">{initialsFor(label)}</span>
      ) : (
        <img alt="" className="user-avatar" src={user.imageUrl} />
      )}
      <div className="user-chip-text">
        <strong>{label}</strong>
      </div>
    </div>
  )
}

interface SettingsViewProps {
  readonly onBlockingOperationChange: (message: string | null) => void
  readonly onTrackedUserChanged: (user: TrackedSlackUser) => void
}

function SettingsView({ onBlockingOperationChange, onTrackedUserChanged }: SettingsViewProps) {
  const [trackedUser, setTrackedUser] = useState<TrackedSlackUser | null>(null)
  const [workspace, setWorkspace] = useState<SlackWorkspace | null>(null)
  const [days, setDays] = useState("14")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadSettings()
      .then((settings) => {
        setTrackedUser(settings.trackedUser)
        setWorkspace(settings.workspace)
        onTrackedUserChanged(settings.trackedUser)
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Failed to load settings"))
  }, [onTrackedUserChanged])

  const backfill = async () => {
    const parsedDays = Number.parseFloat(days)
    setBusy(true)
    onBlockingOperationChange("Backfill running...")
    try {
      const result = await runBackfill(parsedDays)
      setMessage(`Backfill complete: ${result.threadsCreated} new threads, ${result.threadsScanned} scanned.`)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Backfill failed")
    } finally {
      setBusy(false)
      onBlockingOperationChange(null)
    }
  }

  const clear = async () => {
    if (!window.confirm("Clear the local Slack Thread Monitor database?")) {
      return
    }
    setBusy(true)
    try {
      await clearDatabase()
      setMessage("Database cleared.")
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to clear database")
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="settings-panel">
      {error !== null && <div className="error-banner">{error}</div>}
      {message !== null && <div className="success-banner">{message}</div>}

      <div className="settings-group">
        <div className="settings-label">Slack workspace</div>
        <div className="settings-readonly-value">
          {workspace?.url === null || workspace?.url === undefined ? (
            <span>{workspace?.name ?? "Unknown workspace"}</span>
          ) : (
            <a href={workspace.url} target="_blank" rel="noreferrer">
              {workspace.name ?? workspace.url}
            </a>
          )}
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-label">Tracked Slack user</div>
        <div className="settings-readonly-value">
          {trackedUser === null ? (
            <span>Unknown user</span>
          ) : (
            <div className="settings-user-value">
              <UserChip user={trackedUser} />
              <span>{trackedUser.id}</span>
            </div>
          )}
        </div>
        <p className="settings-note">
          The board follows the Slack user who authorized SLACK_USER_TOKEN.
        </p>
      </div>

      <div className="settings-group">
        <label htmlFor="backfill-days">Backfill days</label>
        <div className="settings-row">
          <input
            id="backfill-days"
            min="0.1"
            onChange={(event) => setDays(event.target.value)}
            step="1"
            type="number"
            value={days}
          />
          <button disabled={busy} onClick={() => void backfill()} type="button">
            Backfill
          </button>
        </div>
      </div>

      <div className="settings-group">
        <button className="danger-button" disabled={busy} onClick={() => void clear()} type="button">
          Clear DB
        </button>
      </div>
    </section>
  )
}

export function App() {
  const [cards, setCards] = useState<ReadonlyArray<ThreadCard>>([])
  const [error, setError] = useState<string | null>(null)
  const [draggedThreadKey, setDraggedThreadKey] = useState<string | null>(null)
  const [trackedUser, setTrackedUser] = useState<TrackedSlackUser | null>(null)
  const [path, setPath] = useState(window.location.pathname)
  const [blockingOperation, setBlockingOperation] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const nextCards = await loadCards()
      setCards(nextCards)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load cards")
    }
  }, [])

  useEffect(() => {
    void refresh()
    const interval = window.setInterval(() => {
      void refresh()
    }, 2000)
    return () => window.clearInterval(interval)
  }, [refresh])

  useEffect(() => {
    loadMeta()
      .then((meta) => setTrackedUser(meta.trackedUser))
      .catch(() => setTrackedUser(null))
  }, [])

  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname)
    window.addEventListener("popstate", onPopState)
    return () => window.removeEventListener("popstate", onPopState)
  }, [])

  const grouped = useMemo(
    () =>
      cardStatuses.map((status) => ({
        status,
        cards: cards.filter((card) => card.status === status)
      })),
    [cards]
  )

  const moveCard = useCallback(async (threadKey: string, status: CardStatus) => {
    await updateStatus(threadKey, status)
    await refresh()
  }, [refresh])

  const archiveResolved = useCallback(async () => {
    const resolvedCards = cards.filter((card) => card.status === "resolved")
    await Promise.all(resolvedCards.map((card) => updateStatus(card.threadKey, "archived")))
    await refresh()
  }, [cards, refresh])

  const dropCard = useCallback(async (status: CardStatus) => {
    if (draggedThreadKey === null) {
      return
    }
    await moveCard(draggedThreadKey, status)
    setDraggedThreadKey(null)
  }, [draggedThreadKey, moveCard])

  const navigate = useCallback((nextPath: string) => {
    if (blockingOperation !== null) {
      return
    }
    window.history.pushState(null, "", nextPath)
    setPath(nextPath)
  }, [blockingOperation])

  const isSettings = path === "/settings"

  return (
    <main className="app-shell" aria-busy={blockingOperation !== null}>
      <header className="app-header">
        <div className="header-title">
          {isSettings ? <h1>Settings</h1> : <UserChip large user={trackedUser} />}
        </div>
        <div className="header-actions">
          {isSettings ? (
            <a
              className="refresh-button"
              href="/"
              onClick={(event) => {
                event.preventDefault()
                navigate("/")
              }}
            >
              Board
            </a>
          ) : (
            <a
              aria-label="Settings"
              className="settings-icon-button"
              href="/settings"
              onClick={(event) => {
                event.preventDefault()
                navigate("/settings")
              }}
            >
              <SettingsIcon size={17} />
            </a>
          )}
        </div>
      </header>

      {blockingOperation !== null && (
        <div className="app-lock-overlay" role="status" aria-live="polite">
          <div className="app-lock-panel">
            <span className="app-lock-spinner" aria-hidden="true" />
            <strong>{blockingOperation}</strong>
            <span>The board will unlock when it finishes.</span>
          </div>
        </div>
      )}

      {isSettings ? (
        <SettingsView onBlockingOperationChange={setBlockingOperation} onTrackedUserChanged={setTrackedUser} />
      ) : (
        <>
          {error !== null && <div className="error-banner">{error}</div>}
          <div className="board">
            {grouped.map((column) => (
              <Column
                cards={column.cards}
                draggedThreadKey={draggedThreadKey}
                key={column.status}
                onArchiveAll={archiveResolved}
                onDragStart={setDraggedThreadKey}
                onDropCard={dropCard}
                onMove={moveCard}
                status={column.status}
              />
            ))}
          </div>
        </>
      )}
    </main>
  )
}
