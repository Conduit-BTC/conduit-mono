import type { NDKFilter, NDKKind } from "@nostr-dev-kit/ndk"
import {
  readEventMarketAuthorization,
  type EventMarketAuthorizationReadResult,
} from "./event-market-authorization-read"
import { resolveEventMarketAuthorization } from "./event-market-authorization"
import { db, type CachedEventMarketRosterEvidence } from "../db"
import {
  orderEventMarketPickupFulfillmentSchema,
  type OrderEventMarketPickupFulfillmentSchema,
  type ProductSchema,
} from "../schemas"
import {
  decodeEventMarketReference,
  getEventMarketReadPlan,
  isEventMarketAddressableRevisionDeleted,
  parseAddressableCoordinate,
  parseEventMarketCalendarEvent,
  type EventMarketReadPlan,
  type ParsedEventMarketCalendar,
} from "./event-market"
import {
  resolveEventMarketCalendar,
  resolveEventMarketProduct,
  resolveEventMarketRoster,
  type EventMarketMerchantRow,
  type EventMarketProductResolution,
  type EventMarketRosterResolution,
} from "./event-market-roster"
import { EVENT_KINDS } from "./kinds"
import {
  resolveEventMarketOccurrence,
  resolveEventMarketSeries,
  type EventMarketSchedule,
} from "./event-market-schedule"
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
  /** Scoped signed roster revisions and deletions for cross-read reconciliation. */
  observedEvidence?: readonly SignedPublicNostrEvent[]
  calendar?: ParsedEventMarketCalendar | null
  calendarSignedEvent?: SignedPublicNostrEvent
  calendarCoverage?: EventMarketRosterReadCoverage
  schedule?: EventMarketSchedule
  scheduleCoverage?: EventMarketRosterReadCoverage
}

export interface EventMarketProductReadResult {
  productCoordinate: string
  resolution: EventMarketProductResolution | { state: "market_unavailable" }
  coverage: EventMarketRosterReadCoverage
  retained: boolean
  actionable: boolean
  authorization?: EventMarketAuthorizationReadResult
}

/** Signed display evidence only; the selected product still needs an action-time read. */
export interface EventMarketCatalogCandidate {
  productCoordinate: string
  resolution: {
    state: "candidate"
    product: ProductSchema
    revision: SignedPublicNostrEvent
    merchant: EventMarketMerchantRow
  }
  coverage: EventMarketRosterReadCoverage
  retained: boolean
  actionable: false
}

export interface EventMarketCatalogReadResult {
  marketRead: EventMarketRosterReadResult
  products: EventMarketCatalogCandidate[]
  coverage: EventMarketRosterReadCoverage
  candidateCount: number
  hasMore: boolean
}

/** Partial source coverage does not erase a live selected signed revision. */
function hasCurrentSignedEvidence(
  coverage: EventMarketRosterReadCoverage | undefined
): boolean {
  return coverage === "complete" || coverage === "partial"
}

/** Buyer and merchant label derived from the exact signed pickup occurrence. */
export function formatEventMarketPickupDate(
  fulfillment: Pick<OrderEventMarketPickupFulfillmentSchema, "calendar">
): string {
  const calendar = parseEventMarketCalendarEvent(
    fulfillment.calendar.signedEvent
  )
  if (!calendar || calendar.coordinate !== fulfillment.calendar.coordinate)
    return "Selected event date unavailable"
  if (calendar.kind === EVENT_KINDS.CALENDAR_DATE)
    return (
      calendar.startDate ?? new Date(calendar.start).toISOString().slice(0, 10)
    )
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: calendar.startTzid ?? "UTC",
      timeZoneName: "short",
    }).format(new Date(calendar.start))
  } catch {
    return new Date(calendar.start).toISOString()
  }
}

