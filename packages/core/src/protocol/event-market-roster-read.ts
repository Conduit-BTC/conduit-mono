import type { NDKFilter, NDKKind } from "@nostr-dev-kit/ndk"
import {
  readEventMarketAuthorization,
  type EventMarketAuthorizationReadResult,
} from "./event-market-authorization-read"
import { db, type CachedEventMarketRosterEvidence } from "../db"
import {
  orderEventMarketPickupFulfillmentSchema,
  type OrderEventMarketPickupFulfillmentSchema,
} from "../schemas"
import {
  decodeEventMarketReference,
  getEventMarketReadPlan,
  isEventMarketAddressableRevisionDeleted,
  parseAddressableCoordinate,
  type EventMarketReadPlan,
  type ParsedEventMarketCalendar,
} from "./event-market"
import {
  getEventMarketCandidateFilters,
  resolveEventMarketCalendar,
  resolveEventMarketProduct,
  resolveEventMarketRoster,
  type EventMarketProductResolution,
  type EventMarketRosterResolution,
} from "./event-market-roster"
import { EVENT_KINDS } from "./kinds"
import { parseProductEvent } from "./products"
import { fetchEventsFanoutDetailed, type FetchEventsFanoutOptions } from "./ndk"
import {
  compareReplaceableEventFrontiers,
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

export type EventMarketRosterReadCoverage =
  "complete" | "partial" | "stale" | "unavailable"

export interface EventMarketRosterReadResult {
  coordinate: string
  resolution: EventMarketRosterResolution
  coverage: EventMarketRosterReadCoverage
  retained: boolean
  observedRelayUrls: string[]
  calendar?: ParsedEventMarketCalendar | null
  calendarCoverage?: EventMarketRosterReadCoverage
}

export interface EventMarketProductReadResult {
  productCoordinate: string
  resolution: EventMarketProductResolution | { state: "market_unavailable" }
  coverage: EventMarketRosterReadCoverage
  retained: boolean
  actionable: boolean
  authorization?: EventMarketAuthorizationReadResult
}

export interface EventMarketCatalogReadResult {
  marketRead: EventMarketRosterReadResult
  products: EventMarketProductReadResult[]
  coverage: EventMarketRosterReadCoverage
  candidateCount: number
}

/** Freeze exact signed participation terms before adding a future-event cart line. */
export function createEventMarketPickupSnapshot(input: {
  marketRead: EventMarketRosterReadResult
  productRead: EventMarketProductReadResult
}): OrderEventMarketPickupFulfillmentSchema {
  const market = input.marketRead.resolution
  const product = input.productRead.resolution
  const calendar = input.marketRead.calendar
  const authorization = input.productRead.authorization?.resolution
  if (
    market.state !== "current" ||
    market.market.state !== "open" ||
    !calendar ||
    product.state !== "eligible" ||
    authorization?.state !== "active" ||
    !input.productRead.actionable ||
    product.product.id !== input.productRead.productCoordinate
  ) {
    throw new Error("Current signed Event Market participation is required.")
  }
  return orderEventMarketPickupFulfillmentSchema.parse({
    type: "event_market_pickup",
    organizerPubkey: market.market.organizerPubkey,
    merchantPubkey: product.merchant.pubkey,
    payeePubkey: product.merchant.pubkey,
    market: {
      coordinate: market.market.coordinate,
      eventId: market.market.eventId,
      createdAt: market.market.createdAt * 1_000,
    },
    calendar: {
      coordinate: calendar.coordinate,
      eventId: calendar.eventId,
      createdAt: calendar.createdAt,
      start: calendar.start,
      end: calendar.end,
    },
    product: {
      coordinate: input.productRead.productCoordinate,
      eventId: product.revision.id,
      createdAt: product.revision.created_at * 1_000,
    },
    grant: {
      kind: EVENT_KINDS.EVENT_MARKET_AUTH,
      pubkey: market.market.organizerPubkey,
      eventId: authorization.tip.eventId,
      createdAt: authorization.tip.signedEvent.created_at * 1_000,
      ancestryEventIds: authorization.ancestry.map((event) => event.eventId),
      observedDeletionEventIds:
        input.productRead.authorization?.observedEvidence
          ?.filter((event) => event.kind === EVENT_KINDS.DELETION)
          .map((event) => event.id) ?? [],
      signedEvidence: {
        tip: authorization.tip.signedEvent,
        ancestry: authorization.ancestry.map((event) => event.signedEvent),
        deletions:
          input.productRead.authorization?.observedEvidence?.filter(
            (event) => event.kind === EVENT_KINDS.DELETION
          ) ?? [],
      },
    },
    mode: product.merchant.mode,
    assignment: product.merchant.assignment,
  })
}

interface SignedFanoutResult {
  events: SignedPublicNostrEvent[]
  relays: Array<{ relayUrl: string; status: "success" | "partial" | "failed" }>
}

interface RosterReadDependencies {
  plan: typeof getEventMarketReadPlan
  fetch: (
    filter: NDKFilter,
    options: FetchEventsFanoutOptions
  ) => Promise<SignedFanoutResult>
  load: (coordinate: string) => Promise<SignedPublicNostrEvent[]>
  retain: (
    coordinate: string,
    events: readonly SignedPublicNostrEvent[]
  ) => Promise<void>
  authorization?: typeof readEventMarketAuthorization
}

const MAX_RETAINED_MARKET_RECORDS = 2_048

async function fetchSigned(
  filter: NDKFilter,
  options: FetchEventsFanoutOptions
): Promise<SignedFanoutResult> {
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
    .filter((row) => isValidSignedPublicNostrEvent(row.signedEvent))
    .map((row) => row.signedEvent)
}

async function retainSigned(
  coordinate: string,
  events: readonly SignedPublicNostrEvent[]
): Promise<void> {
  if (events.length === 0) return
  const rows: CachedEventMarketRosterEvidence[] = [
    ...new Map(events.map((event) => [event.id, event])).values(),
  ].map((event) => ({
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
    const alreadyStored = await db.eventMarketRosterEvidence.bulkGet(
      rows.map((row) => row.id)
    )
    const newRows = alreadyStored.filter((row) => !row).length
    if (existing + newRows > MAX_RETAINED_MARKET_RECORDS) {
      throw new Error("Event Market evidence retention is at capacity.")
    }
    await db.eventMarketRosterEvidence.bulkPut(rows)
  })
}

/** Persist a signed market, calendar, or authorization event before first relay I/O. */
export async function retainSignedEventMarketEvidence(
  marketCoordinate: string,
  signedEvent: SignedPublicNostrEvent
): Promise<void> {
  const market = parseAddressableCoordinate(marketCoordinate, [
    EVENT_KINDS.EVENT_MARKET,
  ])
  if (
    !market ||
    !isValidSignedPublicNostrEvent(signedEvent) ||
    signedEvent.pubkey !== market.authorPubkey ||
    ![
      EVENT_KINDS.EVENT_MARKET,
      EVENT_KINDS.CALENDAR_DATE,
      EVENT_KINDS.CALENDAR_TIME,
      EVENT_KINDS.EVENT_MARKET_AUTH,
    ].includes(signedEvent.kind as never)
  )
    throw new Error("Signed Event Market evidence is invalid.")
  await retainSigned(market.coordinate, [signedEvent])
}

const defaultDependencies: RosterReadDependencies = {
  plan: getEventMarketReadPlan,
  fetch: fetchSigned,
  load: loadRetained,
  retain: retainSigned,
  authorization: readEventMarketAuthorization,
}

function fanoutOptions(
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

function scopedSignedEvidence(
  coordinate: string,
  organizerPubkey: string,
  events: readonly SignedPublicNostrEvent[],
  knownRevisionIds: ReadonlySet<string>
): SignedPublicNostrEvent[] {
  return events.filter(
    (event) =>
      event.pubkey === organizerPubkey &&
      isValidSignedPublicNostrEvent(event) &&
      (event.kind === EVENT_KINDS.EVENT_MARKET ||
        event.kind === EVENT_KINDS.DELETION) &&
      (event.kind === EVENT_KINDS.EVENT_MARKET
        ? event.tags.some(
            (tag) =>
              tag[0] === "d" &&
              `${EVENT_KINDS.EVENT_MARKET}:${organizerPubkey}:${tag[1]}` ===
                coordinate
          )
        : event.tags.some((tag) => tag[0] === "a" && tag[1] === coordinate) ||
          event.tags.some(
            (tag) => tag[0] === "e" && knownRevisionIds.has(tag[1] ?? "")
          ))
  )
}

function scopedCalendarEvidence(
  calendarCoordinate: string,
  organizerPubkey: string,
  events: readonly SignedPublicNostrEvent[],
  knownRevisionIds: ReadonlySet<string>
): SignedPublicNostrEvent[] {
  return events.filter((event) => {
    if (
      event.pubkey !== organizerPubkey ||
      !isValidSignedPublicNostrEvent(event)
    )
      return false
    if (
      (
        [EVENT_KINDS.CALENDAR_DATE, EVENT_KINDS.CALENDAR_TIME] as number[]
      ).includes(event.kind)
    ) {
      return event.tags.some(
        (tag) =>
          tag[0] === "d" &&
          `${event.kind}:${organizerPubkey}:${tag[1]}` === calendarCoordinate
      )
    }
    return (
      event.kind === EVENT_KINDS.DELETION &&
      (event.tags.some(
        (tag) => tag[0] === "a" && tag[1] === calendarCoordinate
      ) ||
        event.tags.some(
          (tag) => tag[0] === "e" && knownRevisionIds.has(tag[1] ?? "")
        ))
    )
  })
}

function scopedProductEvidence(
  productCoordinate: string,
  merchantPubkey: string,
  events: readonly SignedPublicNostrEvent[],
  knownRevisionIds: ReadonlySet<string>
): SignedPublicNostrEvent[] {
  return events.filter((event) => {
    if (
      event.pubkey !== merchantPubkey ||
      !isValidSignedPublicNostrEvent(event)
    )
      return false
    if (event.kind === EVENT_KINDS.PRODUCT) {
      return event.tags.some(
        (tag) =>
          tag[0] === "d" &&
          `${EVENT_KINDS.PRODUCT}:${merchantPubkey}:${tag[1]}` ===
            productCoordinate
      )
    }
    return (
      event.kind === EVENT_KINDS.DELETION &&
      (event.tags.some(
        (tag) => tag[0] === "a" && tag[1] === productCoordinate
      ) ||
        event.tags.some(
          (tag) => tag[0] === "e" && knownRevisionIds.has(tag[1] ?? "")
        ))
    )
  })
}

/** Read exact organizer authority before any merchant candidate search. */
export async function readEventMarketRoster(
  input: {
    reference: string
    authenticatedPubkey?: string | null
    shouldContinue?: () => boolean
    signal?: AbortSignal
  },
  dependencies: RosterReadDependencies = defaultDependencies
): Promise<EventMarketRosterReadResult> {
  const decoded = decodeEventMarketReference(input.reference, [
    EVENT_KINDS.EVENT_MARKET,
  ])
  if (!decoded) {
    return {
      coordinate: input.reference,
      resolution: { state: "invalid_reference" },
      coverage: "unavailable",
      retained: false,
      observedRelayUrls: [],
    }
  }
  const coordinate = decoded.coordinate
  let retained = true
  let loadedEvents: SignedPublicNostrEvent[] = []
  let retainedEvents: SignedPublicNostrEvent[] = []
  try {
    loadedEvents = await dependencies.load(coordinate)
    retainedEvents = loadedEvents
    const retainedRevisionIds = new Set(
      retainedEvents
        .filter((event) => event.kind === EVENT_KINDS.EVENT_MARKET)
        .map((event) => event.id)
    )
    retainedEvents = scopedSignedEvidence(
      coordinate,
      decoded.authorPubkey,
      retainedEvents,
      retainedRevisionIds
    )
  } catch {
    retained = false
  }
  let plan: EventMarketReadPlan
  try {
    plan = await dependencies.plan({
      organizerPubkey: decoded.authorPubkey,
      relayHints: decoded.relayHints,
      authenticatedPubkey: input.authenticatedPubkey,
      shouldContinue: input.shouldContinue,
      signal: input.signal,
    })
  } catch (error) {
    if (input.signal?.aborted || input.shouldContinue?.() === false) throw error
    return {
      coordinate,
      resolution: resolveEventMarketRoster({
        coordinate,
        revisions: retainedEvents.filter(
          (event) => event.kind === EVENT_KINDS.EVENT_MARKET
        ),
        deletions: retainedEvents.filter(
          (event) => event.kind === EVENT_KINDS.DELETION
        ),
      }),
      coverage: "unavailable",
      retained,
      observedRelayUrls: [],
    }
  }
  const options = fanoutOptions(plan, input)
  const safeFetch = async (filter: NDKFilter): Promise<SignedFanoutResult> => {
    try {
      return await dependencies.fetch(filter, options)
    } catch (error) {
      if (input.signal?.aborted || input.shouldContinue?.() === false)
        throw error
      return { events: [], relays: [] }
    }
  }
  const [rosterRead, coordinateDeletions] = await Promise.all([
    safeFetch({
      kinds: [EVENT_KINDS.EVENT_MARKET as NDKKind],
      authors: [decoded.authorPubkey],
      "#d": [decoded.dTag],
      limit: 64,
    }),
    safeFetch({
      kinds: [EVENT_KINDS.DELETION],
      authors: [decoded.authorPubkey],
      "#a": [coordinate],
      limit: 64,
    }),
  ])
  const knownRevisions = [
    ...new Map(
      [...retainedEvents, ...rosterRead.events]
        .filter((event) => event.kind === EVENT_KINDS.EVENT_MARKET)
        .map((event) => [event.id, event])
    ).values(),
  ].sort(
    (left, right) =>
      -compareReplaceableEventFrontiers(
        { createdAt: left.created_at, eventId: left.id },
        { createdAt: right.created_at, eventId: right.id }
      )
  )
  const knownRevisionIds = new Set(knownRevisions.map((event) => event.id))
  const queriedRevisionIds = knownRevisions
    .slice(0, 32)
    .map((event) => event.id)
  const idDeletions =
    queriedRevisionIds.length > 0
      ? await safeFetch({
          kinds: [EVENT_KINDS.DELETION],
          authors: [decoded.authorPubkey],
          "#e": queriedRevisionIds,
          limit: 64,
        })
      : { events: [], relays: [] }
  const reads = [
    rosterRead,
    coordinateDeletions,
    ...(knownRevisionIds.size > 0 ? [idDeletions] : []),
  ]
  const live = scopedSignedEvidence(
    coordinate,
    decoded.authorPubkey,
    reads.flatMap((read) => read.events),
    knownRevisionIds
  )
  const all = [
    ...new Map(
      [...retainedEvents, ...live].map((event) => [event.id, event])
    ).values(),
  ]
  try {
    await dependencies.retain(coordinate, live)
  } catch {
    retained = false
  }
  const resolution = resolveEventMarketRoster({
    coordinate,
    revisions: all.filter((event) => event.kind === EVENT_KINDS.EVENT_MARKET),
    deletions: all.filter((event) => event.kind === EVENT_KINDS.DELETION),
  })
  const relayStates = reads.flatMap((read) => read.relays)
  const observedRelayUrls = [
    ...new Set(relayStates.map((relay) => relay.relayUrl)),
  ]
  const liveIds = new Set(live.map((event) => event.id))
  const selectedId =
    resolution.state === "current"
      ? resolution.market.eventId
      : "eventId" in resolution
        ? resolution.eventId
        : null
  const stale =
    (selectedId !== null && !liveIds.has(selectedId)) ||
    retainedEvents.some(
      (event) => event.kind === EVENT_KINDS.DELETION && !liveIds.has(event.id)
    )
  const coverage: EventMarketRosterReadCoverage = stale
    ? "stale"
    : relayStates.length === 0 ||
        relayStates.every((relay) => relay.status === "failed")
      ? "unavailable"
      : !retained ||
          knownRevisions.length > 32 ||
          plan.relayHintTruncated ||
          reads.some((read) => read.relays.length === 0) ||
          relayStates.some((relay) => relay.status !== "success") ||
          rosterRead.events.length >= 64 ||
          coordinateDeletions.events.length >= 64 ||
          idDeletions.events.length >= 64
        ? "partial"
        : "complete"
  if (resolution.state !== "current") {
    return { coordinate, resolution, coverage, retained, observedRelayUrls }
  }
  const calendarCoordinate = parseAddressableCoordinate(
    resolution.market.calendarCoordinate,
    [EVENT_KINDS.CALENDAR_DATE, EVENT_KINDS.CALENDAR_TIME]
  )!
  const cachedCalendarIds = new Set(
    loadedEvents
      .filter(
        (event) =>
          event.kind === calendarCoordinate.kind &&
          event.pubkey === decoded.authorPubkey &&
          event.tags.some(
            (tag) => tag[0] === "d" && tag[1] === calendarCoordinate.dTag
          )
      )
      .map((event) => event.id)
  )
  const calendarRetained = scopedCalendarEvidence(
    calendarCoordinate.coordinate,
    decoded.authorPubkey,
    loadedEvents,
    cachedCalendarIds
  )
  const [calendarRead, calendarCoordinateDeletions] = await Promise.all([
    safeFetch({
      kinds: [calendarCoordinate.kind as NDKKind],
      authors: [decoded.authorPubkey],
      "#d": [calendarCoordinate.dTag],
      limit: 64,
    }),
    safeFetch({
      kinds: [EVENT_KINDS.DELETION],
      authors: [decoded.authorPubkey],
      "#a": [calendarCoordinate.coordinate],
      limit: 64,
    }),
  ])
  const calendarKnownRevisions = [
    ...new Map(
      [...calendarRetained, ...calendarRead.events]
        .filter((event) => event.kind === calendarCoordinate.kind)
        .map((event) => [event.id, event])
    ).values(),
  ].sort(
    (left, right) =>
      -compareReplaceableEventFrontiers(
        { createdAt: left.created_at, eventId: left.id },
        { createdAt: right.created_at, eventId: right.id }
      )
  )
  const calendarRevisionIds = new Set(
    calendarKnownRevisions.map((event) => event.id)
  )
  const calendarIdDeletions =
    calendarRevisionIds.size > 0
      ? await safeFetch({
          kinds: [EVENT_KINDS.DELETION],
          authors: [decoded.authorPubkey],
          "#e": calendarKnownRevisions.slice(0, 32).map((event) => event.id),
          limit: 64,
        })
      : { events: [], relays: [] }
  const calendarReads = [
    calendarRead,
    calendarCoordinateDeletions,
    ...(calendarRevisionIds.size > 0 ? [calendarIdDeletions] : []),
  ]
  const liveCalendar = scopedCalendarEvidence(
    calendarCoordinate.coordinate,
    decoded.authorPubkey,
    calendarReads.flatMap((read) => read.events),
    calendarRevisionIds
  )
  try {
    await dependencies.retain(coordinate, liveCalendar)
  } catch {
    retained = false
  }
  const calendarEvidence = [
    ...new Map(
      [...calendarRetained, ...liveCalendar].map((event) => [event.id, event])
    ).values(),
  ]
  const calendar = resolveEventMarketCalendar({
    market: resolution.market,
    revisions: calendarEvidence.filter(
      (event) => event.kind === calendarCoordinate.kind
    ),
    deletions: calendarEvidence.filter(
      (event) => event.kind === EVENT_KINDS.DELETION
    ),
  })
  const calendarRelayStates = calendarReads.flatMap((read) => read.relays)
  const liveCalendarIds = new Set(liveCalendar.map((event) => event.id))
  const latestCalendarRevision = calendarEvidence
    .filter((event) => event.kind === calendarCoordinate.kind)
    .sort(
      (left, right) =>
        -compareReplaceableEventFrontiers(
          { createdAt: left.created_at, eventId: left.id },
          { createdAt: right.created_at, eventId: right.id }
        )
    )[0]
  const calendarStale =
    Boolean(
      latestCalendarRevision && !liveCalendarIds.has(latestCalendarRevision.id)
    ) ||
    calendarRetained.some(
      (event) =>
        event.kind === EVENT_KINDS.DELETION && !liveCalendarIds.has(event.id)
    )
  const calendarCoverage: EventMarketRosterReadCoverage = calendarStale
    ? "stale"
    : calendarRelayStates.length === 0 ||
        calendarRelayStates.every((relay) => relay.status === "failed")
      ? "unavailable"
      : !retained ||
          calendarRevisionIds.size > 32 ||
          plan.relayHintTruncated ||
          calendarReads.some((read) => read.relays.length === 0) ||
          calendarRelayStates.some((relay) => relay.status !== "success") ||
          calendarRead.events.length >= 64 ||
          calendarCoordinateDeletions.events.length >= 64 ||
          calendarIdDeletions.events.length >= 64
        ? "partial"
        : "complete"
  return {
    coordinate,
    resolution,
    coverage,
    retained,
    observedRelayUrls: [
      ...new Set([
        ...observedRelayUrls,
        ...calendarRelayStates.map((relay) => relay.relayUrl),
      ]),
    ],
    calendar,
    calendarCoverage,
  }
}

/** Exact product read for both catalog candidates and direct product links. */
export async function readEventMarketProduct(
  input: {
    marketRead: EventMarketRosterReadResult
    productCoordinate: string
    authenticatedPubkey?: string | null
    shouldContinue?: () => boolean
    signal?: AbortSignal
  },
  dependencies: RosterReadDependencies = defaultDependencies
): Promise<EventMarketProductReadResult> {
  const market = input.marketRead.resolution
  const product = parseAddressableCoordinate(input.productCoordinate, [
    EVENT_KINDS.PRODUCT,
  ])
  if (market.state !== "current" || !product || !input.marketRead.calendar) {
    return {
      productCoordinate: input.productCoordinate,
      resolution: { state: "market_unavailable" },
      coverage: "unavailable",
      retained: input.marketRead.retained,
      actionable: false,
    }
  }
  if (
    !market.market.merchants.some((row) => row.pubkey === product.authorPubkey)
  ) {
    return {
      productCoordinate: product.coordinate,
      resolution: { state: "unapproved" },
      coverage: input.marketRead.coverage,
      retained: input.marketRead.retained,
      actionable: false,
    }
  }
  const readAuthorization =
    dependencies.authorization ??
    ((query: Parameters<typeof readEventMarketAuthorization>[0]) =>
      readEventMarketAuthorization(query, {
        plan: dependencies.plan,
        fetch: dependencies.fetch,
        load: dependencies.load,
        retain: dependencies.retain,
      }))
  const authorization = await readAuthorization({
    marketCoordinate: market.market.coordinate,
    merchantPubkey: product.authorPubkey,
    authenticatedPubkey: input.authenticatedPubkey,
    shouldContinue: input.shouldContinue,
    signal: input.signal,
  })
  if (authorization.resolution.state !== "active") {
    return {
      productCoordinate: product.coordinate,
      resolution: { state: "unauthorized" },
      coverage: authorization.coverage,
      retained: authorization.retained,
      actionable: false,
      authorization,
    }
  }
  let retained = input.marketRead.retained
  let loaded: SignedPublicNostrEvent[] = []
  try {
    loaded = await dependencies.load(market.market.coordinate)
  } catch {
    retained = false
  }
  const cachedRevisionIds = new Set(
    loaded
      .filter(
        (event) =>
          event.kind === EVENT_KINDS.PRODUCT &&
          event.pubkey === product.authorPubkey &&
          event.tags.some((tag) => tag[0] === "d" && tag[1] === product.dTag)
      )
      .map((event) => event.id)
  )
  const cached = scopedProductEvidence(
    product.coordinate,
    product.authorPubkey,
    loaded,
    cachedRevisionIds
  )
  let plan: EventMarketReadPlan
  try {
    plan = await dependencies.plan({
      organizerPubkey: product.authorPubkey,
      authenticatedPubkey: input.authenticatedPubkey,
      shouldContinue: input.shouldContinue,
      signal: input.signal,
    })
  } catch (error) {
    if (input.signal?.aborted || input.shouldContinue?.() === false) throw error
    const resolution = resolveEventMarketProduct({
      market: market.market,
      productCoordinate: product.coordinate,
      revisions: cached.filter((event) => event.kind === EVENT_KINDS.PRODUCT),
      deletions: cached.filter((event) => event.kind === EVENT_KINDS.DELETION),
      authorization: authorization.resolution,
    })
    return {
      productCoordinate: product.coordinate,
      resolution,
      coverage: "unavailable",
      retained,
      actionable: false,
      authorization,
    }
  }
  const options = fanoutOptions(plan, input)
  const safeFetch = async (filter: NDKFilter): Promise<SignedFanoutResult> => {
    try {
      return await dependencies.fetch(filter, options)
    } catch (error) {
      if (input.signal?.aborted || input.shouldContinue?.() === false)
        throw error
      return { events: [], relays: [] }
    }
  }
  const [revisionRead, coordinateDeletions] = await Promise.all([
    safeFetch({
      kinds: [EVENT_KINDS.PRODUCT],
      authors: [product.authorPubkey],
      "#d": [product.dTag],
      limit: 64,
    }),
    safeFetch({
      kinds: [EVENT_KINDS.DELETION],
      authors: [product.authorPubkey],
      "#a": [product.coordinate],
      limit: 64,
    }),
  ])
  const knownRevisions = [
    ...new Map(
      [...cached, ...revisionRead.events]
        .filter((event) => event.kind === EVENT_KINDS.PRODUCT)
        .map((event) => [event.id, event])
    ).values(),
  ].sort(
    (left, right) =>
      -compareReplaceableEventFrontiers(
        { createdAt: left.created_at, eventId: left.id },
        { createdAt: right.created_at, eventId: right.id }
      )
  )
  const knownIds = new Set(knownRevisions.map((event) => event.id))
  const idDeletions =
    knownIds.size > 0
      ? await safeFetch({
          kinds: [EVENT_KINDS.DELETION],
          authors: [product.authorPubkey],
          "#e": knownRevisions.slice(0, 32).map((event) => event.id),
          limit: 64,
        })
      : { events: [], relays: [] }
  const reads = [
    revisionRead,
    coordinateDeletions,
    ...(knownIds.size > 0 ? [idDeletions] : []),
  ]
  const live = scopedProductEvidence(
    product.coordinate,
    product.authorPubkey,
    reads.flatMap((read) => read.events),
    knownIds
  )
  try {
    await dependencies.retain(market.market.coordinate, live)
  } catch {
    retained = false
  }
  const all = [
    ...new Map([...cached, ...live].map((event) => [event.id, event])).values(),
  ]
  const resolution = resolveEventMarketProduct({
    market: market.market,
    productCoordinate: product.coordinate,
    revisions: all.filter((event) => event.kind === EVENT_KINDS.PRODUCT),
    deletions: all.filter((event) => event.kind === EVENT_KINDS.DELETION),
    authorization: authorization.resolution,
  })
  const liveIds = new Set(live.map((event) => event.id))
  const stale =
    (knownRevisions[0] && !liveIds.has(knownRevisions[0].id)) ||
    cached.some(
      (event) => event.kind === EVENT_KINDS.DELETION && !liveIds.has(event.id)
    )
  const relayStates = reads.flatMap((read) => read.relays)
  const coverage: EventMarketRosterReadCoverage = stale
    ? "stale"
    : relayStates.length === 0 ||
        relayStates.every((relay) => relay.status === "failed")
      ? "unavailable"
      : !retained ||
          knownRevisions.length > 32 ||
          plan.relayHintTruncated ||
          reads.some((read) => read.relays.length === 0) ||
          relayStates.some((relay) => relay.status !== "success") ||
          revisionRead.events.length >= 64 ||
          coordinateDeletions.events.length >= 64 ||
          idDeletions.events.length >= 64
        ? "partial"
        : "complete"
  return {
    productCoordinate: product.coordinate,
    resolution,
    coverage,
    retained,
    authorization,
    actionable:
      resolution.state === "eligible" &&
      authorization.actionable &&
      market.market.state === "open" &&
      retained &&
      coverage === "complete" &&
      input.marketRead.coverage === "complete" &&
      input.marketRead.calendarCoverage === "complete" &&
      input.marketRead.retained,
  }
}

/** Discover only approved authors, then resolve each candidate's exact signed head. */
export async function readEventMarketCatalog(
  input: {
    reference: string
    authenticatedPubkey?: string | null
    shouldContinue?: () => boolean
    signal?: AbortSignal
  },
  dependencies: RosterReadDependencies = defaultDependencies
): Promise<EventMarketCatalogReadResult> {
  const marketRead = await readEventMarketRoster(input, dependencies)
  if (marketRead.resolution.state !== "current" || !marketRead.calendar) {
    return {
      marketRead,
      products: [],
      coverage: marketRead.coverage,
      candidateCount: 0,
    }
  }
  const market = marketRead.resolution.market
  const approved = new Set(market.merchants.map((row) => row.pubkey))
  const candidates = new Set<string>()
  let incomplete =
    marketRead.coverage !== "complete" ||
    marketRead.calendarCoverage !== "complete"
  const filters = getEventMarketCandidateFilters(market)
  // One author per read gives each merchant's NIP-65 outbox a chance to contribute.
  // A capped result is incomplete evidence, never proof that other products are absent.
  candidateSearch: for (const filter of filters) {
    for (const author of filter.authors) {
      if (candidates.size >= 256) {
        incomplete = true
        break candidateSearch
      }
      let plan: EventMarketReadPlan
      try {
        plan = await dependencies.plan({
          organizerPubkey: author,
          authenticatedPubkey: input.authenticatedPubkey,
          shouldContinue: input.shouldContinue,
          signal: input.signal,
        })
      } catch (error) {
        if (input.signal?.aborted || input.shouldContinue?.() === false)
          throw error
        incomplete = true
        continue
      }
      let result: SignedFanoutResult
      try {
        result = await dependencies.fetch(
          { ...filter, authors: [author], limit: 64 },
          fanoutOptions(plan, input)
        )
      } catch (error) {
        if (input.signal?.aborted || input.shouldContinue?.() === false)
          throw error
        incomplete = true
        continue
      }
      if (
        plan.relayHintTruncated ||
        result.events.length >= 64 ||
        result.relays.length === 0 ||
        result.relays.some((relay) => relay.status !== "success")
      )
        incomplete = true
      for (const event of result.events) {
        if (
          event.kind !== EVENT_KINDS.PRODUCT ||
          event.pubkey !== author ||
          !approved.has(author) ||
          !isValidSignedPublicNostrEvent(event) ||
          !event.tags.some(
            (tag) => tag[0] === "a" && tag[1] === market.coordinate
          )
        )
          continue
        const dTags = event.tags.filter((tag) => tag[0] === "d")
        if (dTags.length !== 1 || !dTags[0]?.[1]) continue
        candidates.add(`${EVENT_KINDS.PRODUCT}:${author}:${dTags[0][1]}`)
      }
    }
  }
  const products: EventMarketProductReadResult[] = []
  for (const productCoordinate of candidates) {
    const read = await readEventMarketProduct(
      { ...input, marketRead, productCoordinate },
      dependencies
    )
    if (
      read.coverage !== "complete" ||
      (read.authorization &&
        (read.authorization.coverage !== "complete" ||
          !read.authorization.retained))
    )
      incomplete = true
    if (read.resolution.state === "eligible") products.push(read)
  }
  return {
    marketRead,
    products,
    coverage: incomplete ? "partial" : "complete",
    candidateCount: candidates.size,
  }
}

/** Bounded organizer-scoped discovery for Market and Merchant timelines. */
export async function discoverFutureEventMarkets(
  input: {
    organizerPubkeys: readonly string[]
    authenticatedPubkey?: string | null
    shouldContinue?: () => boolean
    signal?: AbortSignal
  },
  dependencies: RosterReadDependencies = defaultDependencies
): Promise<{
  markets: EventMarketRosterReadResult[]
  coverage: EventMarketRosterReadCoverage
}> {
  const authors = [
    ...new Set(
      input.organizerPubkeys.filter((value) => /^[0-9a-f]{64}$/.test(value))
    ),
  ].slice(0, 64)
  const coordinates = new Set<string>()
  let incomplete = input.organizerPubkeys.length > 64
  for (const author of authors) {
    let plan: EventMarketReadPlan
    try {
      plan = await dependencies.plan({
        organizerPubkey: author,
        authenticatedPubkey: input.authenticatedPubkey,
        shouldContinue: input.shouldContinue,
        signal: input.signal,
      })
    } catch (error) {
      if (input.signal?.aborted || input.shouldContinue?.() === false)
        throw error
      incomplete = true
      continue
    }
    try {
      const result = await dependencies.fetch(
        {
          kinds: [EVENT_KINDS.EVENT_MARKET as NDKKind],
          authors: [author],
          limit: 128,
        },
        fanoutOptions(plan, input)
      )
      if (
        plan.relayHintTruncated ||
        result.events.length >= 128 ||
        result.relays.length === 0 ||
        result.relays.some((relay) => relay.status !== "success")
      )
        incomplete = true
      for (const event of result.events) {
        if (
          event.kind !== EVENT_KINDS.EVENT_MARKET ||
          event.pubkey !== author ||
          !isValidSignedPublicNostrEvent(event)
        )
          continue
        const dTags = event.tags.filter((tag) => tag[0] === "d")
        if (dTags.length !== 1 || !dTags[0]?.[1]) continue
        coordinates.add(`${EVENT_KINDS.EVENT_MARKET}:${author}:${dTags[0][1]}`)
      }
    } catch (error) {
      if (input.signal?.aborted || input.shouldContinue?.() === false)
        throw error
      incomplete = true
    }
  }
  const markets: EventMarketRosterReadResult[] = []
  for (const coordinate of [...coordinates].slice(0, 128)) {
    markets.push(
      await readEventMarketRoster(
        {
          reference: coordinate,
          authenticatedPubkey: input.authenticatedPubkey,
          shouldContinue: input.shouldContinue,
          signal: input.signal,
        },
        dependencies
      )
    )
  }
  if (
    coordinates.size > 128 ||
    markets.some((read) => read.coverage !== "complete")
  )
    incomplete = true
  return { markets, coverage: incomplete ? "partial" : "complete" }
}

/** Fetch exact historical signed records for a created order without reinterpreting its terms. */
export async function readEventMarketOrderEvidenceByIds(
  input: {
    marketCoordinate: string
    merchantPubkey: string
    eventIds: readonly string[]
    authenticatedPubkey?: string | null
    shouldContinue?: () => boolean
    signal?: AbortSignal
  },
  dependencies: RosterReadDependencies = defaultDependencies
): Promise<{
  events: SignedPublicNostrEvent[]
  coverage: EventMarketRosterReadCoverage
  retained: boolean
}> {
  const market = parseAddressableCoordinate(input.marketCoordinate, [
    EVENT_KINDS.EVENT_MARKET,
  ])
  if (
    !market ||
    !/^[0-9a-f]{64}$/.test(input.merchantPubkey) ||
    input.eventIds.length === 0 ||
    input.eventIds.length > 320 ||
    input.eventIds.some((id) => !/^[0-9a-f]{64}$/.test(id))
  )
    return { events: [], coverage: "unavailable", retained: false }
  const ids = new Set(input.eventIds)
  let retained = true
  let cached: SignedPublicNostrEvent[] = []
  try {
    cached = (await dependencies.load(market.coordinate)).filter(
      (event) =>
        ids.has(event.id) &&
        [market.authorPubkey, input.merchantPubkey].includes(event.pubkey) &&
        isValidSignedPublicNostrEvent(event)
    )
  } catch {
    retained = false
  }
  const live: SignedPublicNostrEvent[] = []
  const relayStates: Array<{
    relayUrl: string
    status: "success" | "partial" | "failed"
  }> = []
  for (const author of new Set([market.authorPubkey, input.merchantPubkey])) {
    try {
      const plan = await dependencies.plan({
        organizerPubkey: author,
        authenticatedPubkey: input.authenticatedPubkey,
        shouldContinue: input.shouldContinue,
        signal: input.signal,
      })
      const targets = [...ids]
      for (let offset = 0; offset < targets.length; offset += 64) {
        const batch = targets.slice(offset, offset + 64)
        const result = await dependencies.fetch(
          {
            ids: batch,
            authors: [author],
            limit: batch.length,
          },
          fanoutOptions(plan, input)
        )
        live.push(
          ...result.events.filter(
            (event) =>
              ids.has(event.id) &&
              event.pubkey === author &&
              isValidSignedPublicNostrEvent(event)
          )
        )
        relayStates.push(...result.relays)
      }
    } catch (error) {
      if (input.signal?.aborted || input.shouldContinue?.() === false)
        throw error
    }
  }
  try {
    await dependencies.retain(market.coordinate, live)
  } catch {
    retained = false
  }
  const events = [
    ...new Map([...cached, ...live].map((event) => [event.id, event])).values(),
  ]
  const liveIds = new Set(live.map((event) => event.id))
  const coverage: EventMarketRosterReadCoverage = cached.some(
    (event) => !liveIds.has(event.id)
  )
    ? "stale"
    : relayStates.length === 0 ||
        relayStates.every((relay) => relay.status === "failed")
      ? "unavailable"
      : !retained ||
          relayStates.some((relay) => relay.status !== "success") ||
          events.length !== ids.size
        ? "partial"
        : "complete"
  return { events, coverage, retained }
}

/** Show what a descendant regrant would admit, without granting admission. */
export async function previewEventMarketMerchantProducts(
  input: {
    marketCoordinate: string
    merchantPubkey: string
    authenticatedPubkey?: string | null
    shouldContinue?: () => boolean
    signal?: AbortSignal
  },
  dependencies: RosterReadDependencies = defaultDependencies
): Promise<{
  products: Array<{ coordinate: string; title: string }>
  candidateCount: number
  coverage: EventMarketRosterReadCoverage
}> {
  const market = parseAddressableCoordinate(input.marketCoordinate, [
    EVENT_KINDS.EVENT_MARKET,
  ])
  if (!market || !/^[0-9a-f]{64}$/.test(input.merchantPubkey))
    return { products: [], candidateCount: 0, coverage: "unavailable" }
  let retained = true
  let cached: SignedPublicNostrEvent[] = []
  try {
    cached = (await dependencies.load(market.coordinate)).filter(
      (event) =>
        event.pubkey === input.merchantPubkey &&
        isValidSignedPublicNostrEvent(event)
    )
  } catch {
    retained = false
  }
  let plan: EventMarketReadPlan
  try {
    plan = await dependencies.plan({
      organizerPubkey: input.merchantPubkey,
      authenticatedPubkey: input.authenticatedPubkey,
      shouldContinue: input.shouldContinue,
      signal: input.signal,
    })
  } catch (error) {
    if (input.signal?.aborted || input.shouldContinue?.() === false) throw error
    return { products: [], candidateCount: 0, coverage: "unavailable" }
  }
  const fetch = async (filter: NDKFilter): Promise<SignedFanoutResult> => {
    try {
      return await dependencies.fetch(filter, fanoutOptions(plan, input))
    } catch (error) {
      if (input.signal?.aborted || input.shouldContinue?.() === false)
        throw error
      return { events: [], relays: [] }
    }
  }
  const candidates = await fetch({
    kinds: [EVENT_KINDS.PRODUCT],
    authors: [input.merchantPubkey],
    "#a": [market.coordinate],
    limit: 64,
  })
  const dTags = [
    ...new Set(
      [...cached, ...candidates.events].flatMap((event) => {
        if (
          event.kind !== EVENT_KINDS.PRODUCT ||
          event.pubkey !== input.merchantPubkey ||
          !isValidSignedPublicNostrEvent(event)
        )
          return []
        const d = event.tags.filter((tag) => tag[0] === "d")
        return d.length === 1 && d[0]?.[1] ? [d[0][1]] : []
      })
    ),
  ].slice(0, 32)
  if (dTags.length === 0) {
    return {
      products: [],
      candidateCount: 0,
      coverage:
        candidates.relays.length === 0
          ? "unavailable"
          : candidates.relays.some((relay) => relay.status !== "success") ||
              plan.relayHintTruncated ||
              candidates.events.length >= 64
            ? "partial"
            : "complete",
    }
  }
  const coordinates = dTags.map(
    (d) => `${EVENT_KINDS.PRODUCT}:${input.merchantPubkey}:${d}`
  )
  const revisions = await fetch({
    kinds: [EVENT_KINDS.PRODUCT],
    authors: [input.merchantPubkey],
    "#d": dTags,
    limit: 128,
  })
  const knownIds = [
    ...new Set(
      [...cached, ...revisions.events]
        .filter((event) => event.kind === EVENT_KINDS.PRODUCT)
        .map((event) => event.id)
    ),
  ].slice(0, 128)
  const [coordinateDeletions, idDeletions] = await Promise.all([
    fetch({
      kinds: [EVENT_KINDS.DELETION],
      authors: [input.merchantPubkey],
      "#a": coordinates,
      limit: 128,
    }),
    knownIds.length > 0
      ? fetch({
          kinds: [EVENT_KINDS.DELETION],
          authors: [input.merchantPubkey],
          "#e": knownIds,
          limit: 128,
        })
      : Promise.resolve({ events: [], relays: [] }),
  ])
  const live = [
    ...candidates.events,
    ...revisions.events,
    ...coordinateDeletions.events,
    ...idDeletions.events,
  ].filter(isValidSignedPublicNostrEvent)
  try {
    await dependencies.retain(market.coordinate, live)
  } catch {
    retained = false
  }
  const evidence = [
    ...new Map([...cached, ...live].map((event) => [event.id, event])).values(),
  ]
  const products: Array<{ coordinate: string; title: string }> = []
  for (const coordinate of coordinates) {
    const dTag = coordinate.slice(
      coordinate.indexOf(":", coordinate.indexOf(":") + 1) + 1
    )
    const heads = evidence
      .filter(
        (event) =>
          event.kind === EVENT_KINDS.PRODUCT &&
          event.pubkey === input.merchantPubkey &&
          event.tags.some((tag) => tag[0] === "d" && tag[1] === dTag)
      )
      .sort(
        (left, right) =>
          -compareReplaceableEventFrontiers(
            { createdAt: left.created_at, eventId: left.id },
            { createdAt: right.created_at, eventId: right.id }
          )
      )
    const head = heads[0]
    if (
      !head ||
      !head.tags.some(
        (tag) => tag[0] === "a" && tag[1] === market.coordinate
      ) ||
      isEventMarketAddressableRevisionDeleted(
        {
          coordinate,
          eventId: head.id,
          createdAt: head.created_at * 1_000,
        },
        evidence.filter((event) => event.kind === EVENT_KINDS.DELETION)
      )
    )
      continue
    try {
      const product = parseProductEvent(head)
      if (
        product.visibility === "public" &&
        product.format === "physical" &&
        !product.priceEvidenceMalformed
      )
        products.push({ coordinate, title: product.title })
    } catch {
      /* Malformed listings do not enter the preview. */
    }
  }
  const reads = [candidates, revisions, coordinateDeletions, idDeletions]
  const relayStates = reads.flatMap((read) => read.relays)
  const liveIds = new Set(live.map((event) => event.id))
  const coverage: EventMarketRosterReadCoverage = cached.some(
    (event) => !liveIds.has(event.id)
  )
    ? "stale"
    : relayStates.length === 0 ||
        relayStates.every((relay) => relay.status === "failed")
      ? "unavailable"
      : !retained ||
          plan.relayHintTruncated ||
          candidates.events.length >= 64 ||
          dTags.length >= 32 ||
          revisions.events.length >= 128 ||
          coordinateDeletions.events.length >= 128 ||
          idDeletions.events.length >= 128 ||
          reads.some((read) => read.relays.length === 0) ||
          relayStates.some((relay) => relay.status !== "success")
        ? "partial"
        : "complete"
  return { products, candidateCount: dTags.length, coverage }
}
