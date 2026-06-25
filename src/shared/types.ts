export type CardStatus = "new_message" | "awaiting_reply" | "resolved"

export const cardStatuses: ReadonlyArray<CardStatus> = ["new_message", "awaiting_reply", "resolved"]

export const statusLabels: Record<CardStatus, string> = {
  new_message: "New Message",
  awaiting_reply: "Awaiting Reply",
  resolved: "Resolved"
}

export const statusDescriptions: Record<CardStatus, string> = {
  new_message: "Threads with new activity to process.",
  awaiting_reply: "Threads where the next move is with someone else.",
  resolved: "Threads that are done for now."
}

export type ReferenceProvider = "github" | "linear"

export type ReferenceType = "issue" | "pull_request" | "url"

export interface ThreadReference {
  readonly provider: ReferenceProvider
  readonly referenceType: ReferenceType
  readonly displayKey: string
  readonly url: string
  readonly title: string | null
  readonly state: string | null
}

export interface ThreadCard {
  readonly threadKey: string
  readonly teamId: string | null
  readonly channelId: string
  readonly channelName: string | null
  readonly rootThreadTs: string
  readonly status: CardStatus
  readonly firstSeenAt: string
  readonly lastMessageAt: string | null
  readonly lastMessageUserId: string | null
  readonly lastMessageUserName: string | null
  readonly lastMessageText: string | null
  readonly lastMessageExcerpt: string | null
  readonly slackPermalink: string | null
  readonly references: ReadonlyArray<ThreadReference>
  readonly updatedAt: string
}

export interface CardsResponse {
  readonly cards: ReadonlyArray<ThreadCard>
}

export interface TrackedSlackUser {
  readonly id: string
  readonly name: string | null
  readonly imageUrl: string | null
}

export interface SlackWorkspace {
  readonly id: string | null
  readonly name: string | null
  readonly url: string | null
}

export interface AppMetaResponse {
  readonly trackedUser: TrackedSlackUser
}

export interface SettingsResponse {
  readonly slackUserId: string
  readonly slackPublicPollSeconds: number
  readonly trackedUser: TrackedSlackUser
  readonly workspace: SlackWorkspace
}

export interface SettingsUpdateRequest {
  readonly slackUserId?: string
  readonly slackPublicPollSeconds?: number
}

export interface BackfillRequest {
  readonly days: number
}

export interface BackfillResponse {
  readonly ok: true
  readonly channelsScanned: number
  readonly threadsScanned: number
  readonly threadsCreated: number
  readonly messagesIngested: number
}

export interface StatusUpdateRequest {
  readonly status: CardStatus
}