/** Freeze exact signed participation terms before adding a future-event cart line. */
export function createEventMarketPickupSnapshot(input: {
  marketRead: EventMarketRosterReadResult
  productRead: EventMarketProductReadResult
  selectedOccurrenceCoordinate?: string
}): OrderEventMarketPickupFulfillmentSchema {
  const market = input.marketRead.resolution
  const product = input.productRead.resolution
  const schedule = input.marketRead.schedule
  const selected =
    schedule?.kind === "series"
      ? schedule.occurrences.find(
          (entry) =>
            entry.occurrence.coordinate ===
              input.selectedOccurrenceCoordinate &&
            hasCurrentSignedEvidence(entry.coverage)
        )
      : undefined
  const calendar =
    schedule?.kind === "series"
      ? selected?.occurrence
      : input.marketRead.calendar
  const authorization = input.productRead.authorization?.resolution
  if (
    market.state !== "current" ||
    market.market.state !== "open" ||
    !calendar ||
    (schedule?.kind === "series" &&
      (!hasCurrentSignedEvidence(input.marketRead.calendarCoverage) ||
        calendar.end <= Date.now())) ||
    product.state !== "eligible" ||
    (product.merchant.pubkey === market.market.organizerPubkey &&
      product.merchant.mode === "organizer_handoff") ||
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
      signedEvent: market.market.signedEvent,
    },
    calendar: {
      coordinate: calendar.coordinate,
      eventId: calendar.eventId,
      createdAt: calendar.createdAt,
      start: calendar.start,
      end: calendar.end,
      signedEvent: calendar.signedEvent,
    },
    ...(schedule?.kind === "series"
      ? {
          schedule: {
            coordinate: schedule.coordinate,
            eventId: schedule.series.eventId,
            createdAt: schedule.series.createdAt,
            signedEvent: schedule.series.signedEvent,
          },
        }
      : {}),
    product: {
      coordinate: input.productRead.productCoordinate,
      eventId: product.revision.id,
      createdAt: product.revision.created_at * 1_000,
      signedEvent: product.revision,
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

/** Exact saved public records for interrupted organizer publication. */
export async function loadRetainedSignedEventMarketEvidence(
  marketCoordinate: string
): Promise<SignedPublicNostrEvent[]> {
  const coordinate = parseAddressableCoordinate(marketCoordinate, [
    EVENT_KINDS.EVENT_MARKET,
  ])
  if (!coordinate || coordinate.coordinate !== marketCoordinate) return []
  return loadRetained(marketCoordinate)
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
      EVENT_KINDS.CALENDAR,
      EVENT_KINDS.EVENT_MARKET_AUTH,
    ].includes(signedEvent.kind as never)
  )
    throw new Error("Signed Event Market evidence is invalid.")
  await retainSigned(market.coordinate, [signedEvent])
}

