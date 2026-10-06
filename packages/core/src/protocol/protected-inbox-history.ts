import type { AccountNetworkLocalStateRepository } from "./account-network-local-state"
import type { SignedNostrEvent } from "./nostr-event-signer"
import {
  readProtectedInbox,
  type ProtectedInboxReadResult,
  type ReadProtectedInboxOptions,
} from "./protected-inbox-read"
import {
  assertProtectedReadAuthorization,
  type ProtectedReadAuthorization,
} from "./protected-read-authorization"
import { isValidSignedPublicNostrEvent } from "./signed-event"

const PAGE_LIMIT = 50
const BOUNDARY_LIMIT = 512
const VISIT_BUDGET_MS = 15_000

/** Persist only relayUrl/until; a session scope is bound again on resume. */
export interface StoredProtectedInboxHistoryCursor {
  relayUrl: string
  until: number
}

export interface ProtectedInboxHistoryCursor extends StoredProtectedInboxHistoryCursor {
  sessionScope: string
}

export type ProtectedInboxHistoryPageStatus =
  "advanced" | "source_eose" | "partial" | "unavailable" | "capped"

export interface ProtectedInboxHistoryRangeEvidence {
  relayUrl: string
  /** Inclusive NIP-01 range. Null means no bound was requested. */
  since: number | null
  until: number | null
  /** Only the named relay's bounded subscription reached EOSE. */
  eose: boolean
  saturated: boolean
  observedCount: number
}

export interface ProtectedInboxHistoryPageResult {
  status: ProtectedInboxHistoryPageStatus
  visitedCount: number
  /** Cursor advances only after every selected wrapper has been visited. */
  nextCursor: ProtectedInboxHistoryCursor | null
  range: ProtectedInboxHistoryRangeEvidence
}

export interface VisitProtectedInboxHistoryPageOptions {
  principalPubkey: string
  transport?: ReadProtectedInboxOptions["transport"]
  relayUrl: string
  /** Current authorized read plan, including permitted recovery relays. */
  authorizedRelayUrls?: readonly string[]
  /** Owner-selected inbox subset; also the dedicated-consumer history API. */
  declaredRelayUrls?: readonly string[]
  appRelayUrls?: readonly string[]
  personalRelayUrls?: readonly string[]
  independentRelayUrls?: readonly string[]
  authorization: ProtectedReadAuthorization
  cursor?: ProtectedInboxHistoryCursor
  /** This callback owns idempotent ingestion, decryption, and backpressure. */
  visit(event: SignedNostrEvent, assertCurrent: () => void): Promise<void>
  accountNetworkLocalStateRepository?: Pick<
    AccountNetworkLocalStateRepository,
    "get"
  >
  signal?: AbortSignal
  /** Test seam; production uses the authenticated protected inbox reader. */
  read?: (
    options: ReadProtectedInboxOptions
  ) => Promise<ProtectedInboxReadResult>
  now?: () => number
}

export function bindProtectedInboxHistoryCursor(
  stored: StoredProtectedInboxHistoryCursor,
  authorization: ProtectedReadAuthorization
): ProtectedInboxHistoryCursor {
  assertProtectedReadAuthorization(authorization, authorization.expectedPubkey)
  if (!Number.isSafeInteger(stored.until) || stored.until < 0) {
    throw new Error("Protected inbox history cursor is invalid.")
  }
  return {
    relayUrl: stored.relayUrl,
    until: stored.until,
    sessionScope: authorization.sessionScope,
  }
}

function isValidHistoryEvent(
  event: SignedNostrEvent,
  principal: string,
  transport: ReadProtectedInboxOptions["transport"],
  since?: number,
  until?: number
): boolean {
  return (
    event.kind === (transport && transport !== "nip17" ? 4 : 1059) &&
    isValidSignedPublicNostrEvent(event) &&
    event.tags.filter((tag) => tag[0] === "p").length === 1 &&
    (transport === "nip04_outgoing"
      ? event.pubkey === principal
      : event.tags.some((tag) => tag[0] === "p" && tag[1] === principal)) &&
    (since === undefined || event.created_at >= since) &&
    (until === undefined || event.created_at <= until)
  )
}

