import type { Filter } from "nostr-tools"
import {
  EventMarketDiscoveryBoundError,
  getOrganizerEventMarketsDetailed,
  getRetainedEventMarketCollectionEvidence,
  parseAddressableCoordinate,
  type EventMarketResolution,
  type OrganizerEventMarketsReadResult,
} from "./event-market"
import {
  extractFollowPubkeys,
  readLatestFollowLists,
  type FollowListCoverageState,
  type FollowListReadOptions,
  type FollowListReadResult,
} from "./follows"
import { EVENT_KINDS } from "./kinds"
import {
  fetchSignedEventsFanoutDetailed,
  type SignedEventRelayReadResult,
  type RelayReadOptions,
} from "./relay-reader"
import { planRelayReads } from "./relay-planner"
import { readDurableAccountRelaySettingsPlanningSnapshot } from "./network-preferences"
import { normalizeOwnerSelectedRelayUrls } from "./relay-settings"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

/**
 * Per-relay page target for perspective-scoped public collection discovery.
 * This is not a Nostr or Open Markets truth limit: saturated pages continue
 * through bounded descending pagination and report partial coverage if the
 * page horizon is exhausted.
 */
export const FOLLOWED_EVENT_MARKET_CANDIDATE_TARGET_LIMIT = 128
const FOLLOWED_EVENT_MARKET_CANDIDATE_READ_LIMIT =
  FOLLOWED_EVENT_MARKET_CANDIDATE_TARGET_LIMIT + 1
const FOLLOWED_EVENT_MARKET_CANDIDATE_BOUNDARY_TARGET_LIMIT = 512
const FOLLOWED_EVENT_MARKET_CANDIDATE_BOUNDARY_READ_LIMIT =
  FOLLOWED_EVENT_MARKET_CANDIDATE_BOUNDARY_TARGET_LIMIT + 1
const FOLLOWED_EVENT_MARKET_CANDIDATE_AUTHOR_CHUNK_SIZE = 64
const FOLLOWED_EVENT_MARKET_CANDIDATE_PAGE_LIMIT = 4
const FOLLOWED_EVENT_MARKET_CANDIDATE_RELAY_LIMIT = 6
const FOLLOWED_EVENT_MARKET_CANDIDATE_READ_CONCURRENCY = 4
const FOLLOWED_EVENT_MARKET_READ_CONCURRENCY = 4
const FOLLOWED_EVENT_MARKET_READ_DEADLINE_MS = 20_000

export type FollowedEventMarketDiscoveryState =
  "complete" | "complete_empty" | "partial" | "unavailable"

export type FollowedEventMarketCandidateScanState =
  "complete" | "partial" | "unavailable"

export type EventMarketPerspectiveSource = "following" | "conduit" | "combined"

export type EventMarketPerspectiveAuthorSource =
  "refreshed" | "seed" | "cached" | "fallback" | "combined" | "none"

export interface EventMarketPerspectiveAuthorResolution {
  authorPubkeys: string[] | undefined
  source: EventMarketPerspectiveAuthorSource
}

function uniquePerspectiveAuthors(
  pubkeys: readonly string[] | undefined,
  perspectivePubkey?: string | null
): string[] {
  return Array.from(
    new Set(pubkeys?.map(normalizePubkey).filter(Boolean) as string[])
  )
    .filter((pubkey) => pubkey !== normalizePubkey(perspectivePubkey))
    .sort()
}

function includePerspectiveAuthor(
  pubkeys: readonly string[],
  perspectivePubkey?: string | null
): string[] {
  const normalizedPerspective = normalizePubkey(perspectivePubkey)
  return Array.from(
    new Set([
      ...pubkeys,
      ...(normalizedPerspective ? [normalizedPerspective] : []),
    ])
  ).sort()
}

/**
 * Resolves the author boundary shared by product and event discovery. The
 * result is an input to candidate-first relay scans; callers must not turn it
 * into one independent event-market traversal per followed organizer.
 */
export function resolveEventMarketPerspectiveAuthorPubkeys(input: {
  usesPerspectiveGraph: boolean
  sourceMode?: EventMarketPerspectiveSource
  perspectivePubkey?: string | null
  refreshedAuthorPubkeys?: readonly string[]
  seedAuthorPubkeys?: readonly string[]
  cachedAuthorPubkeys?: readonly string[]
  fallbackAuthorPubkeys?: readonly string[]
  followLookupSettled?: boolean
}): EventMarketPerspectiveAuthorResolution {
  const refreshed = uniquePerspectiveAuthors(
    input.refreshedAuthorPubkeys,
    input.perspectivePubkey
  )
  const cached = uniquePerspectiveAuthors(
    input.cachedAuthorPubkeys,
    input.perspectivePubkey
  )
  const fallback = uniquePerspectiveAuthors(
    input.fallbackAuthorPubkeys,
    input.perspectivePubkey
  )
  const sourceMode = input.sourceMode ?? "following"
  const hasRefreshedAuthors = input.refreshedAuthorPubkeys !== undefined
  const hasCachedAuthors = input.cachedAuthorPubkeys !== undefined

  if (input.usesPerspectiveGraph && sourceMode === "conduit") {
    const seeded = uniquePerspectiveAuthors(
      input.seedAuthorPubkeys,
      input.perspectivePubkey
    )
    if (seeded.length > 0) return { authorPubkeys: seeded, source: "seed" }
    if (fallback.length > 0) {
      return { authorPubkeys: fallback, source: "fallback" }
    }
    return { authorPubkeys: undefined, source: "none" }
  }

  if (input.usesPerspectiveGraph && sourceMode === "combined") {
    if (hasRefreshedAuthors) {
      if (refreshed.length > 0) {
        return {
          authorPubkeys: includePerspectiveAuthor(
            uniquePerspectiveAuthors(
              [...refreshed, ...fallback],
              input.perspectivePubkey
            ),
            input.perspectivePubkey
          ),
          source: fallback.length > 0 ? "combined" : "refreshed",
        }
      }
    } else {
      const seeded = uniquePerspectiveAuthors(
        input.seedAuthorPubkeys,
        input.perspectivePubkey
      )
      if (seeded.length > 0) {
        return {
          authorPubkeys: includePerspectiveAuthor(
            uniquePerspectiveAuthors(
              [...seeded, ...fallback],
              input.perspectivePubkey
            ),
            input.perspectivePubkey
          ),
          source: fallback.length > 0 ? "combined" : "seed",
        }
      }
      if (hasCachedAuthors && cached.length > 0) {
        return {
          authorPubkeys: includePerspectiveAuthor(
            uniquePerspectiveAuthors(
              [...cached, ...fallback],
              input.perspectivePubkey
            ),
            input.perspectivePubkey
          ),
          source: fallback.length > 0 ? "combined" : "cached",
        }
      }
    }

    if (fallback.length > 0) {
      return {
        authorPubkeys: includePerspectiveAuthor(
          fallback,
          input.perspectivePubkey
        ),
        source: "fallback",
      }
    }
    const normalizedPerspective = normalizePubkey(input.perspectivePubkey)
    if (normalizedPerspective) {
      return { authorPubkeys: [normalizedPerspective], source: "combined" }
    }
  }

  if (hasRefreshedAuthors) {
    return refreshed.length > 0
      ? { authorPubkeys: refreshed, source: "refreshed" }
      : { authorPubkeys: [], source: "none" }
  }
  const seeded = uniquePerspectiveAuthors(
    input.seedAuthorPubkeys,
    input.perspectivePubkey
  )
  if (seeded.length > 0) return { authorPubkeys: seeded, source: "seed" }
  if (hasCachedAuthors) {
    return cached.length > 0
      ? { authorPubkeys: cached, source: "cached" }
      : { authorPubkeys: [], source: "none" }
  }
  if (input.usesPerspectiveGraph && input.followLookupSettled) {
    return { authorPubkeys: [], source: "none" }
  }
  if (!input.usesPerspectiveGraph) {
    return { authorPubkeys: undefined, source: "none" }
  }
  return { authorPubkeys: undefined, source: "none" }
}