const defaultDependencies: RosterReadDependencies & {
  loadDiscovered: (
    authors: readonly string[]
  ) => Promise<SignedPublicNostrEvent[]>
} = {
  plan: getEventMarketReadPlan,
  fetch: fetchSigned,
  load: loadRetained,
  retain: retainSigned,
  authorization: readEventMarketAuthorization,
  loadDiscovered: async (authors: readonly string[]) =>
    (
      await Promise.all(
        authors.map((author) =>
          db.eventMarketRosterEvidence
            .where("marketCoordinate")
            .startsWith(`30409:${author}:`)
            .filter((row) => row.signedEvent.kind === EVENT_KINDS.EVENT_MARKET)
            .limit(128)
            .toArray()
        )
      )
    )
      .flat()
      .map((row) => row.signedEvent),
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
      observedEvidence: retainedEvents,
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
  // Signed tombstones remain authoritative in the reducer without live
  // redelivery; freshness belongs to the selected current revision.
  const stale = selectedId !== null && !liveIds.has(selectedId)
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
    return {
      coordinate,
      resolution,
      coverage,
      retained,
      observedRelayUrls,
      observedEvidence: all,
    }
  }
  const linkedCoordinate = parseAddressableCoordinate(
    resolution.market.calendarCoordinate,
    [EVENT_KINDS.CALENDAR_DATE, EVENT_KINDS.CALENDAR_TIME, EVENT_KINDS.CALENDAR]
  )!
  if (linkedCoordinate.kind === EVENT_KINDS.CALENDAR) {
    const [masterRead, masterCoordinateDeletions] = await Promise.all([
      safeFetch({
        kinds: [EVENT_KINDS.CALENDAR as NDKKind],
        authors: [decoded.authorPubkey],
        "#d": [linkedCoordinate.dTag],
        limit: 64,
      }),
      safeFetch({
        kinds: [EVENT_KINDS.DELETION],
        authors: [decoded.authorPubkey],
        "#a": [linkedCoordinate.coordinate],
        limit: 64,
      }),
    ])
    const knownMaster = [...loadedEvents, ...masterRead.events].filter(
      (event) =>
        event.kind === EVENT_KINDS.CALENDAR &&
        event.pubkey === decoded.authorPubkey &&
        event.tags.some(
          (tag) => tag[0] === "d" && tag[1] === linkedCoordinate.dTag
        ) &&
        isValidSignedPublicNostrEvent(event)
    )
    const masterIdDeletions =
      knownMaster.length > 0
        ? await safeFetch({
            kinds: [EVENT_KINDS.DELETION],
            authors: [decoded.authorPubkey],
            "#e": knownMaster.slice(0, 32).map((event) => event.id),
            limit: 64,
          })
        : { events: [], relays: [] }
    const masterReads = [
      masterRead,
      masterCoordinateDeletions,
      ...(knownMaster.length > 0 ? [masterIdDeletions] : []),
    ]
    const liveMaster = masterReads.flatMap((read) => read.events)
    const masterEvidence = [
      ...new Map(
        [...loadedEvents, ...liveMaster]
          .filter(
            (event) =>
              event.pubkey === decoded.authorPubkey &&
              isValidSignedPublicNostrEvent(event)
          )
          .map((event) => [event.id, event])
      ).values(),
    ]
    try {
      await dependencies.retain(coordinate, liveMaster)
    } catch {
      retained = false
    }
    const seriesResolution = resolveEventMarketSeries({
      coordinate: linkedCoordinate.coordinate,
      organizerPubkey: decoded.authorPubkey,
      revisions: masterEvidence,
      deletions: masterEvidence.filter(
        (event) => event.kind === EVENT_KINDS.DELETION
      ),
    })
    const masterRelayStates = masterReads.flatMap((read) => read.relays)
    const masterCoverage: EventMarketRosterReadCoverage =
      seriesResolution.state === "current" &&
      !liveMaster.some((event) => event.id === seriesResolution.series.eventId)
        ? "stale"
        : masterRelayStates.length === 0 ||
            masterRelayStates.every((relay) => relay.status === "failed")
          ? "unavailable"
          : !retained ||
              plan.relayHintTruncated ||
              knownMaster.length > 32 ||
              masterReads.some((read) => read.relays.length === 0) ||
              masterRelayStates.some((relay) => relay.status !== "success") ||
              masterRead.events.length >= 64 ||
              masterCoordinateDeletions.events.length >= 64 ||
              masterIdDeletions.events.length >= 64
            ? "partial"
            : "complete"
    if (seriesResolution.state !== "current") {
      return {
        coordinate,
        resolution,
        coverage,
        retained,
        observedRelayUrls,
        observedEvidence: all,
        calendar: null,
        calendarCoverage: masterCoverage,
        scheduleCoverage: masterCoverage,
      }
    }
    const members = seriesResolution.series.memberCoordinates.map((value) =>
      parseAddressableCoordinate(value, [
        EVENT_KINDS.CALENDAR_DATE,
        EVENT_KINDS.CALENDAR_TIME,
      ])!
    )
    const occurrences: Extract<
      EventMarketSchedule,
      { kind: "series" }
    >["occurrences"] = []
    const unresolvedCoordinates: string[] = []
    let scheduleCoverage: EventMarketRosterReadCoverage = masterCoverage
    const memberRelayUrls = new Set<string>()
    for (let offset = 0; offset < members.length; offset += 32) {
      const batch = members.slice(offset, offset + 32)
      const [memberRead, memberCoordinateDeletions] = await Promise.all([
        safeFetch({
          kinds: [
            EVENT_KINDS.CALENDAR_DATE as NDKKind,
            EVENT_KINDS.CALENDAR_TIME as NDKKind,
          ],
          authors: [decoded.authorPubkey],
          "#d": batch.map((member) => member.dTag),
          limit: 128,
        }),
        safeFetch({
          kinds: [EVENT_KINDS.DELETION],
          authors: [decoded.authorPubkey],
          "#a": batch.map((member) => member.coordinate),
          limit: 128,
        }),
      ])
      const knownMemberIds = [
        ...new Set(
          [...loadedEvents, ...memberRead.events]
            .filter(
              (event) =>
                batch.some(
                  (member) =>
                    event.kind === member.kind &&
                    event.pubkey === decoded.authorPubkey &&
                    event.tags.some(
                      (tag) => tag[0] === "d" && tag[1] === member.dTag
                    )
                ) && isValidSignedPublicNostrEvent(event)
            )
            .map((event) => event.id)
        ),
      ]
      const memberIdDeletions =
        knownMemberIds.length > 0
          ? await safeFetch({
              kinds: [EVENT_KINDS.DELETION],
              authors: [decoded.authorPubkey],
              "#e": knownMemberIds.slice(0, 128),
              limit: 128,
            })
          : { events: [], relays: [] }
      const memberReads = [
        memberRead,
        memberCoordinateDeletions,
        ...(knownMemberIds.length > 0 ? [memberIdDeletions] : []),
      ]
      const liveMembers = memberReads.flatMap((read) => read.events)
      try {
        await dependencies.retain(coordinate, liveMembers)
      } catch {
        retained = false
      }
      const evidence = [
        ...new Map(
          [...loadedEvents, ...liveMembers]
            .filter(
              (event) =>
                event.pubkey === decoded.authorPubkey &&
                isValidSignedPublicNostrEvent(event)
            )
            .map((event) => [event.id, event])
        ).values(),
      ]
      const liveIds = new Set(liveMembers.map((event) => event.id))
      const relayStates = memberReads.flatMap((read) => read.relays)
      relayStates.forEach((relay) => memberRelayUrls.add(relay.relayUrl))
      const batchCoverage: EventMarketRosterReadCoverage =
        relayStates.length === 0 ||
        relayStates.every((relay) => relay.status === "failed")
          ? "unavailable"
          : !retained ||
              plan.relayHintTruncated ||
              knownMemberIds.length > 128 ||
              memberReads.some((read) => read.relays.length === 0) ||
              relayStates.some((relay) => relay.status !== "success") ||
              memberRead.events.length >= 128 ||
              memberCoordinateDeletions.events.length >= 128 ||
              memberIdDeletions.events.length >= 128
            ? "partial"
            : "complete"
      for (const member of batch) {
        const resolved = resolveEventMarketOccurrence({
          coordinate: member.coordinate,
          organizerPubkey: decoded.authorPubkey,
          revisions: evidence,
          deletions: evidence.filter(
            (event) => event.kind === EVENT_KINDS.DELETION
          ),
        })
        if (!resolved) {
          unresolvedCoordinates.push(member.coordinate)
          scheduleCoverage = "partial"
          continue
        }
        const memberCoverage = liveIds.has(resolved.signedEvent.id)
          ? batchCoverage
          : "stale"
        if (memberCoverage !== "complete") scheduleCoverage = "partial"
        occurrences.push({
          occurrence: resolved.occurrence,
          occurrenceEvent: resolved.signedEvent,
          coverage: memberCoverage,
        })
      }
    }
    occurrences.sort(
      (left, right) =>
        left.occurrence.start - right.occurrence.start ||
        left.occurrence.coordinate.localeCompare(right.occurrence.coordinate)
    )
    const selected =
      occurrences.find((entry) => entry.occurrence.end > Date.now()) ??
      occurrences.at(-1)
    const schedule: EventMarketSchedule = {
      kind: "series",
      coordinate: linkedCoordinate.coordinate,
      series: seriesResolution.series,
      occurrences,
      unresolvedCoordinates,
    }
    return {
      coordinate,
      resolution,
      coverage,
      retained,
      observedEvidence: all,
      observedRelayUrls: [
        ...new Set([
          ...observedRelayUrls,
          ...masterRelayStates.map((relay) => relay.relayUrl),
          ...memberRelayUrls,
        ]),
      ],
      calendar: selected?.occurrence ?? null,
      calendarCoverage: masterCoverage,
      schedule,
      scheduleCoverage,
    }
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
  const calendarStale = Boolean(
    latestCalendarRevision && !liveCalendarIds.has(latestCalendarRevision.id)
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
    observedEvidence: all,
    observedRelayUrls: [
      ...new Set([
        ...observedRelayUrls,
        ...calendarRelayStates.map((relay) => relay.relayUrl),
      ]),
    ],
    calendar,
    calendarSignedEvent: calendarEvidence.find(
      (event) => event.id === calendar?.eventId
    ),
    calendarCoverage,
    ...(calendar?.signedEvent
      ? {
          schedule: {
            kind: "single" as const,
            coordinate: calendar.coordinate,
            occurrence: calendar,
            occurrenceEvent: calendar.signedEvent,
          },
          scheduleCoverage: calendarCoverage,
        }
      : {}),
  }
}

