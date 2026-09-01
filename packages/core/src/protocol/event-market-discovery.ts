import {
  EventMarketDiscoveryBoundError,
  getOrganizerEventMarketsDetailed,
  type EventMarketResolution,
  type OrganizerEventMarketsReadResult,
} from "./event-market"
import {
  extractFollowPubkeys,
  readLatestFollowLists,
  type FollowListCoverageState,
  type FollowListReadResult,
} from "./follows"

/**
 * Client execution-safety budget for one followed-organizer event feed read.
 * This is not a Nostr or Open Markets protocol limit. A larger follow list is
 * reported as a partial view and direct event imports remain available.
 */
export const FOLLOWED_EVENT_MARKET_ORGANIZER_LIMIT = 16
const FOLLOWED_EVENT_MARKET_READ_CONCURRENCY = 4
const FOLLOWED_EVENT_MARKET_READ_DEADLINE_MS = 20_000

export type FollowedEventMarketDiscoveryState =
  "complete" | "complete_empty" | "partial" | "unavailable"

export interface FollowedEventMarketDiscoveryResult {
  markets: EventMarketResolution[]
  state: FollowedEventMarketDiscoveryState
  followListCoverage: FollowListCoverageState
  followedOrganizerCount: number
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
  nowMs?: number
  signal?: AbortSignal
}

interface FollowedEventMarketDiscoveryTestOverrides {
  readFollowLists?: typeof readLatestFollowLists
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

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
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
  organizerReads: readonly PromiseSettledResult<OrganizerEventMarketsReadResult>[]
  truncated: boolean
  hasDegradedMarket: boolean
}): FollowedEventMarketDiscoveryState {
  const allOrganizerReadsUnavailable =
    input.organizerReads.length > 0 &&
    input.organizerReads.every(readIsUnavailable)
  if (
    (input.followCoverage === "unavailable" && !input.hasFollowSnapshot) ||
    (input.marketCount === 0 && allOrganizerReadsUnavailable)
  ) {
    return "unavailable"
  }

  const organizerReadsComplete = input.organizerReads.every(
    (read) => read.status === "fulfilled" && read.value.state === "complete"
  )
  const complete =
    input.followCoverage === "complete" &&
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
      searchedOrganizerCount: 0,
      failedOrganizerCount: 0,
      boundedOrganizerCount: 0,
      truncated: false,
      followListEventObserved: false,
      followListSnapshotState: "none",
    }
  }

  throwIfAborted(input.signal)
  const readFollowLists = testOverrides.readFollowLists ?? readLatestFollowLists
  const followRead: FollowListReadResult = await readFollowLists(
    {
      pubkeys: [merchantPubkey],
      authenticatedPubkey: input.authenticatedPubkey ?? merchantPubkey,
    },
    {
      signal: input.signal,
      ...(input.nowMs !== undefined ? { now: () => input.nowMs! } : {}),
    }
  )
  throwIfAborted(input.signal)

  const followAuthor = followRead.authors.find(
    (candidate) => candidate.pubkey === merchantPubkey
  )
  const followedOrganizers = extractFollowPubkeys(followAuthor?.event?.tags)
    .filter((pubkey) => pubkey !== merchantPubkey)
    .sort()
  const selectedOrganizers = followedOrganizers.slice(
    0,
    FOLLOWED_EVENT_MARKET_ORGANIZER_LIMIT
  )
  const followListTruncated =
    followedOrganizers.length > FOLLOWED_EVENT_MARKET_ORGANIZER_LIMIT ||
    followAuthor?.capped === true ||
    followAuthor?.relayHintTruncated === true
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
      index < selectedOrganizers.length;
      index += FOLLOWED_EVENT_MARKET_READ_CONCURRENCY
    ) {
      throwIfAborted(input.signal)
      if (deadlineReached) break
      const batch = selectedOrganizers.slice(
        index,
        index + FOLLOWED_EVENT_MARKET_READ_CONCURRENCY
      )
      searchedOrganizerCount += batch.length
      const completed = new Map<
        number,
        PromiseSettledResult<OrganizerEventMarketsReadResult>
      >()
      const reads = batch.map(async (organizerPubkey, batchIndex) => {
        let result: PromiseSettledResult<OrganizerEventMarketsReadResult>
        try {
          result = {
            status: "fulfilled",
            value: await readOrganizerMarkets({
              organizerPubkey,
              authenticatedPubkey: input.authenticatedPubkey ?? merchantPubkey,
              nowMs: input.nowMs,
              projection: "discovery",
              signal: organizerController.signal,
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
        if (outcome.reason === "caller") throwIfAborted(input.signal)
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
  throwIfAborted(input.signal)

  const boundedOrganizerCount = organizerReads.filter(
    (read) => read.status === "rejected" && isBoundedDiscoveryError(read.reason)
  ).length
  const truncated =
    followListTruncated ||
    boundedOrganizerCount > 0 ||
    deadlineReached ||
    searchedOrganizerCount < selectedOrganizers.length

  const selectedOrganizerSet = new Set(selectedOrganizers)
  const marketsByCoordinate = new Map<string, EventMarketResolution>()
  let hasDegradedMarket = false
  for (const read of organizerReads) {
    if (read.status !== "fulfilled") continue
    for (const market of read.value.markets) {
      const organizerPubkey = normalizePubkey(market.organizerPubkey)
      if (
        !organizerPubkey ||
        !selectedOrganizerSet.has(organizerPubkey) ||
        (market.state !== "active" &&
          market.state !== "partial" &&
          market.state !== "stale")
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
      organizerReads,
      truncated,
      hasDegradedMarket,
    }),
    followListCoverage,
    followedOrganizerCount: followedOrganizers.length,
    searchedOrganizerCount,
    failedOrganizerCount: organizerReads.filter(readIsUnavailable).length,
    boundedOrganizerCount,
    truncated,
    followListEventObserved: !!followAuthor?.event,
    followListSnapshotState: followAuthor?.snapshotState ?? "none",
  }
}
