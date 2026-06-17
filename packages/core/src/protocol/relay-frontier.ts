import type { RelayNetworkBudgetClass } from "./relay-network-budget"

export type RelayFrontierAdapterKind = "ndk" | "nostrify" | "custom"

export type RelayFrontierPrivacyClass =
  | "public"
  | "workspace_private"
  | "protected_message"
  | "payment"

export type RelayFrontierSourceBucket =
  | "app_backplane"
  | "app_write"
  | "core_public_fallback"
  | "search_index"
  | "commerce_dm_fallback"
  | "dm_inbox_default"
  | "zap_public"
  | "user_nip65"
  | "commerce_priority"
  | "source_hint"
  | "unknown"

export type RelayFrontierOutcomeStatus =
  | "success"
  | "empty"
  | "timeout"
  | "error"
  | "aborted"

export interface NostrPlainEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig?: string
}

export type RelayFrontierPriorityClass = RelayNetworkBudgetClass

export interface RelayFrontierReadFilter {
  ids?: string[]
  authors?: string[]
  kinds?: number[]
  since?: number
  until?: number
  limit?: number
  search?: string
  [tagFilter: `#${string}`]: string[] | undefined
}

export interface RelayFrontierReadRequest {
  id?: string
  priorityClass: RelayFrontierPriorityClass
  privacyClass: RelayFrontierPrivacyClass
  relayUrls: string[]
  sourceBucket?: RelayFrontierSourceBucket
  sourceBucketsByRelayUrl?: Record<string, RelayFrontierSourceBucket>
  filters: RelayFrontierReadFilter[]
  deadlineMs?: number
  signal?: AbortSignal
}

export interface RelayFrontierReadOutcome {
  adapter: RelayFrontierAdapterKind
  relayUrl: string
  sourceBucket: RelayFrontierSourceBucket
  priorityClass: RelayFrontierPriorityClass
  status: RelayFrontierOutcomeStatus
  startedAt: number
  finishedAt: number
  durationMs: number
  eventsReceived: number
  eventsReturned: number
  duplicateEvents: number
  malformedEvents: number
  sourceHintsDiscovered: number
  errorMessage?: string
}

export interface RelayFrontierReadResult<
  TEvent extends NostrPlainEvent = NostrPlainEvent,
> {
  events: TEvent[]
  outcomes: RelayFrontierReadOutcome[]
}

export interface RelayFrontierExecutor<
  TEvent extends NostrPlainEvent = NostrPlainEvent,
> {
  adapter: RelayFrontierAdapterKind
  read(
    input: RelayFrontierReadRequest
  ): Promise<RelayFrontierReadResult<TEvent>>
}

export function classifyRelayFrontierReadStatus(input: {
  aborted?: boolean
  timedOut?: boolean
  errorMessage?: string
  eventsReturned: number
}): RelayFrontierOutcomeStatus {
  if (input.aborted) return "aborted"
  if (input.timedOut) return "timeout"
  if (input.errorMessage) return "error"
  return input.eventsReturned > 0 ? "success" : "empty"
}

export function createRelayFrontierReadOutcome(input: {
  adapter: RelayFrontierAdapterKind
  relayUrl: string
  sourceBucket?: RelayFrontierSourceBucket
  priorityClass: RelayFrontierPriorityClass
  startedAt: number
  finishedAt?: number
  eventsReceived?: number
  eventsReturned?: number
  duplicateEvents?: number
  malformedEvents?: number
  sourceHintsDiscovered?: number
  timedOut?: boolean
  aborted?: boolean
  errorMessage?: string
}): RelayFrontierReadOutcome {
  const finishedAt = input.finishedAt ?? Date.now()
  const eventsReturned = input.eventsReturned ?? input.eventsReceived ?? 0
  return {
    adapter: input.adapter,
    relayUrl: input.relayUrl,
    sourceBucket: input.sourceBucket ?? "unknown",
    priorityClass: input.priorityClass,
    status: classifyRelayFrontierReadStatus({
      aborted: input.aborted,
      timedOut: input.timedOut,
      errorMessage: input.errorMessage,
      eventsReturned,
    }),
    startedAt: input.startedAt,
    finishedAt,
    durationMs: Math.max(0, finishedAt - input.startedAt),
    eventsReceived: input.eventsReceived ?? eventsReturned,
    eventsReturned,
    duplicateEvents: input.duplicateEvents ?? 0,
    malformedEvents: input.malformedEvents ?? 0,
    sourceHintsDiscovered: input.sourceHintsDiscovered ?? 0,
    errorMessage: input.errorMessage,
  }
}