export interface EventMarketPerspectiveSnapshot {
  source: EventMarketPerspectiveSource
  authorCount: number
  coverage: FollowListCoverageState
  eventObserved: boolean
  snapshotState: "none" | "network" | "observed" | "pending" | "curated"
  truncated: boolean
}

export interface EventMarketCandidateReadCoverage {
  plannedRelayUrls: string[]
  authorChunkCount: number
  plannedReadCount: number
  reads: EventMarketCandidateAuthorChunkCoverage[]
  completeReadCount: number
  partialReadCount: number
  failedReadCount: number
  mainPageCount: number
  boundaryPageCount: number
  saturatedPageCount: number
  pageBudgetExhaustedReadCount: number
  verificationTruncatedReadCount: number
}

export interface EventMarketCandidatePageCoverage {
  pageIndex: number
  until?: number
  mainRelayStatus: "success" | "partial" | "failed"
  mainCompletedAtEose: boolean
  mainEventCount: number
  mainRejectedEventCount: number
  saturated: boolean
  boundaryCreatedAt?: number
  boundaryRelayStatus?: "success" | "partial" | "failed"
  boundaryCompletedAtEose?: boolean
  boundaryEventCount?: number
  boundaryRejectedEventCount?: number
  boundarySaturated?: boolean
}

export interface EventMarketCandidateAuthorChunkCoverage {
  relayUrl: string
  authorChunkIndex: number
  authorCount: number
  state: "complete" | "partial" | "failed"
  pages: EventMarketCandidatePageCoverage[]
  pageBudgetExhausted: boolean
  verificationTruncated: boolean
}

export interface PerspectiveEventMarketDiscoveryResult {
  markets: EventMarketResolution[]
  state: FollowedEventMarketDiscoveryState
  perspective: EventMarketPerspectiveSnapshot
  candidateCollectionCount: number
  candidateScanState: FollowedEventMarketCandidateScanState
  candidateScanCoverage: EventMarketCandidateReadCoverage
  searchedOrganizerCount: number
  /** Attempted organizer reads that did not finish with complete coverage. */
  incompleteOrganizerCount: number
  failedOrganizerCount: number
  boundedOrganizerCount: number
  truncated: boolean
}

export interface FollowedEventMarketDiscoveryResult extends PerspectiveEventMarketDiscoveryResult {
  followListCoverage: FollowListCoverageState
  followedOrganizerCount: number
  followListEventObserved: boolean
  followListSnapshotState: "none" | "network" | "observed" | "pending"
}

export interface DiscoverFollowedEventMarketsInput {
  merchantPubkey: string
  authenticatedPubkey?: string | null
  accountNetworkLocalStateRepository?: FollowListReadOptions["accountNetworkLocalStateRepository"]
  nowMs?: number
  signal?: AbortSignal
  shouldContinue?: FollowListReadOptions["shouldContinue"]
}

type DiscoveryReadAuthority = Pick<
  RelayReadOptions,
  | "authenticatedPubkey"
  | "accountNetworkLocalStateRepository"
  | "shouldContinue"
>

export interface DiscoverPerspectiveEventMarketsInput extends DiscoveryReadAuthority {
  organizerPubkeys: readonly string[]
  perspective: Omit<EventMarketPerspectiveSnapshot, "authorCount">
  /** Include valid ended markets for timeline/history views. */
  includeEnded?: boolean
  authenticatedPubkey?: string | null
  nowMs?: number
  signal?: AbortSignal
}

interface FollowedEventMarketDiscoveryTestOverrides {
  readAccountRelaySettingsPlanningSnapshot?: typeof readDurableAccountRelaySettingsPlanningSnapshot
  readFollowLists?: typeof readLatestFollowLists
  readCollectionCandidates?: typeof readEventMarketCollectionCandidates
  fetchCollectionCandidateEvents?: typeof fetchSignedEventsFanoutDetailed
  collectionCandidateRelayUrls?: readonly string[]
  readRetainedCollectionCandidates?: typeof getRetainedEventMarketCollectionEvidence
  readOrganizerMarkets?: typeof getOrganizerEventMarketsDetailed
  organizerReadDeadlineMs?: number
}

let testOverrides: FollowedEventMarketDiscoveryTestOverrides = {}

export function __setFollowedEventMarketDiscoveryTestOverrides(
  overrides: FollowedEventMarketDiscoveryTestOverrides
): void {
  testOverrides = { ...testOverrides, ...overrides }
}

export function __resetFollowedEventMarketDiscoveryTestOverrides(): void {
  testOverrides = {}
}

function normalizePubkey(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase()
  return normalized && /^[0-9a-f]{64}$/.test(normalized) ? normalized : null
}

function throwIfAborted(
  signal?: AbortSignal,
  shouldContinue?: () => boolean
): void {
  if (!signal?.aborted && shouldContinue?.() !== false) return
  const error = new Error("The operation was aborted.")
  error.name = "AbortError"
  throw error
}

function marketStartMs(market: EventMarketResolution): number {
  return market.calendar?.start ?? Number.MAX_SAFE_INTEGER
}

function sortCurrentMarkets(
  markets: Iterable<EventMarketResolution>
): EventMarketResolution[] {
  return Array.from(markets).sort((left, right) => {
    const startDelta = marketStartMs(left) - marketStartMs(right)
    if (startDelta !== 0) return startDelta
    return left.reference.localeCompare(right.reference)
  })
}

interface EventMarketCollectionCandidateReadResult extends SignedEventRelayReadResult {
  plannedRelayCount: number
  capped: boolean
  coverage: EventMarketCandidateReadCoverage
}

interface EventMarketCollectionCandidate {
  coordinate: string
  organizerPubkey: string
  event: SignedPublicNostrEvent
  relayHints: string[]
}

