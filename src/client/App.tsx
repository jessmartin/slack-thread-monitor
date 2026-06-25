import { CheckCircle2, Clock3, ExternalLink, Inbox, Settings as SettingsIcon } from "lucide-react"
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { buildSlackNativeMessageUrl, parseSlackText, readableSlackActorLabel } from "../shared/slack"
import { cardStatuses, statusLabels, type AppMetaResponse, type BackfillResponse, type CardStatus, type CardsResponse, type SettingsResponse, type SettingsUpdateRequest, type SlackWorkspace, type ThreadCard, type TrackedSlackUser } from "../shared/types"

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

const saveSettings = async (settings: SettingsUpdateRequest): Promise<SettingsResponse> => {
  const response = await fetch("/api/settings", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(settings)
  })
  if (!response.ok) {
    throw new Error("Failed to save settings")
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

const formatTimestamp = (value: string | null): string => {
  if (value === null) {
    return ""
  }
  const date = new Date(Number(value.split(".")[0]) * 1000)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date)
}

const channelLabel = (card: ThreadCard): string =>
  card.channelName === null ? card.channelId : `#${card.channelName}`

const authorLabel = (card: ThreadCard): string =>
  readableSlackActorLabel(card.lastMessageUserName) ??
  readableSlackActorLabel(card.lastMessageUserId) ??
  "Unknown sender"

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

interface CardProps {
  readonly card: ThreadCard
  readonly onMove: (threadKey: string, status: CardStatus) => Promise<void>
  readonly onDragStart: (threadKey: string) => void
}

function ThreadCardView({ card, onMove, onDragStart }: CardProps) {
  const slackUrl = slackThreadUrl(card)

  return (
    <article
      className="thread-card"
      draggable
      onDragStart={() => onDragStart(card.threadKey)}
    >
      <div className="card-topline">
        <span className="channel">{channelLabel(card)}</span>
        <span className="timestamp">{formatTimestamp(card.lastMessageAt)}</span>
      </div>

      <div className="sender">{authorLabel(card)}</div>

      {card.lastMessageText !== null && (
        <p className="excerpt">{renderSlackPreview(card.lastMessageText)}</p>
      )}

      <div className="links-row">
        {slackUrl !== null && (
          <a
            className="pill slack-pill"
            href={slackUrl}
            rel={isBrowserUrl(slackUrl) ? "noreferrer" : undefined}
            target={isBrowserUrl(slackUrl) ? "_blank" : undefined}
          >
            Slack <ExternalLink size={13} />
          </a>
        )}
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
  readonly onDragStart: (threadKey: string) => void
}

function Column({ status, cards, draggedThreadKey, onDropCard, onMove, onDragStart }: ColumnProps) {
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
        <span className="count">{cards.length}</span>
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
  readonly onTrackedUserChanged: (user: TrackedSlackUser) => void
}

function SettingsView({ onTrackedUserChanged }: SettingsViewProps) {
  const [slackUserId, setSlackUserId] = useState("")
  const [workspace, setWorkspace] = useState<SlackWorkspace | null>(null)
  const [days, setDays] = useState("14")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadSettings()
      .then((settings) => {
        setSlackUserId(settings.slackUserId)
        setWorkspace(settings.workspace)
        onTrackedUserChanged(settings.trackedUser)
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Failed to load settings"))
  }, [onTrackedUserChanged])

  const saveSlackUser = async () => {
    setBusy(true)
    try {
      const settings = await saveSettings({ slackUserId })
      setSlackUserId(settings.slackUserId)
      setWorkspace(settings.workspace)
      onTrackedUserChanged(settings.trackedUser)
      setMessage("Saved.")
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to save settings")
    } finally {
      setBusy(false)
    }
  }

  const backfill = async () => {
    const parsedDays = Number.parseFloat(days)
    setBusy(true)
    try {
      const result = await runBackfill(parsedDays)
      setMessage(`Backfill complete: ${result.threadsCreated} new threads, ${result.threadsScanned} scanned.`)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Backfill failed")
    } finally {
      setBusy(false)
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
        <label htmlFor="slack-user-id">Slack user ID</label>
        <div className="settings-row">
          <input
            id="slack-user-id"
            onChange={(event) => setSlackUserId(event.target.value)}
            spellCheck={false}
            type="text"
            value={slackUserId}
          />
          <button disabled={busy} onClick={() => void saveSlackUser()} type="button">
            Save
          </button>
        </div>
        <p className="settings-note">
          Changing this switches which Slack user the board watches for new activity. Existing cards stay where they
          are; run Backfill after saving to add recent threads for the new user, or Clear DB to start over.
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

  const dropCard = useCallback(async (status: CardStatus) => {
    if (draggedThreadKey === null) {
      return
    }
    await moveCard(draggedThreadKey, status)
    setDraggedThreadKey(null)
  }, [draggedThreadKey, moveCard])

  const navigate = useCallback((nextPath: string) => {
    window.history.pushState(null, "", nextPath)
    setPath(nextPath)
  }, [])

  const isSettings = path === "/settings"

  return (
    <main className="app-shell">
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

      {isSettings ? (
        <SettingsView onTrackedUserChanged={setTrackedUser} />
      ) : (
        <>
          {error !== null && <div className="error-banner">{error}</div>}
          <div className="board">
            {grouped.map((column) => (
              <Column
                cards={column.cards}
                draggedThreadKey={draggedThreadKey}
                key={column.status}
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