/** Exact product authority for selected purchase actions and direct product links. */
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
  const stale = knownRevisions[0] && !liveIds.has(knownRevisions[0].id)
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
      // Each selected positive revision must be live. Optional failed or
      // incomplete sources remain visible in coverage without vetoing it.
      hasCurrentSignedEvidence(coverage) &&
      hasCurrentSignedEvidence(input.marketRead.coverage) &&
      hasCurrentSignedEvidence(input.marketRead.calendarCoverage) &&
      input.marketRead.retained,
  }
}

/** Project retained signed headers without assigning live freshness or purchase authority. */
function cachedCatalogMarket(
  coordinate: string,
  events: readonly SignedPublicNostrEvent[],
  retained: boolean
): EventMarketRosterReadResult {
  const resolution = resolveEventMarketRoster({
    coordinate,
    revisions: events.filter(
      (event) => event.kind === EVENT_KINDS.EVENT_MARKET
    ),
    deletions: events.filter((event) => event.kind === EVENT_KINDS.DELETION),
  })
  const calendar =
    resolution.state === "current"
      ? resolveEventMarketCalendar({
          market: resolution.market,
          revisions: events,
          deletions: events.filter(
            (event) => event.kind === EVENT_KINDS.DELETION
          ),
        })
      : null
  return {
    coordinate,
    resolution,
    coverage: "stale",
    retained,
    observedRelayUrls: [],
    calendar,
    calendarSignedEvent: events.find((event) => event.id === calendar?.eventId),
    calendarCoverage: "stale",
  }
}