interface EventMarketOrganizerCandidates {
  organizerPubkey: string
  coordinates: Set<string>
  events: SignedPublicNostrEvent[]
  relayHints: string[]
  sourceRelayUrlsById: Map<string, readonly string[]>
}

interface EventMarketCandidateReadUnitResult {
  relayUrl: string
  authorChunkIndex: number
  authorCount: number
  events: SignedPublicNostrEvent[]
  eventSourceRelayUrls: Record<string, string[]>
  state: "complete" | "partial" | "failed"
  mainPageCount: number
  boundaryPageCount: number
  saturatedPageCount: number
  pageBudgetExhausted: boolean
  verificationTruncated: boolean
  capped: boolean
  rejectedEventCount: number
  eventsVerified: boolean
  pages: EventMarketCandidatePageCoverage[]
}

function chunkPubkeys(values: readonly string[], size: number): string[][] {
  const chunks: string[][] = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}

async function mapWithConcurrency<T, R>(input: {
  values: readonly T[]
  concurrency: number
  worker: (value: T, index: number) => Promise<R>
}): Promise<R[]> {
  if (input.values.length === 0) return []
  const results = new Array<R>(input.values.length)
  let nextIndex = 0
  const workerCount = Math.min(
    Math.max(1, input.concurrency),
    input.values.length
  )
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < input.values.length) {
        const index = nextIndex
        nextIndex += 1
        results[index] = await input.worker(input.values[index], index)
      }
    })
  )
  return results
}

function mergeCandidateReadEvents(
  eventsById: Map<string, SignedPublicNostrEvent>,
  sourceRelayUrlsById: Map<string, Set<string>>,
  read: SignedEventRelayReadResult,
  fallbackRelayUrl: string
): void {
  for (const event of read.events) {
    const eventId = event.id.toLowerCase()
    if (!eventsById.has(eventId)) eventsById.set(eventId, event)
    const relayUrls = sourceRelayUrlsById.get(eventId) ?? new Set<string>()
    const observedRelayUrls = [
      ...(read.eventSourceRelayUrls[event.id] ?? []),
      ...(read.eventSourceRelayUrls[eventId] ?? []),
    ]
    if (observedRelayUrls.length === 0) observedRelayUrls.push(fallbackRelayUrl)
    for (const relayUrl of observedRelayUrls) relayUrls.add(relayUrl)
    sourceRelayUrlsById.set(eventId, relayUrls)
  }
}

function relayResult(
  read: SignedEventRelayReadResult,
  relayUrl: string
): SignedEventRelayReadResult["relays"][number] | undefined {
  return (
    read.relays.find((relay) => relay.relayUrl === relayUrl) ?? read.relays[0]
  )
}

function readReachedLimit(
  read: SignedEventRelayReadResult,
  relayUrl: string,
  limit: number
): boolean {
  const relay = relayResult(read, relayUrl)
  return (
    read.events.length >= limit ||
    (!!relay &&
      relay.status !== "failed" &&
      relay.eventCount + (relay.rejectedEventCount ?? 0) >= limit)
  )
}

