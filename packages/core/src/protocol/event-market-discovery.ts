import type { Filter } from "nostr-tools"
import {
  EventMarketDiscoveryBoundError,
  getOrganizerEventMarketsDetailed,
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
} from "./relay-reader"
import { planRelayReads } from "./relay-planner"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

/**
 * Client execution-safety budget for one public collection-candidate read.
 * This is not a Nostr or Open Markets protocol limit. Saturation is reported
 * as a partial view and direct event imports remain available.
 */
export const FOLLOWED_EVENT_MARKET_CANDIDATE_TARGET_LIMIT = 128
const FOLLOWED_EVENT_MARKET_CANDIDATE_READ_LIMIT =
  FOLLOWED_EVENT_MARKET_CANDIDATE_TARGET_LIMIT + 1
const FOLLOWED_EVENT_MARKET_CANDIDATE_RELAY_LIMIT = 6
const FOLLOWED_EVENT_MARKET_READ_CONCURRENCY = 4
const FOLLOWED_EVENT_MARKET_READ_DEADLINE_MS = 20_000

export type FollowedEventMarketDiscoveryState =
  "complete" | "complete_empty" | "partial" | "unavailable"

export type FollowedEventMarketCandidateScanState =
  "complete" | "partial" | "unavailable"

export interface FollowedEventMarketDiscoveryResult {
  markets: EventMarketResolution[]
  state: FollowedEventMarketDiscoveryState
  followListCoverage: FollowListCoverageState
  followedOrganizerCount: number
  candidateCollectionCount: number
  candidateScanState: FollowedEventMarketCandidateScanState
  searchedOrganizerCount: number
  failedOrganizerCount: number
  boundedOrganizerCount: number
  truncated: boolean
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

interface FollowedEventMarketDiscoveryTestOverrides {
  readFollowLists?: typeof readLatestFollowLists
  readCollectionCandidates?: typeof readEventMarketCollectionCandidates
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

function candidateReadReachedLimit(
  result: SignedEventRelayReadResult
): boolean {
  return (
    result.events.length >= FOLLOWED_EVENT_MARKET_CANDIDATE_READ_LIMIT ||
    result.relays.some(
      (relay) =>
        relay.status !== "failed" &&
        relay.eventCount + (relay.rejectedEventCount ?? 0) >=
          FOLLOWED_EVENT_MARKET_CANDIDATE_READ_LIMIT
    )
  )
}

async function readEventMarketCollectionCandidates(input: {
  authenticatedPubkey?: string | null
  nowMs: number
  signal?: AbortSignal
}): Promise<EventMarketCollectionCandidateReadResult> {
  const plan = planRelayReads({
    intent: "commerce_products",
    authenticatedPubkey: input.authenticatedPubkey,
    maxRelays: FOLLOWED_EVENT_MARKET_CANDIDATE_RELAY_LIMIT,
    now: input.nowMs,
  })
  if (plan.relayUrls.length === 0) {
    return {
      events: [],
      eventSourceRelayUrls: {},
      relays: [],
      eventsVerified: true,
      plannedRelayCount: 0,
      capped: false,
    }
  }
  const result = await fetchSignedEventsFanoutDetailed(
    {
      kinds: [EVENT_KINDS.PRODUCT_COLLECTION],
      limit: FOLLOWED_EVENT_MARKET_CANDIDATE_READ_LIMIT,
    } satisfies Filter,
    {
      relayUrls: plan.relayUrls,
      signal: input.signal,
      reuseRelayConnections: true,
    }
  )
  return {
    ...result,
    plannedRelayCount: plan.relayUrls.length,
    capped: candidateReadReachedLimit(result),
  }
}

function candidateScanState(
  read: EventMarketCollectionCandidateReadResult
): FollowedEventMarketCandidateScanState {
  const usableRelayCount = read.relays.filter(
    (relay) => relay.status === "success" || relay.status === "partial"
  ).length
  if (read.plannedRelayCount === 0 || usableRelayCount === 0) {
    return "unavailable"
  }
  if (
    read.eventsVerified !== true ||
    read.capped ||
    read.relays.length < read.plannedRelayCount ||
    read.relays.some((relay) => relay.status !== "success")
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
  followedOrganizerPubkeys: ReadonlySet<string>
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

  if (input.read.eventsVerified === true) {
    for (const event of input.read.events) {
      if (event.kind !== EVENT_KINDS.PRODUCT_COLLECTION) continue
      const organizerPubkey = normalizePubkey(event.pubkey)
      if (
        !organizerPubkey ||
        !input.followedOrganizerPubkeys.has(organizerPubkey)
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
  }

  const orderedCandidates = Array.from(candidatesByCoordinate.values()).sort(
    (left, right) => {
      if (left.event.created_at !== right.event.created_at) {
        return right.event.created_at - left.event.created_at
      }
      return left.event.id.localeCompare(right.event.id)
    }
  )
  const candidateFrontierTruncated =
    orderedCandidates.length > FOLLOWED_EVENT_MARKET_CANDIDATE_TARGET_LIMIT
  const selectedCandidates = orderedCandidates.slice(
    0,
    FOLLOWED_EVENT_MARKET_CANDIDATE_TARGET_LIMIT
  )
  const candidatesByOrganizer = new Map<
    string,
    EventMarketOrganizerCandidates
  >()
  for (const candidate of selectedCandidates) {
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
    candidateCollectionCount: selectedCandidates.length,
    malformedFollowedCandidateObserved,
    truncated: candidateFrontierTruncated,
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
      "Followed-organizer event discovery reached its client execution deadline."
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

export async function discoverFollowedOrganizerEventMarkets(
  input: DiscoverFollowedEventMarketsInput
): Promise<FollowedEventMarketDiscoveryResult> {
  const merchantPubkey = normalizePubkey(input.merchantPubkey)
  if (!merchantPubkey) {
    return {
      markets: [],
      state: "unavailable",
      followListCoverage: "unavailable",
      followedOrganizerCount: 0,
      candidateCollectionCount: 0,
      candidateScanState: "unavailable",
      searchedOrganizerCount: 0,
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
      shouldContinue: input.shouldContinue,
      now: () => effectiveNowMs,
      accountNetworkLocalStateRepository:
        input.accountNetworkLocalStateRepository,
    }
  )
  throwIfAborted(input.signal, input.shouldContinue)

  const followAuthor = followRead.authors.find(
    (candidate) => candidate.pubkey === merchantPubkey
  )
  const followedOrganizers = extractFollowPubkeys(followAuthor?.event?.tags)
    .filter((pubkey) => pubkey !== merchantPubkey)
    .sort()
  const followListTruncated =
    followAuthor?.capped === true || followAuthor?.relayHintTruncated === true
  const followedOrganizerSet = new Set(followedOrganizers)
  const readCollectionCandidates =
    testOverrides.readCollectionCandidates ??
    readEventMarketCollectionCandidates
  const candidateRead =
    followedOrganizers.length === 0
      ? ({
          events: [],
          eventSourceRelayUrls: {},
          relays: [],
          eventsVerified: true,
          plannedRelayCount: 0,
          capped: false,
        } satisfies EventMarketCollectionCandidateReadResult)
      : await readCollectionCandidates({
          authenticatedPubkey: input.authenticatedPubkey ?? merchantPubkey,
          nowMs: effectiveNowMs,
          signal: input.signal,
        })
  throwIfAborted(input.signal)
  const resolvedCandidateScanState =
    followedOrganizers.length === 0
      ? "complete"
      : candidateScanState(candidateRead)
  const candidateFrontier = collectionCandidateFrontier({
    read: candidateRead,
    followedOrganizerPubkeys: followedOrganizerSet,
  })
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
    followListTruncated ||
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
        !followedOrganizerSet.has(organizerPubkey) ||
        !candidateCoordinates.has(market.reference)
      ) {
        continue
      }
      if (calendarEndMs !== undefined && calendarEndMs <= effectiveNowMs) {
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
        market.state !== "partial" &&
        market.state !== "stale"
      ) {
        continue
      }
      if (market.state === "partial" || market.state === "stale") {
        hasDegradedMarket = true
      }
      marketsByCoordinate.set(market.reference, market)
    }
  }

  const markets = sortCurrentMarkets(marketsByCoordinate.values())
  const followListCoverage = followAuthor?.coverage ?? "unavailable"
  return {
    markets,
    state: resultState({
      marketCount: markets.length,
      followCoverage: followListCoverage,
      hasFollowSnapshot: !!followAuthor?.event,
      candidateScanState: resolvedCandidateScanState,
      organizerReads,
      truncated,
      hasDegradedMarket,
    }),
    followListCoverage,
    followedOrganizerCount: followedOrganizers.length,
    candidateCollectionCount: candidateFrontier.candidateCollectionCount,
    candidateScanState: resolvedCandidateScanState,
    searchedOrganizerCount,
    failedOrganizerCount: organizerReads.filter(readIsUnavailable).length,
    boundedOrganizerCount,
    truncated,
    followListEventObserved: !!followAuthor?.event,
    followListSnapshotState: followAuthor?.snapshotState ?? "none",
  }
}