function catalogCandidates(input: {
  marketRead: EventMarketRosterReadResult
  live: readonly SignedPublicNostrEvent[]
  cached: readonly SignedPublicNostrEvent[]
  limit: number
  incomplete: boolean
  search?: string
}): EventMarketCatalogReadResult {
  const { marketRead, live, cached, limit } = input
  const market = marketRead.resolution
  const products: EventMarketCatalogCandidate[] = []
  if (market.state !== "current") {
    return {
      marketRead,
      products,
      coverage: marketRead.coverage,
      candidateCount: 0,
      hasMore: false,
    }
  }
  const merchants = new Map(
    market.market.merchants.map((row) => [row.pubkey, row])
  )
  const known = [...cached, ...(marketRead.observedEvidence ?? [])]
  const transitions = known.filter(
    (event) =>
      event.kind === EVENT_KINDS.EVENT_MARKET_AUTH &&
      event.pubkey === market.market.organizerPubkey &&
      event.tags.some(
        (tag) => tag[0] === "a" && tag[1] === market.market.coordinate
      )
  )
  const authorizationDeletions = known.filter(
    (event) =>
      event.kind === EVENT_KINDS.DELETION &&
      event.pubkey === market.market.organizerPubkey
  )
  const suppressedMerchants = new Set<string>()
  for (const merchantPubkey of merchants.keys()) {
    const merchantTransitions = transitions.filter((event) =>
      event.tags.some((tag) => tag[0] === "p" && tag[1] === merchantPubkey)
    )
    const transitionIds = new Set(merchantTransitions.map((event) => event.id))
    const authorization = resolveEventMarketAuthorization({
      marketCoordinate: market.market.coordinate,
      merchantPubkey,
      transitions: merchantTransitions,
      deletions: authorizationDeletions.filter(
        (event) =>
          event.tags.some(
            (tag) => tag[0] === "e" && transitionIds.has(tag[1] ?? "")
          ) ||
          (event.tags.some(
            (tag) => tag[0] === "a" && tag[1] === market.market.coordinate
          ) &&
            event.tags.some(
              (tag) => tag[0] === "p" && tag[1] === merchantPubkey
            ))
      ),
    })
    // Missing evidence is still a provisional candidate. Any observed,
    // unresolved organizer authorization evidence cannot restore a card over
    // a retained revoke, fork, deletion, or invalid causal transition.
    if (authorization.state !== "active" && authorization.state !== "missing")
      suppressedMerchants.add(merchantPubkey)
  }
  const newest = new Map<string, SignedPublicNostrEvent>()
  const coordinates = new Set<string>()
  const liveIds = new Set(live.map((event) => event.id))
  // Live relay order leads. Cache fills gaps, but its newer withdrawals and
  // tombstones also dominate an older live search result.
  const evidence = [...live, ...cached]
  for (const event of evidence) {
    if (
      event.kind !== EVENT_KINDS.PRODUCT ||
      !merchants.has(event.pubkey) ||
      !isValidSignedPublicNostrEvent(event)
    )
      continue
    const dTag = event.tags.find((tag) => tag[0] === "d")?.[1]
    const coordinate = parseAddressableCoordinate(
      `${EVENT_KINDS.PRODUCT}:${event.pubkey}:${dTag ?? ""}`,
      [EVENT_KINDS.PRODUCT]
    )?.coordinate
    if (!coordinate) continue
    const previous = newest.get(coordinate)
    if (
      !previous ||
      compareReplaceableEventFrontiers(
        { createdAt: event.created_at, eventId: event.id },
        { createdAt: previous.created_at, eventId: previous.id }
      ) > 0
    )
      newest.set(coordinate, event)
    if (
      event.tags.some(
        (tag) => tag[0] === "a" && tag[1] === market.market.coordinate
      )
    )
      coordinates.add(coordinate)
  }
  const deletions = evidence.filter(
    (event) => event.kind === EVENT_KINDS.DELETION
  )
  let stale = [...newest.values()].some((event) => !liveIds.has(event.id))
  for (const productCoordinate of coordinates) {
    const revision = newest.get(productCoordinate)!
    if (
      suppressedMerchants.has(revision.pubkey) ||
      revision.tags.filter((tag) => tag[0] === "d").length !== 1 ||
      revision.tags.filter(
        (tag) => tag[0] === "a" && tag[1] === market.market.coordinate
      ).length !== 1 ||
      isEventMarketAddressableRevisionDeleted(
        {
          coordinate: productCoordinate,
          eventId: revision.id,
          createdAt: revision.created_at * 1_000,
        },
        deletions
      )
    )
      continue
    try {
      const product = parseProductEvent(revision)
      if (
        product.visibility !== "public" ||
        product.format !== "physical" ||
        product.priceEvidenceMalformed
      )
        continue
      const currentLive = liveIds.has(revision.id)
      const needle = input.search?.trim().toLocaleLowerCase()
      if (
        !currentLive &&
        needle &&
        !revision.content.toLocaleLowerCase().includes(needle)
      )
        continue
      stale ||= !currentLive
      products.push({
        productCoordinate,
        resolution: {
          state: "candidate",
          product,
          revision,
          merchant: merchants.get(revision.pubkey)!,
        },
        coverage: currentLive ? "complete" : "stale",
        retained: marketRead.retained,
        actionable: false,
      })
    } catch {
      // A malformed selected revision excludes the coordinate, never restores its older terms.
    }
  }
  return {
    marketRead,
    products: products.slice(0, limit),
    coverage:
      input.incomplete ||
      stale ||
      marketRead.coverage !== "complete" ||
      marketRead.calendarCoverage !== "complete"
        ? "partial"
        : "complete",
    candidateCount: coordinates.size,
    hasMore: live.length >= limit || products.length > limit,
  }
}