async function readEventMarketCollectionCandidateUnit(input: {
  relayUrl: string
  authorPubkeys: string[]
  authorChunkIndex: number
  signal?: AbortSignal
  fetchEvents: typeof fetchSignedEventsFanoutDetailed
  authority: DiscoveryReadAuthority &
    Pick<RelayReadOptions, "ownerSelectedRelayUrls">
}): Promise<EventMarketCandidateReadUnitResult> {
  const eventsById = new Map<string, SignedPublicNostrEvent>()
  const sourceRelayUrlsById = new Map<string, Set<string>>()
  let mainPageCount = 0
  let boundaryPageCount = 0
  let saturatedPageCount = 0
  let rejectedEventCount = 0
  let eventsVerified = true
  let verificationTruncated = false
  let until: number | undefined
  const pages: EventMarketCandidatePageCoverage[] = []

  const buildResult = (
    state: EventMarketCandidateReadUnitResult["state"],
    inputState: { pageBudgetExhausted?: boolean; capped?: boolean } = {}
  ): EventMarketCandidateReadUnitResult => ({
    relayUrl: input.relayUrl,
    authorChunkIndex: input.authorChunkIndex,
    authorCount: input.authorPubkeys.length,
    events: Array.from(eventsById.values()),
    eventSourceRelayUrls: Object.fromEntries(
      Array.from(sourceRelayUrlsById, ([eventId, relayUrls]) => [
        eventId,
        Array.from(relayUrls),
      ])
    ),
    state,
    mainPageCount,
    boundaryPageCount,
    saturatedPageCount,
    pageBudgetExhausted: inputState.pageBudgetExhausted === true,
    verificationTruncated,
    capped: inputState.capped === true,
    rejectedEventCount,
    eventsVerified,
    pages,
  })

  for (
    let pageIndex = 0;
    pageIndex < FOLLOWED_EVENT_MARKET_CANDIDATE_PAGE_LIMIT;
    pageIndex += 1
  ) {
    throwIfAborted(input.signal, input.authority.shouldContinue)
    let pageRead: SignedEventRelayReadResult
    try {
      pageRead = await input.fetchEvents(
        {
          kinds: [EVENT_KINDS.PRODUCT_COLLECTION],
          authors: input.authorPubkeys,
          ...(until !== undefined ? { until } : {}),
          limit: FOLLOWED_EVENT_MARKET_CANDIDATE_READ_LIMIT,
        } satisfies Filter,
        {
          ...input.authority,
          accountPubkey: input.authority.authenticatedPubkey,
          relayUrls: [input.relayUrl],
          signal: input.signal,
          reuseRelayConnections: true,
        }
      )
    } catch (error) {
      if (isAbortError(error)) throw error
      return buildResult(mainPageCount === 0 ? "failed" : "partial")
    }
    throwIfAborted(input.signal, input.authority.shouldContinue)
    mainPageCount += 1
    mergeCandidateReadEvents(
      eventsById,
      sourceRelayUrlsById,
      pageRead,
      input.relayUrl
    )
    const pageRelay = relayResult(pageRead, input.relayUrl)
    const pageCoverage: EventMarketCandidatePageCoverage = {
      pageIndex,
      ...(until !== undefined ? { until } : {}),
      mainRelayStatus: pageRelay?.status ?? "failed",
      mainCompletedAtEose: pageRelay?.status === "success",
      mainEventCount: pageRelay?.eventCount ?? pageRead.events.length,
      mainRejectedEventCount: pageRelay?.rejectedEventCount ?? 0,
      saturated: readReachedLimit(
        pageRead,
        input.relayUrl,
        FOLLOWED_EVENT_MARKET_CANDIDATE_READ_LIMIT
      ),
    }
    pages.push(pageCoverage)
    rejectedEventCount += pageRelay?.rejectedEventCount ?? 0
    eventsVerified &&= pageRead.eventsVerified === true
    if (pageRead.eventsVerified !== true) verificationTruncated = true
    if (!pageRelay || pageRelay.status === "failed") {
      return buildResult(mainPageCount === 1 ? "failed" : "partial")
    }
    if (pageRelay.status !== "success" || pageRead.eventsVerified !== true) {
      if ((pageRelay.rejectedEventCount ?? 0) > 0) {
        verificationTruncated = true
      }
      return buildResult("partial")
    }
    if (!pageCoverage.saturated) {
      return buildResult("complete")
    }

    saturatedPageCount += 1
    if ((pageRelay.rejectedEventCount ?? 0) > 0) {
      verificationTruncated = true
      return buildResult("partial", { capped: true })
    }
    const pageCreatedAt = pageRead.events
      .map((event) => event.created_at)
      .filter((createdAt) => Number.isSafeInteger(createdAt) && createdAt >= 0)
    if (
      pageCreatedAt.length !== pageRead.events.length ||
      pageCreatedAt.length === 0
    ) {
      verificationTruncated = true
      return buildResult("partial", { capped: true })
    }
    const boundary = Math.min(...pageCreatedAt)
    pageCoverage.boundaryCreatedAt = boundary
    let boundaryRead: SignedEventRelayReadResult
    try {
      boundaryRead = await input.fetchEvents(
        {
          kinds: [EVENT_KINDS.PRODUCT_COLLECTION],
          authors: input.authorPubkeys,
          since: boundary,
          until: boundary,
          limit: FOLLOWED_EVENT_MARKET_CANDIDATE_BOUNDARY_READ_LIMIT,
        } satisfies Filter,
        {
          ...input.authority,
          accountPubkey: input.authority.authenticatedPubkey,
          relayUrls: [input.relayUrl],
          signal: input.signal,
          reuseRelayConnections: true,
        }
      )
    } catch (error) {
      if (isAbortError(error)) throw error
      pageCoverage.boundaryRelayStatus = "failed"
      pageCoverage.boundaryCompletedAtEose = false
      pageCoverage.boundaryEventCount = 0
      pageCoverage.boundaryRejectedEventCount = 0
      pageCoverage.boundarySaturated = false
      return buildResult("partial", { capped: true })
    }
    throwIfAborted(input.signal, input.authority.shouldContinue)
    boundaryPageCount += 1
    mergeCandidateReadEvents(
      eventsById,
      sourceRelayUrlsById,
      boundaryRead,
      input.relayUrl
    )
    const boundaryRelay = relayResult(boundaryRead, input.relayUrl)
    rejectedEventCount += boundaryRelay?.rejectedEventCount ?? 0
    eventsVerified &&= boundaryRead.eventsVerified === true
    if (boundaryRead.eventsVerified !== true) verificationTruncated = true
    const boundaryCapped = readReachedLimit(
      boundaryRead,
      input.relayUrl,
      FOLLOWED_EVENT_MARKET_CANDIDATE_BOUNDARY_READ_LIMIT
    )
    pageCoverage.boundaryRelayStatus = boundaryRelay?.status ?? "failed"
    pageCoverage.boundaryCompletedAtEose = boundaryRelay?.status === "success"
    pageCoverage.boundaryEventCount =
      boundaryRelay?.eventCount ?? boundaryRead.events.length
    pageCoverage.boundaryRejectedEventCount =
      boundaryRelay?.rejectedEventCount ?? 0
    pageCoverage.boundarySaturated = boundaryCapped
    const pageBoundaryIds = new Set(
      pageRead.events
        .filter((event) => event.created_at === boundary)
        .map((event) => event.id.toLowerCase())
    )
    const boundaryIds = new Set(
      boundaryRead.events.map((event) => event.id.toLowerCase())
    )
    const boundaryPreserved = Array.from(pageBoundaryIds).every((eventId) =>
      boundaryIds.has(eventId)
    )
    if (
      !boundaryRelay ||
      boundaryRelay.status !== "success" ||
      boundaryRead.eventsVerified !== true ||
      boundaryCapped ||
      !boundaryPreserved
    ) {
      if (
        boundaryRead.eventsVerified !== true ||
        (boundaryRelay?.rejectedEventCount ?? 0) > 0 ||
        !boundaryPreserved
      ) {
        verificationTruncated = true
      }
      return buildResult("partial", { capped: true })
    }
    if (boundary === 0) return buildResult("complete")
    if (pageIndex + 1 >= FOLLOWED_EVENT_MARKET_CANDIDATE_PAGE_LIMIT) {
      return buildResult("partial", {
        pageBudgetExhausted: true,
        capped: true,
      })
    }
    until = boundary - 1
  }

  return buildResult("partial", {
    pageBudgetExhausted: true,
    capped: true,
  })
}