function isCleanRelayRead(
  read: ProtectedInboxReadResult,
  limit: number,
  principalPubkey: string,
  since?: number,
  until?: number,
  transport?: ReadProtectedInboxOptions["transport"]
): boolean {
  const relay = read.relayResult.relays[0]
  return (
    read.coverage === "complete" &&
    read.relayResult.status === "success" &&
    read.relayResult.attemptedCount === 1 &&
    read.relayResult.completedCount === 1 &&
    read.relayResult.failedCount === 0 &&
    read.relayResult.relays.length === 1 &&
    relay?.status === "success" &&
    read.relayResult.observations.some(
      (observation) =>
        observation.type === "eose" && observation.relayIndex === 0
    ) &&
    relay.eventCount === read.events.length &&
    relay.malformedCount === 0 &&
    relay.unusableCount === 0 &&
    read.events.length <= limit &&
    read.events.every((event) =>
      isValidHistoryEvent(event, principalPubkey, transport, since, until)
    )
  )
}

/**
 * Visit one bounded time window on one authorized recipient inbox. Full pages
 * get a separate inclusive timestamp-boundary read before the cursor descends.
 * A cap, malformed response, interruption, or stalled boundary leaves the
 * cursor unchanged, so no timestamp is silently skipped. The visitor must be
 * idempotent because retry can revisit a partially processed window.
 * `source_eose` is only a relay/range observation, never all-history proof.
 */