/** One roster-scoped query supplies display candidates; purchase authority is checked separately. */
export async function readEventMarketCatalog(
  input: {
    reference: string
    limit?: number
    search?: string
    onProgress?: (result: EventMarketCatalogReadResult) => void
    authenticatedPubkey?: string | null
    shouldContinue?: () => boolean
    signal?: AbortSignal
  },
  dependencies: RosterReadDependencies = defaultDependencies
): Promise<EventMarketCatalogReadResult> {
  const limit = Math.max(
    1,
    Math.min(256, Math.floor(Number.isFinite(input.limit) ? input.limit! : 48))
  )
  const assertCurrent = () => {
    if (input.signal?.aborted || input.shouldContinue?.() === false)
      throw new DOMException(
        "Event Market catalog read cancelled.",
        "AbortError"
      )
  }
  assertCurrent()
  const decoded = decodeEventMarketReference(input.reference, [
    EVENT_KINDS.EVENT_MARKET,
  ])
  if (!decoded) {
    const marketRead = await readEventMarketRoster(input, dependencies)
    assertCurrent()
    return {
      marketRead,
      products: [],
      coverage: marketRead.coverage,
      candidateCount: 0,
      hasMore: false,
    }
  }
  let cached: SignedPublicNostrEvent[] = []
  let retained = true
  try {
    cached = await dependencies.load(decoded.coordinate)
  } catch {
    retained = false
  }
  assertCurrent()
  const cachedMarket = cachedCatalogMarket(decoded.coordinate, cached, retained)
  if (cachedMarket.resolution.state === "current")
    input.onProgress?.(
      catalogCandidates({
        marketRead: cachedMarket,
        live: [],
        cached,
        limit,
        incomplete: true,
        search: input.search,
      })
    )
  assertCurrent()
  // Share one organizer/configured relay plan with the roster read. Merchant
  // count adds no relay-list lookup or discovery request.
  let planPromise: Promise<EventMarketReadPlan> | undefined
  const plan: RosterReadDependencies["plan"] = (query) =>
    (planPromise ??= dependencies.plan(query))
  const marketRead = await readEventMarketRoster(input, {
    ...dependencies,
    plan,
    load: async () => cached,
  })
  assertCurrent()
  const authors =
    marketRead.resolution.state === "current"
      ? marketRead.resolution.market.merchants.map((row) => row.pubkey)
      : []
  let discoveryPlan: EventMarketReadPlan | undefined
  const discovery = await (async (): Promise<SignedFanoutResult> => {
    if (authors.length === 0) return { events: [], relays: [] }
    try {
      discoveryPlan = await plan({
        organizerPubkey: decoded.authorPubkey,
        relayHints: decoded.relayHints,
        authenticatedPubkey: input.authenticatedPubkey,
        shouldContinue: input.shouldContinue,
        signal: input.signal,
      })
      assertCurrent()
      const search = input.search?.trim()
      const result = await dependencies.fetch(
        {
          kinds: [EVENT_KINDS.PRODUCT],
          authors,
          "#a": [decoded.coordinate],
          limit,
          ...(search ? { search } : {}),
        },
        fanoutOptions(discoveryPlan, input)
      )
      assertCurrent()
      return result
    } catch {
      assertCurrent()
      return { events: [], relays: [] }
    }
  })()
  assertCurrent()
  const live = discovery.events.slice(0, 256)
  let incomplete =
    !retained ||
    Boolean(discoveryPlan?.relayHintTruncated) ||
    discovery.events.length >= limit ||
    (authors.length > 0 && discovery.relays.length === 0) ||
    discovery.relays.some((relay) => relay.status !== "success")
  // Reload local evidence after the network wait: an observed newer withdrawal
  // or deletion must suppress the old candidate before publishing progress.
  try {
    cached = [...cached, ...(await dependencies.load(decoded.coordinate))]
  } catch {
    incomplete = true
  }
  assertCurrent()
  let result = catalogCandidates({
    marketRead,
    live,
    cached,
    limit,
    incomplete,
    search: input.search,
  })
  input.onProgress?.(result)
  assertCurrent()
  try {
    const approved =
      marketRead.resolution.state === "current"
        ? new Set(
            marketRead.resolution.market.merchants.map((row) => row.pubkey)
          )
        : new Set<string>()
    await dependencies.retain(
      decoded.coordinate,
      live.filter(
        (event) =>
          event.kind === EVENT_KINDS.PRODUCT &&
          approved.has(event.pubkey) &&
          isValidSignedPublicNostrEvent(event)
      )
    )
  } catch {
    incomplete = true
  }
  assertCurrent()
  try {
    cached = [...cached, ...(await dependencies.load(decoded.coordinate))]
  } catch {
    incomplete = true
  }
  assertCurrent()
  result = catalogCandidates({
    marketRead,
    live,
    cached,
    limit,
    incomplete,
    search: input.search,
  })
  input.onProgress?.(result)
  return result
}

