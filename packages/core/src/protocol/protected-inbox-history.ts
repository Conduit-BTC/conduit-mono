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

/** Process-local only: bind a descending cursor to one signer session/relay. */
export interface ProtectedInboxHistoryCursor {
  sessionScope: string
  relayUrl: string
  until: number
}

export type ProtectedInboxHistoryPageStatus =
  "advanced" | "source_eose" | "partial" | "unavailable" | "capped"

export interface ProtectedInboxHistoryPageResult {
  status: ProtectedInboxHistoryPageStatus
  visitedCount: number
  /** Absent only after this relay's current bounded scan reaches EOSE. */
  nextCursor: ProtectedInboxHistoryCursor | null
}

export interface VisitProtectedInboxHistoryPageOptions {
  principalPubkey: string
  /** Must be one of the principal's current declared owner-selected inboxes. */
  relayUrl: string
  declaredRelayUrls: readonly string[]
  authorization: ProtectedReadAuthorization
  cursor?: ProtectedInboxHistoryCursor
  /** Decrypt/inspect privately; must itself bound each signer operation. */
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
  /** Test clock; never used as a payment or absence authority. */
  now?: () => number
}

function isCleanRelayRead(
  read: ProtectedInboxReadResult,
  limit: number,
  principalPubkey: string,
  since?: number,
  until?: number
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
    relay.eventCount === read.events.length &&
    relay.malformedCount === 0 &&
    relay.unusableCount === 0 &&
    read.events.length <= limit &&
    read.events.every(
      (event) =>
        event.kind === 1_059 &&
        isValidSignedPublicNostrEvent(event) &&
        event.tags.filter((tag) => tag[0] === "p").length === 1 &&
        event.tags.some(
          (tag) => tag[0] === "p" && tag[1] === principalPubkey
        ) &&
        (since === undefined || event.created_at >= since) &&
        (until === undefined || event.created_at <= until)
    )
  )
}

/**
 * Visit at most one bounded, signed kind-1059/#p page from one declared inbox.
 * No cursor advances before every selected wrap has been visited. An inclusive
 * timestamp boundary is checked separately before descending past a full page;
 * an overfull tie fails closed as capped, never silently skips older wraps.
 * An inbox with more than 50 wraps in the same second requires a separate
 * bounded repair path; repeated calls with the same cursor cannot pass it.
 * `source_eose` only describes this relay/read, not global Nostr absence or
 * completeness. In particular, later stitched pages cannot rule out backdated
 * arrivals behind their cursor. Neither events nor decrypted data are cached.
 */
export async function visitProtectedInboxHistoryPage(
  options: VisitProtectedInboxHistoryPageOptions
): Promise<ProtectedInboxHistoryPageResult> {
  const principal = options.principalPubkey.trim().toLowerCase()
  const relayUrl = options.relayUrl
  const assertCurrent = () => {
    assertProtectedReadAuthorization(options.authorization, principal)
    if (options.signal?.aborted) {
      throw new Error("Protected inbox history visit was cancelled.")
    }
  }
  assertCurrent()
  if (!options.declaredRelayUrls.includes(relayUrl)) {
    throw new Error("Protected inbox history relay is not owner-selected.")
  }
  if (
    options.cursor &&
    (options.cursor.sessionScope !== options.authorization.sessionScope ||
      options.cursor.relayUrl !== relayUrl ||
      !Number.isSafeInteger(options.cursor.until) ||
      options.cursor.until < 0)
  ) {
    throw new Error("Protected inbox history cursor is invalid.")
  }

  const unchangedCursor = options.cursor ?? null
  const read = options.read ?? readProtectedInbox
  const readPage = async (
    limit: number,
    since?: number,
    until?: number
  ): Promise<ProtectedInboxReadResult> => {
    assertCurrent()
    const result = await read({
      principalPubkey: principal,
      relayUrls: [relayUrl],
      ownerSelectedRelayUrls: [relayUrl],
      appRelayUrls: [],
      limit,
      authorization: options.authorization,
      accountNetworkLocalStateRepository:
        options.accountNetworkLocalStateRepository,
      signal: options.signal,
      connectTimeoutMs: 4_000,
      queryTimeoutMs: 12_000,
      ...(since === undefined ? {} : { since }),
      ...(until === undefined ? {} : { until }),
    })
    assertCurrent()
    return result
  }

  const until = options.cursor?.until
  const page = await readPage(PAGE_LIMIT, undefined, until)
  if (page.coverage === "unavailable") {
    return {
      status: "unavailable",
      visitedCount: 0,
      nextCursor: unchangedCursor,
    }
  }
  if (!isCleanRelayRead(page, PAGE_LIMIT, principal, undefined, until)) {
    return { status: "partial", visitedCount: 0, nextCursor: unchangedCursor }
  }

  const source = page.relayResult.relays[0]!
  const saturated = source.eventCount >= PAGE_LIMIT
  let selected = page.events
  let nextUntil: number | null = null
  if (saturated) {
    if (selected.length === 0) {
      return { status: "capped", visitedCount: 0, nextCursor: unchangedCursor }
    }
    const boundaryAt = Math.min(...selected.map((event) => event.created_at))
    const boundary = await readPage(BOUNDARY_LIMIT, boundaryAt, boundaryAt)
    if (
      !isCleanRelayRead(
        boundary,
        BOUNDARY_LIMIT,
        principal,
        boundaryAt,
        boundaryAt
      ) ||
      boundary.relayResult.relays[0]!.eventCount >= BOUNDARY_LIMIT
    ) {
      return { status: "capped", visitedCount: 0, nextCursor: unchangedCursor }
    }
    const boundaryIds = new Set(boundary.events.map((event) => event.id))
    if (
      selected.some(
        (event) => event.created_at === boundaryAt && !boundaryIds.has(event.id)
      )
    ) {
      return { status: "capped", visitedCount: 0, nextCursor: unchangedCursor }
    }
    selected = Array.from(
      new Map(
        [...selected, ...boundary.events].map((event) => [event.id, event])
      ).values()
    )
    if (selected.length > PAGE_LIMIT) {
      return { status: "capped", visitedCount: 0, nextCursor: unchangedCursor }
    }
    nextUntil = boundaryAt > 0 ? boundaryAt - 1 : null
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
      return { status: "partial", visitedCount, nextCursor: unchangedCursor }
    }
    await options.visit(event, assertCurrent)
    assertCurrent()
    visitedCount += 1
  }

  if (nextUntil === null) {
    return { status: "source_eose", visitedCount, nextCursor: null }
  }
  return {
    status: "advanced",
    visitedCount,
    nextCursor: {
      sessionScope: options.authorization.sessionScope,
      relayUrl,
      until: nextUntil,
    },
  }
}