async function readEventMarketCollectionCandidates(input: {
  organizerPubkeys: readonly string[]
  authenticatedPubkey?: string | null
  nowMs: number
  signal?: AbortSignal
  accountNetworkLocalStateRepository?: DiscoveryReadAuthority["accountNetworkLocalStateRepository"]
  shouldContinue?: () => boolean
}): Promise<EventMarketCollectionCandidateReadResult> {
  const organizerPubkeys = Array.from(
    new Set(
      input.organizerPubkeys
        .map((pubkey) => normalizePubkey(pubkey))
        .filter((pubkey): pubkey is string => pubkey !== null)
    )
  ).sort()
  const authorChunks = chunkPubkeys(
    organizerPubkeys,
    FOLLOWED_EVENT_MARKET_CANDIDATE_AUTHOR_CHUNK_SIZE
  )
  throwIfAborted(input.signal, input.shouldContinue)
  const authenticatedPubkey = normalizePubkey(input.authenticatedPubkey)
  let ownerSnapshot:
    | Awaited<
        ReturnType<typeof readDurableAccountRelaySettingsPlanningSnapshot>
      >
    | undefined
  if (authenticatedPubkey) {
    try {
      ownerSnapshot = await (
        testOverrides.readAccountRelaySettingsPlanningSnapshot ??
        readDurableAccountRelaySettingsPlanningSnapshot
      )(authenticatedPubkey)
    } catch {
      // Missing owner evidence grants no additional relay transport authority.
      throwIfAborted(input.signal, input.shouldContinue)
    }
  }
  throwIfAborted(input.signal, input.shouldContinue)
  const ownerSelectedRelayUrls = normalizeOwnerSelectedRelayUrls(
    ownerSnapshot?.settings.entries
      .filter((entry) => entry.readEnabled)
      .map((entry) => entry.url) ?? []
  )
  const plannedRelayUrls = Array.from(
    new Set(
      (
        testOverrides.collectionCandidateRelayUrls ??
        planRelayReads({
          intent: "commerce_products",
          authenticatedPubkey,
          ownerSelectedRelayUrls,
          settings: ownerSnapshot?.settings,
          signedRelayListAuthoritative:
            ownerSnapshot?.signedRelayListAuthoritative,
          maxRelays: FOLLOWED_EVENT_MARKET_CANDIDATE_RELAY_LIMIT,
          now: input.nowMs,
        }).relayUrls
      )
        .map((relayUrl) => relayUrl.trim())
        .filter(Boolean)
    )
  ).slice(0, FOLLOWED_EVENT_MARKET_CANDIDATE_RELAY_LIMIT)
  const emptyCoverage: EventMarketCandidateReadCoverage = {
    plannedRelayUrls,
    authorChunkCount: authorChunks.length,
    plannedReadCount: plannedRelayUrls.length * authorChunks.length,
    reads: [],
    completeReadCount: 0,
    partialReadCount: 0,
    failedReadCount: 0,
    mainPageCount: 0,
    boundaryPageCount: 0,
    saturatedPageCount: 0,
    pageBudgetExhaustedReadCount: 0,
    verificationTruncatedReadCount: 0,
  }
  if (plannedRelayUrls.length === 0 || authorChunks.length === 0) {
    return {
      events: [],
      eventSourceRelayUrls: {},
      relays: [],
      eventsVerified: true,
      plannedRelayCount: 0,
      capped: false,
      coverage: emptyCoverage,
    }
  }
  const tasks = plannedRelayUrls.flatMap((relayUrl) =>
    authorChunks.map((authorPubkeys, authorChunkIndex) => ({
      relayUrl,
      authorPubkeys,
      authorChunkIndex,
    }))
  )
  const fetchEvents =
    testOverrides.fetchCollectionCandidateEvents ??
    fetchSignedEventsFanoutDetailed
  const unitResults = await mapWithConcurrency({
    values: tasks,
    concurrency: FOLLOWED_EVENT_MARKET_CANDIDATE_READ_CONCURRENCY,
    worker: async (task) =>
      await readEventMarketCollectionCandidateUnit({
        ...task,
        signal: input.signal,
        authority: {
          authenticatedPubkey,
          ownerSelectedRelayUrls,
          accountNetworkLocalStateRepository:
            input.accountNetworkLocalStateRepository,
          shouldContinue: input.shouldContinue,
        },
        fetchEvents,
      }),
  })
  const eventsById = new Map<string, SignedPublicNostrEvent>()
  const sourceRelayUrlsById = new Map<string, Set<string>>()
  for (const unit of unitResults) {
    mergeCandidateReadEvents(
      eventsById,
      sourceRelayUrlsById,
      {
        events: unit.events,
        eventSourceRelayUrls: unit.eventSourceRelayUrls,
        relays: [],
        eventsVerified: unit.eventsVerified,
      },
      unit.relayUrl
    )
  }
  const coverage: EventMarketCandidateReadCoverage = {
    ...emptyCoverage,
    reads: unitResults.map((unit) => ({
      relayUrl: unit.relayUrl,
      authorChunkIndex: unit.authorChunkIndex,
      authorCount: unit.authorCount,
      state: unit.state,
      pages: unit.pages,
      pageBudgetExhausted: unit.pageBudgetExhausted,
      verificationTruncated: unit.verificationTruncated,
    })),
    completeReadCount: unitResults.filter((unit) => unit.state === "complete")
      .length,
    partialReadCount: unitResults.filter((unit) => unit.state === "partial")
      .length,
    failedReadCount: unitResults.filter((unit) => unit.state === "failed")
      .length,
    mainPageCount: unitResults.reduce(
      (count, unit) => count + unit.mainPageCount,
      0
    ),
    boundaryPageCount: unitResults.reduce(
      (count, unit) => count + unit.boundaryPageCount,
      0
    ),
    saturatedPageCount: unitResults.reduce(
      (count, unit) => count + unit.saturatedPageCount,
      0
    ),
    pageBudgetExhaustedReadCount: unitResults.filter(
      (unit) => unit.pageBudgetExhausted
    ).length,
    verificationTruncatedReadCount: unitResults.filter(
      (unit) => unit.verificationTruncated
    ).length,
  }
  return {
    events: Array.from(eventsById.values()),
    eventSourceRelayUrls: Object.fromEntries(
      Array.from(sourceRelayUrlsById, ([eventId, relayUrls]) => [
        eventId,
        Array.from(relayUrls),
      ])
    ),
    relays: plannedRelayUrls.map((relayUrl) => {
      const relayUnits = unitResults.filter(
        (unit) => unit.relayUrl === relayUrl
      )
      const state = relayUnits.every((unit) => unit.state === "complete")
        ? "success"
        : relayUnits.every((unit) => unit.state === "failed")
          ? "failed"
          : "partial"
      const eventIds = new Set(
        relayUnits.flatMap((unit) => unit.events.map((event) => event.id))
      )
      return {
        relayUrl,
        status: state,
        eventCount: eventIds.size,
        rejectedEventCount: relayUnits.reduce(
          (count, unit) => count + unit.rejectedEventCount,
          0
        ),
      }
    }),
    eventsVerified: unitResults.every((unit) => unit.eventsVerified),
    plannedRelayCount: plannedRelayUrls.length,
    capped: unitResults.some((unit) => unit.capped),
    coverage,
  }
}

function candidateScanState(
  read: EventMarketCollectionCandidateReadResult
): FollowedEventMarketCandidateScanState {
  const usableReadCount =
    read.coverage.completeReadCount + read.coverage.partialReadCount
  if (read.plannedRelayCount === 0 || usableReadCount === 0) {
    return "unavailable"
  }
  if (
    read.eventsVerified !== true ||
    read.capped ||
    read.coverage.completeReadCount < read.coverage.plannedReadCount ||
    read.coverage.partialReadCount > 0 ||
    read.coverage.failedReadCount > 0
  ) {
    return "partial"
  }
  return "complete"
}

function newerAddressableEvent(
  candidate: SignedPublicNostrEvent,
  current: SignedPublicNostrEvent
): boolean {
  if (candidate.created_at !== current.created_at) {
    return candidate.created_at > current.created_at
  }
  return candidate.id.toLowerCase() < current.id.toLowerCase()
}