export interface FutureEventMarketDiscoveryResult {
  markets: EventMarketRosterReadResult[]
  coverage: EventMarketRosterReadCoverage
}

/** Bounded organizer discovery; each exact signed result can paint independently. */
export async function discoverFutureEventMarkets(
  input: {
    organizerPubkeys: readonly string[]
    authenticatedPubkey?: string | null
    shouldContinue?: () => boolean
    signal?: AbortSignal
    onProgress?: (result: FutureEventMarketDiscoveryResult) => void
  },
  dependencies: RosterReadDependencies & {
    loadDiscovered?: (
      authors: readonly string[]
    ) => Promise<SignedPublicNostrEvent[]>
  } = defaultDependencies
): Promise<FutureEventMarketDiscoveryResult> {
  const requestedAuthors = [
    ...new Set(
      input.organizerPubkeys.filter((value) => /^[0-9a-f]{64}$/.test(value))
    ),
  ]
  const authors = requestedAuthors.slice(0, 64)
  const authorSet = new Set(authors)
  const results = new Map<string, EventMarketRosterReadResult>()
  const scheduled = new Map<string, Promise<void>>()
  const liveCompleted = new Set<string>()
  const broadObserved = new Set<string>()
  const coordinateGenerations = new Map<string, number>()
  const plans = new Map<string, EventMarketReadPlan>()
  let incomplete =
    requestedAuthors.length > 64 ||
    input.organizerPubkeys.some((author) => !/^[0-9a-f]{64}$/.test(author))
  let availableSources = 0
  let finished = false
  function assertCurrent(): void {
    if (input.signal?.aborted || input.shouldContinue?.() === false)
      throw new DOMException(
        "Event Market discovery was cancelled.",
        "AbortError"
      )
  }
  const snapshot = (
    coverage: EventMarketRosterReadCoverage
  ): FutureEventMarketDiscoveryResult => ({
    markets: [...results.values()].sort((left, right) =>
      left.coordinate.localeCompare(right.coordinate)
    ),
    coverage,
  })
  function emit(): void {
    assertCurrent()
    if (!finished && results.size) input.onProgress?.(snapshot("partial"))
  }
  // Bound both organizer plans and exact roster pipelines. Queued reads do not
  // postpone a completed organizer behind an unrelated held organizer.
  function limiter(limit: number) {
    let active = 0
    const queue: Array<() => void> = []
    return async (task: () => Promise<void>) => {
      if (active >= limit)
        await new Promise<void>((resolve) => queue.push(resolve))
      else active++
      try {
        assertCurrent()
        await task()
      } finally {
        const next = queue.shift()
        if (next) next()
        else active--
      }
    }
  }
  const exactLimit = limiter(4)
  function coordinateFor(event: SignedPublicNostrEvent): string | null {
    if (
      event.kind !== EVENT_KINDS.EVENT_MARKET ||
      !authorSet.has(event.pubkey) ||
      !isValidSignedPublicNostrEvent(event)
    )
      return null
    const dTags = event.tags.filter((tag) => tag[0] === "d")
    return dTags.length === 1 && dTags[0]?.[1]
      ? `${EVENT_KINDS.EVENT_MARKET}:${event.pubkey}:${dTags[0][1]}`
      : null
  }
  function scheduleExact(coordinate: string, refresh = false): Promise<void> {
    const prior = scheduled.get(coordinate)
    if (prior && !refresh) return prior
    if (!prior && scheduled.size >= 128) {
      incomplete = true
      return Promise.resolve()
    }
    const generation = (coordinateGenerations.get(coordinate) ?? 0) + 1
    coordinateGenerations.set(coordinate, generation)
    const execute = () =>
      exactLimit(async () => {
        const result = await readEventMarketRoster(
          {
            reference: coordinate,
            authenticatedPubkey: input.authenticatedPubkey,
            shouldContinue: input.shouldContinue,
            signal: input.signal,
          },
          {
            ...dependencies,
            plan: async (options) =>
              plans.get(options.organizerPubkey) ?? dependencies.plan(options),
          }
        )
        assertCurrent()
        if (coordinateGenerations.get(coordinate) === generation) {
          liveCompleted.add(coordinate)
          results.set(coordinate, result)
          emit()
        }
      })
    const read = prior ? prior.then(execute) : execute()
    // Cancellation/errors are observed when the joined discovery settles.
    // Attaching immediately prevents an early failing exact read from becoming
    // an unhandled rejection while a sibling organizer is still pending.
    void read.catch(() => {})
    scheduled.set(coordinate, read)
    return read
  }
  assertCurrent()
  const cached = (async () => {
    if (!dependencies.loadDiscovered) return
    let events: SignedPublicNostrEvent[]
    try {
      events = await dependencies.loadDiscovered(authors)
    } catch {
      assertCurrent()
      incomplete = true
      return
    }
    assertCurrent()
    const cachedCoordinates = [
      ...new Set(
        events.map(coordinateFor).filter((value): value is string => !!value)
      ),
    ]
    if (cachedCoordinates.length >= 128) incomplete = true
    const coordinates = cachedCoordinates.slice(0, 128)
    for (const coordinate of coordinates) {
      assertCurrent()
      if (!liveCompleted.has(coordinate) && !broadObserved.has(coordinate)) {
        const preview = await readEventMarketRoster(
          {
            reference: coordinate,
            authenticatedPubkey: input.authenticatedPubkey,
            shouldContinue: input.shouldContinue,
            signal: input.signal,
          },
          {
            ...dependencies,
            plan: async () => ({
              relayUrls: [],
              candidateRelayUrls: [],
              ownerSelectedRelayUrls: [],
              appRelayUrls: [],
              personalRelayUrls: [],
              independentRelayUrls: [],
              relayListState: "lookup-unavailable",
              relayHintTruncated: false,
            }),
            fetch: async () => ({ events: [], relays: [] }),
            retain: async () => {},
          }
        )
        assertCurrent()
        // A cache load finishing after a live deletion never resurrects it.
        if (!liveCompleted.has(coordinate) && !broadObserved.has(coordinate)) {
          results.set(coordinate, preview)
          emit()
        }
      }
      void scheduleExact(coordinate)
    }
  })()
  const authorLimit = limiter(4)
  const live = Promise.all(
    authors.map((author) =>
      authorLimit(async () => {
        let plan: EventMarketReadPlan
        try {
          plan = await dependencies.plan({
            organizerPubkey: author,
            authenticatedPubkey: input.authenticatedPubkey,
            shouldContinue: input.shouldContinue,
            signal: input.signal,
          })
          assertCurrent()
          plans.set(author, plan)
          const broad = await dependencies.fetch(
            {
              kinds: [EVENT_KINDS.EVENT_MARKET as NDKKind],
              authors: [author],
              limit: 128,
            },
            fanoutOptions(plan, input)
          )
          assertCurrent()
          if (broad.relays.some((relay) => relay.status !== "failed"))
            availableSources++
          if (
            plan.relayHintTruncated ||
            broad.events.length >= 128 ||
            !broad.relays.length ||
            broad.relays.some((relay) => relay.status !== "success")
          )
            incomplete = true
          const records = new Map<string, SignedPublicNostrEvent[]>()
          for (const event of broad.events) {
            const coordinate = coordinateFor(event)
            if (!coordinate) continue
            records.set(coordinate, [...(records.get(coordinate) ?? []), event])
          }
          for (const [coordinate, evidence] of records) {
            try {
              await dependencies.retain(coordinate, evidence)
            } catch {
              incomplete = true
            }
            assertCurrent()
            broadObserved.add(coordinate)
            void scheduleExact(coordinate, true)
          }
        } catch {
          assertCurrent()
          incomplete = true
        }
      })
    )
  )
  try {
    await Promise.all([cached, live])
    await Promise.all(scheduled.values())
    assertCurrent()
    finished = true
    const coverage =
      incomplete ||
      [...results.values()].some((read) => read.coverage !== "complete")
        ? availableSources || results.size
          ? "partial"
          : "unavailable"
        : "complete"
    return snapshot(coverage)
  } finally {
    finished = true
  }
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