export async function visitProtectedInboxHistoryPage(
  options: VisitProtectedInboxHistoryPageOptions
): Promise<ProtectedInboxHistoryPageResult> {
  const principal = options.principalPubkey.trim().toLowerCase()
  const relayUrl = options.relayUrl
  const until = options.cursor?.until
  const range: ProtectedInboxHistoryRangeEvidence = {
    relayUrl,
    since: null,
    until: until ?? null,
    eose: false,
    saturated: false,
    observedCount: 0,
  }
  const assertCurrent = () => {
    assertProtectedReadAuthorization(options.authorization, principal)
    if (options.signal?.aborted) {
      throw new Error("Protected inbox history visit was cancelled.")
    }
  }
  assertCurrent()
  const allowedRelays =
    options.authorizedRelayUrls ?? options.declaredRelayUrls ?? []
  const declaredRelayUrls = options.declaredRelayUrls ?? []
  if (!allowedRelays.includes(relayUrl)) {
    throw new Error("Protected inbox history relay is not authorized.")
  }
  if (
    options.cursor &&
    (options.cursor.sessionScope !== options.authorization.sessionScope ||
      options.cursor.relayUrl !== relayUrl ||
      !Number.isSafeInteger(until) ||
      until! < 0)
  ) {
    throw new Error("Protected inbox history cursor is invalid.")
  }

  const unchangedCursor = options.cursor ?? null
  const read = options.read ?? readProtectedInbox
  const readPage = async (
    limit: number,
    since?: number,
    pageUntil?: number
  ): Promise<ProtectedInboxReadResult> => {
    assertCurrent()
    const result = await read({
      principalPubkey: principal,
      transport: options.transport,
      relayUrls: [relayUrl],
      ownerSelectedRelayUrls: declaredRelayUrls,
      appRelayUrls: options.appRelayUrls ?? [],
      personalRelayUrls: options.personalRelayUrls,
      independentRelayUrls: options.independentRelayUrls,
      limit,
      authorization: options.authorization,
      accountNetworkLocalStateRepository:
        options.accountNetworkLocalStateRepository,
      signal: options.signal,
      connectTimeoutMs: 4_000,
      queryTimeoutMs: 12_000,
      ...(since === undefined ? {} : { since }),
      ...(pageUntil === undefined ? {} : { until: pageUntil }),
    })
    assertCurrent()
    return result
  }

  // Incomplete coverage prevents cursor advancement, but authenticated positive
  // observations remain usable. Missing sibling events do not invalidate them.
  const retainIncomplete = async (
    status: ProtectedInboxHistoryPageStatus,
    events: SignedNostrEvent[]
  ): Promise<ProtectedInboxHistoryPageResult> => {
    const now = options.now ?? Date.now
    const deadline = now() + VISIT_BUDGET_MS
    const selected = [
      ...new Map(
        events
          .slice(0, PAGE_LIMIT + BOUNDARY_LIMIT)
          .filter((event) =>
            isValidHistoryEvent(
              event,
              principal,
              options.transport,
              undefined,
              until
            )
          )
          .map((event) => [event.id, event])
      ).values(),
    ]
    let visitedCount = 0
    for (const event of selected) {
      assertCurrent()
      if (now() >= deadline) break
      await options.visit(event, assertCurrent)
      assertCurrent()
      visitedCount++
    }
    range.observedCount = selected.length
    return { status, visitedCount, nextCursor: unchangedCursor, range }
  }

  const page = await readPage(PAGE_LIMIT, undefined, until)
  if (page.coverage === "unavailable") {
    return retainIncomplete("unavailable", page.events)
  }
  if (
    !isCleanRelayRead(
      page,
      PAGE_LIMIT,
      principal,
      undefined,
      until,
      options.transport
    )
  ) {
    return retainIncomplete("partial", page.events)
  }

  range.eose = true
  range.observedCount = page.events.length
  range.saturated = page.relayResult.relays[0]!.eventCount >= PAGE_LIMIT
  let selected = page.events
  let nextUntil: number | null = null
  if (range.saturated) {
    const boundaryAt = Math.min(...selected.map((event) => event.created_at))
    const boundary = await readPage(BOUNDARY_LIMIT, boundaryAt, boundaryAt)
    if (boundary.coverage === "unavailable") {
      return retainIncomplete("unavailable", [...selected, ...boundary.events])
    }
    if (
      !isCleanRelayRead(
        boundary,
        BOUNDARY_LIMIT,
        principal,
        boundaryAt,
        boundaryAt,
        options.transport
      )
    ) {
      return retainIncomplete("partial", [...selected, ...boundary.events])
    }
    if (boundary.relayResult.relays[0]!.eventCount >= BOUNDARY_LIMIT) {
      return retainIncomplete("capped", [...selected, ...boundary.events])
    }
    const boundaryIds = new Set(boundary.events.map((event) => event.id))
    if (
      selected.some(
        (event) => event.created_at === boundaryAt && !boundaryIds.has(event.id)
      )
    ) {
      return retainIncomplete("capped", [...selected, ...boundary.events])
    }
    selected = Array.from(
      new Map(
        [...selected, ...boundary.events].map((event) => [event.id, event])
      ).values()
    )
    range.observedCount = selected.length
    nextUntil = boundaryAt > 0 ? boundaryAt - 1 : null
    if (nextUntil !== null && until !== undefined && nextUntil >= until) {
      return retainIncomplete("capped", [...selected, ...boundary.events])
    }
  }
  selected.sort(
    (left, right) =>
      right.created_at - left.created_at || left.id.localeCompare(right.id)
  )

  const now = options.now ?? Date.now
  const deadline = now() + VISIT_BUDGET_MS
  let visitedCount = 0
  for (const event of selected) {
    assertCurrent()
    if (now() >= deadline) {
      return {
        status: "partial",
        visitedCount,
        nextCursor: unchangedCursor,
        range,
      }
    }
    await options.visit(event, assertCurrent)
    assertCurrent()
    visitedCount += 1
  }

  if (nextUntil === null) {
    return { status: "source_eose", visitedCount, nextCursor: null, range }
  }
  return {
    status: "advanced",
    visitedCount,
    nextCursor: {
      sessionScope: options.authorization.sessionScope,
      relayUrl,
      until: nextUntil,
    },
    range,
  }
}
