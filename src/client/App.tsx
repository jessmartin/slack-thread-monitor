import { CheckCircle2, Clock3, ExternalLink, Inbox, RefreshCw } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { cardStatuses, statusDescriptions, statusLabels, type CardStatus, type CardsResponse, type ThreadCard } from "../shared/types"

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
  card.lastMessageUserName ?? card.lastMessageUserId ?? "Unknown sender"

interface CardProps {
  readonly card: ThreadCard
  readonly onMove: (threadKey: string, status: CardStatus) => Promise<void>
  readonly onDragStart: (threadKey: string) => void
}

function ThreadCardView({ card, onMove, onDragStart }: CardProps) {
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

      {card.lastMessageExcerpt !== null && (
        <p className="excerpt">{card.lastMessageExcerpt}</p>
      )}

      <div className="links-row">
        {card.slackPermalink !== null && (
          <a className="pill slack-pill" href={card.slackPermalink} target="_blank" rel="noreferrer">
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
      <p className="column-caption">{statusDescriptions[status]}</p>
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

export function App() {
  const [cards, setCards] = useState<ReadonlyArray<ThreadCard>>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [draggedThreadKey, setDraggedThreadKey] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const nextCards = await loadCards()
      setCards(nextCards)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load cards")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const interval = window.setInterval(() => {
      void refresh()
    }, 2000)
    return () => window.clearInterval(interval)
  }, [refresh])

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

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <h1>Slack Thread Monitor</h1>
          <p>{loading ? "Loading..." : `${cards.length} tracked threads`}</p>
        </div>
        <button type="button" className="refresh-button" onClick={() => void refresh()}>
          <RefreshCw size={16} />
          Refresh
        </button>
      </header>

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
    </main>
  )
}