function collectionCandidateFrontier(input: {
  read: EventMarketCollectionCandidateReadResult
  perspectiveOrganizerPubkeys: ReadonlySet<string>
}): {
  organizers: EventMarketOrganizerCandidates[]
  candidateCollectionCount: number
  malformedFollowedCandidateObserved: boolean
  truncated: boolean
} {
  const candidatesByCoordinate = new Map<
    string,
    EventMarketCollectionCandidate
  >()
  let malformedFollowedCandidateObserved = false

  for (const event of input.read.events) {
    if (event.kind !== EVENT_KINDS.PRODUCT_COLLECTION) continue
    const organizerPubkey = normalizePubkey(event.pubkey)
    if (
      !organizerPubkey ||
      !input.perspectiveOrganizerPubkeys.has(organizerPubkey)
    ) {
      continue
    }
    if (!isValidSignedPublicNostrEvent(event)) {
      malformedFollowedCandidateObserved = true
      continue
    }
    const dTags = event.tags
      .filter((tag) => tag[0] === "d" && typeof tag[1] === "string")
      .map((tag) => tag[1]!)
    if (dTags.length !== 1) {
      malformedFollowedCandidateObserved = true
      continue
    }
    const coordinate = parseAddressableCoordinate(
      `${EVENT_KINDS.PRODUCT_COLLECTION}:${organizerPubkey}:${dTags[0]}`,
      [EVENT_KINDS.PRODUCT_COLLECTION]
    )
    if (!coordinate) {
      malformedFollowedCandidateObserved = true
      continue
    }
    const relayHints = Array.from(
      new Set([
        ...(input.read.eventSourceRelayUrls[event.id] ?? []),
        ...(input.read.eventSourceRelayUrls[event.id.toLowerCase()] ?? []),
      ])
    )
    const current = candidatesByCoordinate.get(coordinate.coordinate)
    if (!current || newerAddressableEvent(event, current.event)) {
      candidatesByCoordinate.set(coordinate.coordinate, {
        coordinate: coordinate.coordinate,
        organizerPubkey,
        event,
        relayHints,
      })
    } else if (current.event.id === event.id && relayHints.length > 0) {
      current.relayHints = Array.from(
        new Set([...current.relayHints, ...relayHints])
      )
    }
  }

  const orderedCandidates = Array.from(candidatesByCoordinate.values()).sort(
    (left, right) => {
      if (left.event.created_at !== right.event.created_at) {
        return right.event.created_at - left.event.created_at
      }
      return left.event.id.localeCompare(right.event.id)
    }
  )
  const candidatesByOrganizer = new Map<
    string,
    EventMarketOrganizerCandidates
  >()
  for (const candidate of orderedCandidates) {
    const existing = candidatesByOrganizer.get(candidate.organizerPubkey) ?? {
      organizerPubkey: candidate.organizerPubkey,
      coordinates: new Set<string>(),
      events: [],
      relayHints: [],
      sourceRelayUrlsById: new Map<string, readonly string[]>(),
    }
    existing.coordinates.add(candidate.coordinate)
    existing.events.push(candidate.event)
    existing.relayHints = Array.from(
      new Set([...existing.relayHints, ...candidate.relayHints])
    )
    existing.sourceRelayUrlsById.set(candidate.event.id, candidate.relayHints)
    candidatesByOrganizer.set(candidate.organizerPubkey, existing)
  }

  return {
    organizers: Array.from(candidatesByOrganizer.values()).sort((left, right) =>
      left.organizerPubkey.localeCompare(right.organizerPubkey)
    ),
    candidateCollectionCount: orderedCandidates.length,
    malformedFollowedCandidateObserved,
    truncated: false,
  }
}

function mergeCandidateFrontiers(
  ...frontiers: ReadonlyArray<ReturnType<typeof collectionCandidateFrontier>>
): ReturnType<typeof collectionCandidateFrontier> {
  const organizers = new Map<string, EventMarketOrganizerCandidates>()
  for (const frontier of frontiers) {
    for (const candidate of frontier.organizers) {
      const current = organizers.get(candidate.organizerPubkey) ?? {
        organizerPubkey: candidate.organizerPubkey,
        coordinates: new Set<string>(),
        events: [],
        relayHints: [],
        sourceRelayUrlsById: new Map<string, readonly string[]>(),
      }
      for (const coordinate of candidate.coordinates) {
        current.coordinates.add(coordinate)
      }
      const eventsById = new Map(
        current.events.map((event) => [event.id.toLowerCase(), event])
      )
      for (const event of candidate.events) {
        eventsById.set(event.id.toLowerCase(), event)
      }
      current.events = Array.from(eventsById.values())
      current.relayHints = Array.from(
        new Set([...current.relayHints, ...candidate.relayHints])
      )
      for (const [eventId, relayUrls] of candidate.sourceRelayUrlsById) {
        current.sourceRelayUrlsById.set(
          eventId,
          Array.from(
            new Set([
              ...(current.sourceRelayUrlsById.get(eventId) ?? []),
              ...relayUrls,
            ])
          )
        )
      }
      organizers.set(candidate.organizerPubkey, current)
    }
  }

  const orderedOrganizers = Array.from(organizers.values()).sort(
    (left, right) => left.organizerPubkey.localeCompare(right.organizerPubkey)
  )
  return {
    organizers: orderedOrganizers,
    candidateCollectionCount: orderedOrganizers.reduce(
      (count, candidate) => count + candidate.coordinates.size,
      0
    ),
    malformedFollowedCandidateObserved: frontiers.some(
      (frontier) => frontier.malformedFollowedCandidateObserved
    ),
    truncated: frontiers.some((frontier) => frontier.truncated),
  }
}

function isBoundedDiscoveryError(reason: unknown): boolean {
  return (
    reason instanceof EventMarketDiscoveryBoundError ||
    (typeof reason === "object" &&
      reason !== null &&
      "code" in reason &&
      reason.code === "event_market_discovery_bound")
  )
}

function isAbortError(reason: unknown): boolean {
  return (
    typeof reason === "object" &&
    reason !== null &&
    "name" in reason &&
    reason.name === "AbortError"
  )
}

function deadlineBoundRead(): PromiseRejectedResult {
  return {
    status: "rejected",
    reason: new EventMarketDiscoveryBoundError(
      "Perspective event discovery reached its client execution deadline."
    ),
  }
}

function readIsUnavailable(
  value: PromiseSettledResult<OrganizerEventMarketsReadResult>
): boolean {
  return value.status === "rejected"
    ? !isBoundedDiscoveryError(value.reason)
    : value.value.state === "unavailable"
}

function resultState(input: {
  marketCount: number
  followCoverage: FollowListCoverageState
  hasFollowSnapshot: boolean
  candidateScanState: FollowedEventMarketCandidateScanState
  organizerReads: readonly PromiseSettledResult<OrganizerEventMarketsReadResult>[]
  truncated: boolean
  hasDegradedMarket: boolean
}): FollowedEventMarketDiscoveryState {
  const allOrganizerReadsUnavailable =
    input.organizerReads.length > 0 &&
    input.organizerReads.every(readIsUnavailable)
  if (
    (input.followCoverage === "unavailable" && !input.hasFollowSnapshot) ||
    (input.marketCount === 0 && input.candidateScanState === "unavailable") ||
    (input.marketCount === 0 && allOrganizerReadsUnavailable)
  ) {
    return "unavailable"
  }

  const organizerReadsComplete = input.organizerReads.every(
    (read) => read.status === "fulfilled" && read.value.state === "complete"
  )
  const complete =
    input.followCoverage === "complete" &&
    input.candidateScanState === "complete" &&
    organizerReadsComplete &&
    !input.truncated &&
    !input.hasDegradedMarket
  if (complete) return input.marketCount > 0 ? "complete" : "complete_empty"
  return "partial"
}

