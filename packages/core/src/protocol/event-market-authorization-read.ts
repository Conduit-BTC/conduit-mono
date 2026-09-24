import type { NDKFilter, NDKKind } from "@nostr-dev-kit/ndk"
import { db, type CachedEventMarketRosterEvidence } from "../db"
import {
  getEventMarketReadPlan,
  parseAddressableCoordinate,
  type EventMarketReadPlan,
} from "./event-market"
import {
  parseEventMarketAuthorizationEvent,
  resolveEventMarketAuthorization,
  type EventMarketAuthorizationResolution,
} from "./event-market-authorization"
import { EVENT_KINDS } from "./kinds"
import { fetchEventsFanoutDetailed, type FetchEventsFanoutOptions } from "./ndk"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

export interface EventMarketAuthorizationReadResult {
  marketCoordinate: string
  merchantPubkey: string
  resolution: EventMarketAuthorizationResolution
  coverage: "complete" | "partial" | "stale" | "unavailable"
  retained: boolean
  actionable: boolean
  /** Exact retained observations used in this reduction, for order evidence custody. */
  observedEvidence: SignedPublicNostrEvent[]
}

type Fanout = {
  events: SignedPublicNostrEvent[]
  relays: Array<{ relayUrl: string; status: "success" | "partial" | "failed" }>
}
export interface EventMarketAuthorizationReadDependencies {
  plan: typeof getEventMarketReadPlan
  fetch: (
    filter: NDKFilter,
    options: FetchEventsFanoutOptions
  ) => Promise<Fanout>
  load: (coordinate: string) => Promise<SignedPublicNostrEvent[]>
  retain: (
    coordinate: string,
    events: readonly SignedPublicNostrEvent[]
  ) => Promise<void>
}

async function fetchSigned(
  filter: NDKFilter,
  options: FetchEventsFanoutOptions
): Promise<Fanout> {
  const result = await fetchEventsFanoutDetailed(filter, options)
  return {
    events: result.events.map(
      (event) => event.rawEvent() as SignedPublicNostrEvent
    ),
    relays: result.relays,
  }
}
async function loadRetained(
  coordinate: string
): Promise<SignedPublicNostrEvent[]> {
  const rows = await db.eventMarketRosterEvidence
    .where("marketCoordinate")
    .equals(coordinate)
    .toArray()
  return rows
    .map((row) => row.signedEvent)
    .filter(isValidSignedPublicNostrEvent)
}
async function retainSigned(
  coordinate: string,
  events: readonly SignedPublicNostrEvent[]
): Promise<void> {
  if (events.length === 0) return
  const unique = [...new Map(events.map((event) => [event.id, event])).values()]
  const rows: CachedEventMarketRosterEvidence[] = unique.map((event) => ({
    id: `${coordinate}:${event.id}`,
    marketCoordinate: coordinate,
    signedEvent: event,
    cachedAt: Date.now(),
  }))
  await db.transaction("rw", db.eventMarketRosterEvidence, async () => {
    const existing = await db.eventMarketRosterEvidence
      .where("marketCoordinate")
      .equals(coordinate)
      .count()
    const old = await db.eventMarketRosterEvidence.bulkGet(
      rows.map((row) => row.id)
    )
    if (existing + old.filter((row) => !row).length > 2_048)
      throw new Error("Event Market authorization retention is at capacity.")
    await db.eventMarketRosterEvidence.bulkPut(rows)
  })
}
const defaults: EventMarketAuthorizationReadDependencies = {
  plan: getEventMarketReadPlan,
  fetch: fetchSigned,
  load: loadRetained,
  retain: retainSigned,
}
function options(
  plan: EventMarketReadPlan,
  input: {
    authenticatedPubkey?: string | null
    shouldContinue?: () => boolean
    signal?: AbortSignal
  }
): FetchEventsFanoutOptions {
  return {
    relayUrls: plan.candidateRelayUrls,
    maxRelayAttempts: plan.maxRelayAttempts,
    accountPubkey: input.authenticatedPubkey,
    authenticatedPubkey: input.authenticatedPubkey,
    ownerSelectedRelayUrls: plan.ownerSelectedRelayUrls,
    appRelayUrls: plan.appRelayUrls,
    personalRelayUrls: plan.personalRelayUrls,
    independentRelayUrls: plan.independentRelayUrls,
    shouldContinue: input.shouldContinue,
    signal: input.signal,
  }
}