function emptyCandidateReadCoverage(): EventMarketCandidateReadCoverage {
  return {
    plannedRelayUrls: [],
    authorChunkCount: 0,
    plannedReadCount: 0,
    reads: [],
    completeReadCount: 0,
    partialReadCount: 0,
    failedReadCount: 0,
    mainPageCount: 0,
    boundaryPageCount: 0,
    saturatedPageCount: 0,
    pageBudgetExhaustedReadCount: 0,
    verificationTruncatedReadCount: 0,
  }
}

/**
 * Discovers event-market collections inside an already resolved public author
 * perspective. Callers reuse their product-catalog Following, Conduit, or
 * combined author decision; this read never asks for a signer on its own.
 */
export async function discoverPerspectiveEventMarkets(
  input: DiscoverPerspectiveEventMarketsInput
): Promise<PerspectiveEventMarketDiscoveryResult> {
  throwIfAborted(input.signal, input.shouldContinue)
  const effectiveNowMs = input.nowMs ?? Date.now()
  const perspectiveOrganizers = Array.from(
    new Set(
      input.organizerPubkeys
        .map((pubkey) => normalizePubkey(pubkey))
        .filter((pubkey): pubkey is string => pubkey !== null)
    )
  ).sort()
  const perspective: EventMarketPerspectiveSnapshot = {
    ...input.perspective,
    authorCount: perspectiveOrganizers.length,
  }
  const perspectiveOrganizerSet = new Set(perspectiveOrganizers)

  const readCollectionCandidates =
    testOverrides.readCollectionCandidates ??
    readEventMarketCollectionCandidates
  const candidateRead =
    perspectiveOrganizers.length === 0
      ? ({
          events: [],
          eventSourceRelayUrls: {},
          relays: [],
          eventsVerified: true,
          plannedRelayCount: 0,
          capped: false,
          coverage: emptyCandidateReadCoverage(),
        } satisfies EventMarketCollectionCandidateReadResult)
      : await readCollectionCandidates({
          organizerPubkeys: perspectiveOrganizers,
          authenticatedPubkey: input.authenticatedPubkey,
          accountNetworkLocalStateRepository:
            input.accountNetworkLocalStateRepository,
          shouldContinue: input.shouldContinue,
          nowMs: effectiveNowMs,
          signal: input.signal,
        })
  throwIfAborted(input.signal, input.shouldContinue)
  const resolvedCandidateScanState =
    perspectiveOrganizers.length === 0
      ? "complete"
      : candidateScanState(candidateRead)
  const liveCandidateFrontier = collectionCandidateFrontier({
    read: candidateRead,
    perspectiveOrganizerPubkeys: perspectiveOrganizerSet,
  })
  const readRetainedCollectionCandidates =
    testOverrides.readRetainedCollectionCandidates ??
    getRetainedEventMarketCollectionEvidence
  const retainedCandidateRead =
    perspectiveOrganizers.length === 0
      ? { events: [], eventSourceRelayUrls: {} }
      : await readRetainedCollectionCandidates({
          organizerPubkeys: perspectiveOrganizers,
          signal: input.signal,
        })
  throwIfAborted(input.signal, input.shouldContinue)
  const retainedCandidateFrontier = collectionCandidateFrontier({
    read: {
      ...retainedCandidateRead,
      relays: [],
      eventsVerified: true,
      plannedRelayCount: 0,
      capped: false,
      coverage: emptyCandidateReadCoverage(),
    },
    perspectiveOrganizerPubkeys: perspectiveOrganizerSet,
  })
  const candidateFrontier = mergeCandidateFrontiers(
    retainedCandidateFrontier,
    liveCandidateFrontier
  )
  const liveCandidateEventIdsByOrganizer = new Map(
    liveCandidateFrontier.organizers.map((candidate) => [
      candidate.organizerPubkey,
      new Set(candidate.events.map((event) => event.id.toLowerCase())),
    ])
  )
  const readOrganizerMarkets =
    testOverrides.readOrganizerMarkets ?? getOrganizerEventMarketsDetailed
  const organizerReads: PromiseSettledResult<OrganizerEventMarketsReadResult>[] =
    []
  const organizerController = new AbortController()
  let deadlineReached = false
  let searchedOrganizerCount = 0
  let resolveStop: (reason: "deadline" | "caller") => void = () => undefined
  const stopPromise = new Promise<"deadline" | "caller">((resolve) => {
    resolveStop = resolve
  })
  const abortForCaller = () => {
    organizerController.abort()
    resolveStop("caller")
  }
  input.signal?.addEventListener("abort", abortForCaller, { once: true })
  const configuredDeadline =
    testOverrides.organizerReadDeadlineMs ??
    FOLLOWED_EVENT_MARKET_READ_DEADLINE_MS
  const deadlineMs = Number.isFinite(configuredDeadline)
    ? Math.max(1, Math.floor(configuredDeadline))
    : FOLLOWED_EVENT_MARKET_READ_DEADLINE_MS
  const deadline = setTimeout(() => {
    deadlineReached = true
    organizerController.abort()
    resolveStop("deadline")
  }, deadlineMs)

  try {
    for (
      let index = 0;
      index < candidateFrontier.organizers.length;
      index += FOLLOWED_EVENT_MARKET_READ_CONCURRENCY
    ) {
      throwIfAborted(input.signal, input.shouldContinue)
      if (deadlineReached) break
      const batch = candidateFrontier.organizers.slice(
        index,
        index + FOLLOWED_EVENT_MARKET_READ_CONCURRENCY
      )
      searchedOrganizerCount += batch.length
      const completed = new Map<
        number,
        PromiseSettledResult<OrganizerEventMarketsReadResult>
      >()
      const reads = batch.map(async (candidate, batchIndex) => {
        let result: PromiseSettledResult<OrganizerEventMarketsReadResult>
        try {
          result = {
            status: "fulfilled",
            value: await readOrganizerMarkets({
              organizerPubkey: candidate.organizerPubkey,
              authenticatedPubkey: input.authenticatedPubkey,
              accountNetworkLocalStateRepository:
                input.accountNetworkLocalStateRepository,
              nowMs: effectiveNowMs,
              projection: "discovery",
              relayHints: candidate.relayHints,
              candidateCollectionEvents: candidate.events,
              candidateCollectionSourceRelayUrlsById:
                candidate.sourceRelayUrlsById,
              candidateCollectionLiveEventIds:
                liveCandidateEventIdsByOrganizer.get(
                  candidate.organizerPubkey
                ) ?? new Set<string>(),
              signal: organizerController.signal,
              shouldContinue: input.shouldContinue,
            }),
          }
        } catch (reason) {
          result = { status: "rejected", reason }
        }
        completed.set(batchIndex, result)
        return result
      })
      const outcome = await Promise.race([
        Promise.all(reads).then((results) => ({
          state: "complete" as const,
          results,
        })),
        stopPromise.then((reason) => ({
          state: "stopped" as const,
          reason,
        })),
      ])

      if (outcome.state === "stopped") {
        if (outcome.reason === "caller") {
          throwIfAborted(input.signal, input.shouldContinue)
        }
        organizerReads.push(
          ...batch.map((_, batchIndex) => {
            const result = completed.get(batchIndex)
            return result?.status === "rejected" && isAbortError(result.reason)
              ? deadlineBoundRead()
              : (result ?? deadlineBoundRead())
          })
        )
        break
      }

      organizerReads.push(
        ...outcome.results.map((result) =>
          deadlineReached &&
          result.status === "rejected" &&
          isAbortError(result.reason)
            ? deadlineBoundRead()
            : result
        )
      )
      if (deadlineReached) break
    }
  } finally {
    clearTimeout(deadline)
    input.signal?.removeEventListener("abort", abortForCaller)
  }
  throwIfAborted(input.signal, input.shouldContinue)

  const boundedOrganizerCount = organizerReads.filter(
    (read) => read.status === "rejected" && isBoundedDiscoveryError(read.reason)
  ).length
  const truncated =
    perspective.truncated ||
    candidateRead.capped ||
    candidateFrontier.truncated ||
    boundedOrganizerCount > 0 ||
    deadlineReached ||
    searchedOrganizerCount < candidateFrontier.organizers.length

  const candidateCoordinates = new Set(
    candidateFrontier.organizers.flatMap((candidate) => [
      ...candidate.coordinates,
    ])
  )
  const liveCandidateCoordinates = new Set(
    liveCandidateFrontier.organizers.flatMap((candidate) => [
      ...candidate.coordinates,
    ])
  )
  const marketsByCoordinate = new Map<string, EventMarketResolution>()
  let hasDegradedMarket =
    candidateFrontier.malformedFollowedCandidateObserved ||
    candidateRead.eventsVerified !== true
  for (const read of organizerReads) {
    if (read.status !== "fulfilled") continue
    for (const market of read.value.markets) {
      const organizerPubkey = normalizePubkey(market.organizerPubkey)
      const calendarEndMs = market.calendar?.end
      if (
        !organizerPubkey ||
        !perspectiveOrganizerSet.has(organizerPubkey) ||
        !candidateCoordinates.has(market.reference)
      ) {
        continue
      }
      if (
        !input.includeEnded &&
        calendarEndMs !== undefined &&
        calendarEndMs <= effectiveNowMs
      ) {
        continue
      }
      if (
        market.state === "malformed" ||
        market.state === "conflicting" ||
        market.state === "unsupported"
      ) {
        hasDegradedMarket = true
        continue
      }
      if (
        market.state !== "active" &&
        !(input.includeEnded && market.state === "ended") &&
        market.state !== "partial" &&
        market.state !== "stale"
      ) {
        continue
      }
      if (market.state === "partial" || market.state === "stale") {
        hasDegradedMarket = true
      }
      if (!liveCandidateCoordinates.has(market.reference)) {
        hasDegradedMarket = true
      }
      marketsByCoordinate.set(market.reference, market)
    }
  }

  const markets = sortCurrentMarkets(marketsByCoordinate.values())
  return {
    markets,
    state: resultState({
      marketCount: markets.length,
      followCoverage: perspective.coverage,
      hasFollowSnapshot:
        perspective.eventObserved || perspective.snapshotState !== "none",
      candidateScanState: resolvedCandidateScanState,
      organizerReads,
      truncated,
      hasDegradedMarket,
    }),
    perspective,
    candidateCollectionCount: candidateFrontier.candidateCollectionCount,
    candidateScanState: resolvedCandidateScanState,
    candidateScanCoverage: candidateRead.coverage,
    searchedOrganizerCount,
    incompleteOrganizerCount: organizerReads.filter(
      (read) =>
        read.status === "rejected" ||
        (read.status === "fulfilled" && read.value.state !== "complete")
    ).length,
    failedOrganizerCount: organizerReads.filter(readIsUnavailable).length,
    boundedOrganizerCount,
    truncated,
  }
}

export async function discoverFollowedOrganizerEventMarkets(
  input: DiscoverFollowedEventMarketsInput
): Promise<FollowedEventMarketDiscoveryResult> {
  const merchantPubkey = normalizePubkey(input.merchantPubkey)
  if (!merchantPubkey) {
    const perspective: EventMarketPerspectiveSnapshot = {
      source: "following",
      authorCount: 0,
      coverage: "unavailable",
      eventObserved: false,
      snapshotState: "none",
      truncated: false,
    }
    return {
      markets: [],
      state: "unavailable",
      perspective,
      followListCoverage: "unavailable",
      followedOrganizerCount: 0,
      candidateCollectionCount: 0,
      candidateScanState: "unavailable",
      candidateScanCoverage: emptyCandidateReadCoverage(),
      searchedOrganizerCount: 0,
      incompleteOrganizerCount: 0,
      failedOrganizerCount: 0,
      boundedOrganizerCount: 0,
      truncated: false,
      followListEventObserved: false,
      followListSnapshotState: "none",
    }
  }

  throwIfAborted(input.signal, input.shouldContinue)
  const effectiveNowMs = input.nowMs ?? Date.now()
  const readFollowLists = testOverrides.readFollowLists ?? readLatestFollowLists
  const followRead: FollowListReadResult = await readFollowLists(
    {
      pubkeys: [merchantPubkey],
      authenticatedPubkey: input.authenticatedPubkey,
    },
    {
      signal: input.signal,
      accountNetworkLocalStateRepository:
        input.accountNetworkLocalStateRepository,
      shouldContinue: input.shouldContinue,
      now: () => effectiveNowMs,
    }
  )
  throwIfAborted(input.signal, input.shouldContinue)

  const followAuthor = followRead.authors.find(
    (candidate) => candidate.pubkey === merchantPubkey
  )
  const followedOrganizers = extractFollowPubkeys(followAuthor?.event?.tags)
    .filter((pubkey) => pubkey !== merchantPubkey)
    .sort()
  const followListCoverage = followAuthor?.coverage ?? "unavailable"
  const followListEventObserved = !!followAuthor?.event
  const followListSnapshotState = followAuthor?.snapshotState ?? "none"
  const discovery = await discoverPerspectiveEventMarkets({
    organizerPubkeys: followedOrganizers,
    perspective: {
      source: "following",
      coverage: followListCoverage,
      eventObserved: followListEventObserved,
      snapshotState: followListSnapshotState,
      truncated:
        followAuthor?.capped === true ||
        followAuthor?.relayHintTruncated === true,
    },
    authenticatedPubkey: input.authenticatedPubkey,
    accountNetworkLocalStateRepository:
      input.accountNetworkLocalStateRepository,
    shouldContinue: input.shouldContinue,
    nowMs: effectiveNowMs,
    signal: input.signal,
  })
  return {
    ...discovery,
    followListCoverage,
    followedOrganizerCount: followedOrganizers.length,
    followListEventObserved,
    followListSnapshotState,
  }
}