/** Union live and retained organizer evidence; a stale relay cannot erase a revoke or fork. */
export async function readEventMarketAuthorization(
  input: {
    marketCoordinate: string
    merchantPubkey: string
    authenticatedPubkey?: string | null
    shouldContinue?: () => boolean
    signal?: AbortSignal
  },
  dependencies: EventMarketAuthorizationReadDependencies = defaults
): Promise<EventMarketAuthorizationReadResult> {
  const market = parseAddressableCoordinate(input.marketCoordinate, [
    EVENT_KINDS.EVENT_MARKET,
  ])
  if (!market || !/^[0-9a-f]{64}$/.test(input.merchantPubkey)) {
    return {
      marketCoordinate: input.marketCoordinate,
      merchantPubkey: input.merchantPubkey,
      resolution: { state: "invalid_reference" },
      coverage: "unavailable",
      retained: false,
      actionable: false,
      observedEvidence: [],
    }
  }
  const coordinate = market.coordinate
  let retained = true
  let cached: SignedPublicNostrEvent[] = []
  try {
    cached = await dependencies.load(coordinate)
  } catch {
    retained = false
  }
  const relevant = (
    event: SignedPublicNostrEvent,
    knownIds: ReadonlySet<string>
  ): boolean =>
    event.pubkey === market.authorPubkey &&
    isValidSignedPublicNostrEvent(event) &&
    (event.kind === EVENT_KINDS.EVENT_MARKET_AUTH
      ? event.tags.some((tag) => tag[0] === "a" && tag[1] === coordinate) &&
        event.tags.some(
          (tag) => tag[0] === "p" && tag[1] === input.merchantPubkey
        )
      : event.kind === EVENT_KINDS.DELETION &&
        (event.tags.some(
          (tag) => tag[0] === "e" && knownIds.has(tag[1] ?? "")
        ) ||
          (event.tags.some((tag) => tag[0] === "a" && tag[1] === coordinate) &&
            event.tags.some(
              (tag) => tag[0] === "p" && tag[1] === input.merchantPubkey
            ))))
  const cachedIds = new Set(
    cached
      .filter((event) => event.kind === EVENT_KINDS.EVENT_MARKET_AUTH)
      .map((event) => event.id)
  )
  cached = cached.filter((event) => relevant(event, cachedIds))
  let plan: EventMarketReadPlan
  try {
    plan = await dependencies.plan({
      organizerPubkey: market.authorPubkey,
      authenticatedPubkey: input.authenticatedPubkey,
      shouldContinue: input.shouldContinue,
      signal: input.signal,
    })
  } catch (error) {
    if (input.signal?.aborted || input.shouldContinue?.() === false) throw error
    return {
      marketCoordinate: coordinate,
      merchantPubkey: input.merchantPubkey,
      resolution: resolveEventMarketAuthorization({
        marketCoordinate: coordinate,
        merchantPubkey: input.merchantPubkey,
        transitions: cached,
        deletions: cached,
      }),
      coverage: "unavailable",
      retained,
      actionable: false,
      observedEvidence: cached,
    }
  }
  const fetch = async (filter: NDKFilter): Promise<Fanout> => {
    try {
      return await dependencies.fetch(filter, options(plan, input))
    } catch (error) {
      if (input.signal?.aborted || input.shouldContinue?.() === false)
        throw error
      return { events: [], relays: [] }
    }
  }
  const [transitions, scopedDeletions] = await Promise.all([
    fetch({
      kinds: [EVENT_KINDS.EVENT_MARKET_AUTH as NDKKind],
      authors: [market.authorPubkey],
      "#a": [coordinate],
      "#p": [input.merchantPubkey],
      limit: 256,
    }),
    fetch({
      kinds: [EVENT_KINDS.DELETION],
      authors: [market.authorPubkey],
      "#a": [coordinate],
      "#p": [input.merchantPubkey],
      limit: 128,
    }),
  ])
  const candidate = [
    ...new Map(
      [...cached, ...transitions.events]
        .filter((event) => relevant(event, cachedIds))
        .map((event) => [event.id, event])
    ).values(),
  ]
  const transitionMap = new Map(candidate.map((event) => [event.id, event]))
  const parentReads: Fanout[] = []
  const attempted = new Set<string>()
  for (let depth = 0; depth < 128; depth++) {
    const missingParents = new Set(
      [...transitionMap.values()]
        .flatMap(
          (event) => parseEventMarketAuthorizationEvent(event)?.parentIds ?? []
        )
        .filter((id) => !transitionMap.has(id) && !attempted.has(id))
    )
    if (missingParents.size === 0) break
    const idsToRead = [...missingParents].slice(0, 64)
    idsToRead.forEach((id) => attempted.add(id))
    const read = await fetch({
      kinds: [EVENT_KINDS.EVENT_MARKET_AUTH as NDKKind],
      authors: [market.authorPubkey],
      ids: idsToRead,
      limit: 64,
    })
    parentReads.push(read)
    for (const event of read.events) {
      if (relevant(event, cachedIds) && idsToRead.includes(event.id))
        transitionMap.set(event.id, event)
    }
  }
  const allTransitions = [...transitionMap.values()]
  const ids = new Set(allTransitions.map((event) => event.id))
  const exactDeletionReads: Fanout[] = []
  const targetIds = [...ids]
  for (let offset = 0; offset < targetIds.length; offset += 32) {
    exactDeletionReads.push(
      await fetch({
        kinds: [EVENT_KINDS.DELETION],
        authors: [market.authorPubkey],
        "#e": targetIds.slice(offset, offset + 32),
        limit: 128,
      })
    )
  }
  const reads = [
    transitions,
    scopedDeletions,
    ...parentReads,
    ...exactDeletionReads,
  ]
  const live = [
    ...new Map(
      reads
        .flatMap((read) => read.events)
        .filter((event) => relevant(event, ids))
        .map((event) => [event.id, event])
    ).values(),
  ]
  try {
    await dependencies.retain(coordinate, live)
  } catch {
    retained = false
  }
  const all = [
    ...new Map([...cached, ...live].map((event) => [event.id, event])).values(),
  ]
  const resolution = resolveEventMarketAuthorization({
    marketCoordinate: coordinate,
    merchantPubkey: input.merchantPubkey,
    transitions: all.filter(
      (event) => event.kind === EVENT_KINDS.EVENT_MARKET_AUTH
    ),
    deletions: all.filter((event) => event.kind === EVENT_KINDS.DELETION),
  })
  const liveIds = new Set(live.map((event) => event.id))
  const requiredIds =
    resolution.state === "active" || resolution.state === "revoked"
      ? resolution.ancestry.map((event) => event.eventId)
      : []
  const stale =
    requiredIds.some((id) => !liveIds.has(id)) ||
    cached.some(
      (event) => event.kind === EVENT_KINDS.DELETION && !liveIds.has(event.id)
    )
  const relayStates = reads.flatMap((read) => read.relays)
  const incomplete =
    !retained ||
    plan.relayHintTruncated ||
    attempted.size > 128 ||
    ids.size > 256 ||
    transitions.events.length >= 256 ||
    scopedDeletions.events.length >= 128 ||
    exactDeletionReads.some((read) => read.events.length >= 128) ||
    reads.some((read) => read.relays.length === 0) ||
    relayStates.some((relay) => relay.status !== "success")
  const coverage = stale
    ? "stale"
    : relayStates.length === 0 ||
        relayStates.every((relay) => relay.status === "failed")
      ? "unavailable"
      : incomplete
        ? "partial"
        : "complete"
  return {
    marketCoordinate: coordinate,
    merchantPubkey: input.merchantPubkey,
    resolution,
    coverage,
    retained,
    actionable:
      resolution.state === "active" && retained && coverage === "complete",
    observedEvidence: all,
  }
}
