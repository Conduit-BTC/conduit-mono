import {
  decodeEventMarketReference,
  encodeEventMarketNaddr,
  EVENT_KINDS,
  parseAddressableCoordinate,
  type EventMarketDeletedRecordEvidence,
  type SignedPublicNostrEvent,
} from "@conduit/core"

export type OrganizerCollectionMembershipAction = "accept" | "remove"

export function normalizeOrganizerEventMarketTitle(
  value: unknown
): string | undefined {
  if (typeof value !== "string") return undefined
  const title = value.trim()
  return title || undefined
}

export interface SavedOrganizerEventMarketReference {
  reference: string
  title?: string
  savedAt: number
  // Display provenance must stay separate from expected* mutation frontiers:
  // learning a title must never unlock or block organizer actions.
  titleCollectionCoordinate?: string
  titleCollectionCreatedAt?: number
  titleCollectionEventId?: string
  titleCalendarCoordinate?: string
  titleCalendarCreatedAt?: number
  titleCalendarEventId?: string
  expectedCollectionCoordinate?: string
  expectedCollectionCreatedAt?: number
  expectedCollectionEventId?: string
  expectedCalendarCoordinate?: string
  expectedCalendarCreatedAt?: number
  expectedCalendarEventId?: string
  expectedPickupCoordinate?: string
  expectedPickupCreatedAt?: number
  expectedPickupEventId?: string
  replaceExpectedRecordFrontiers?: true
}

export function expectedOrganizerEventMarketFrontier(delivery: {
  record: "calendar" | "pickup" | "collection"
  signedEvent: SignedPublicNostrEvent | null
}): Partial<SavedOrganizerEventMarketReference> {
  const signedEvent = delivery.signedEvent
  if (!signedEvent) return {}
  const createdAt = signedEvent.created_at * 1_000
  const coordinate = organizerEventMarketSignedRecordCoordinate(
    delivery.record,
    signedEvent
  )
  return delivery.record === "calendar"
    ? {
        ...(coordinate ? { expectedCalendarCoordinate: coordinate } : {}),
        expectedCalendarCreatedAt: createdAt,
        expectedCalendarEventId: signedEvent.id,
      }
    : delivery.record === "pickup"
      ? {
          ...(coordinate ? { expectedPickupCoordinate: coordinate } : {}),
          expectedPickupCreatedAt: createdAt,
          expectedPickupEventId: signedEvent.id,
        }
      : {
          ...(coordinate ? { expectedCollectionCoordinate: coordinate } : {}),
          expectedCollectionCreatedAt: createdAt,
          expectedCollectionEventId: signedEvent.id,
        }
}

export function expectedOrganizerEventMarketFrontiersAfterRetry(
  delivery: {
    record: "calendar" | "pickup" | "collection"
    signedEvent: SignedPublicNostrEvent | null
  },
  savedReference: SavedOrganizerEventMarketReference | undefined
): Partial<SavedOrganizerEventMarketReference> {
  const signedEvent = delivery.signedEvent
  const frontier = expectedOrganizerEventMarketFrontier(delivery)
  if (!signedEvent) return frontier
  if (delivery.record !== "collection" || !savedReference) return frontier

  const collectionCalendarCoordinate = signedEvent.tags
    .filter((tag) => tag[0] === "a")
    .map((tag) =>
      parseAddressableCoordinate(tag[1] ?? "", [
        EVENT_KINDS.CALENDAR_DATE,
        EVENT_KINDS.CALENDAR_TIME,
      ])
    )
    .find(
      (coordinate) =>
        coordinate?.authorPubkey === signedEvent.pubkey.toLowerCase()
    )?.coordinate
  const collectionPickupCoordinate = signedEvent.tags
    .filter((tag) => tag[0] === "shipping_option")
    .map((tag) =>
      parseAddressableCoordinate(tag[1] ?? "", [EVENT_KINDS.SHIPPING_OPTION])
    )
    .find(
      (coordinate) =>
        coordinate?.authorPubkey === signedEvent.pubkey.toLowerCase()
    )?.coordinate
  const savedCalendar = savedExpectedFrontier(savedReference, "calendar")
  const savedPickup = savedExpectedFrontier(savedReference, "pickup")
  const collectionRetainsCalendar =
    !!collectionCalendarCoordinate &&
    savedCalendar?.coordinate === collectionCalendarCoordinate
  const collectionRetainsPickup =
    !!collectionPickupCoordinate &&
    savedPickup?.coordinate === collectionPickupCoordinate

  return {
    ...frontier,
    ...(collectionRetainsCalendar
      ? expectedFrontierFields("calendar", savedCalendar)
      : {}),
    ...(collectionRetainsPickup
      ? expectedFrontierFields("pickup", savedPickup)
      : {}),
    // A replacement collection owns its child relationships. Any saved child
    // frontier not referenced by this exact signed revision must be retired.
    replaceExpectedRecordFrontiers: true,
  }
}

export function expectedOrganizerEventMarketFrontiersAfterMembership(
  delivery: {
    record: "calendar" | "pickup" | "collection"
    signedEvent: SignedPublicNostrEvent | null
  },
  market: EventMarketFrontierCarrier
): Partial<SavedOrganizerEventMarketReference> {
  return {
    ...expectedOrganizerEventMarketFrontier(delivery),
    ...expectedFrontierFields("calendar", carrierFrontier(market, "calendar")),
    ...expectedFrontierFields("pickup", carrierFrontier(market, "pickup")),
    // The just-signed collection retains the exact child relationships from
    // this resolved graph. Omitted pickup fields therefore retire an older
    // saved pickup instead of inheriting it across the membership mutation.
    replaceExpectedRecordFrontiers: true,
  }
}

const EVENT_MARKET_STORAGE_PREFIX = "conduit:merchant:event-markets:v1"
const DISCOVERED_EVENT_MARKET_STORAGE_PREFIX =
  "conduit:merchant:discovered-event-markets:v1"
const PRODUCT_COORDINATE_PATTERN = /^30402:[0-9a-f]{64}:.+$/i
// Core reads at most eight relays. Keep one slot available for the normal
// organizer/default fallback when a saved naddr is opened in a fresh session.
const SAVED_EVENT_MARKET_RELAY_HINT_LIMIT = 7

type NormalizedSavedOrganizerEventMarketReference =
  SavedOrganizerEventMarketReference & {
    coordinate: string
    organizerPubkey: string
    relayHints: string[]
  }

type EventMarketRecordFrontier = {
  createdAt: number
  eventId?: string
  coordinate?: string
}

type EventMarketFrontierCarrier = {
  collectionCoordinate?: string
  collectionCreatedAt?: number
  collectionEventId?: string
  calendarCoordinate?: string
  calendarCreatedAt?: number
  calendarEventId?: string
  pickupCoordinate?: string
  pickupCreatedAt?: number
  pickupEventId?: string
}

export interface OrganizerEventMarketTerminalResolution extends EventMarketFrontierCarrier {
  terminal: true
  state: "deleted"
  collectionCoordinate: string
  calendarCoordinate?: string
  pickupCoordinate?: string
  deletion: EventMarketDeletedRecordEvidence
  naddr: string
}

export interface OrganizerEventMarketPendingResolution extends EventMarketFrontierCarrier {
  terminal: true
  state: "pending"
  reason: "crossed_frontiers" | "saved_frontier_ahead"
  collectionCoordinate: string
  calendarCoordinate?: string
  pickupCoordinate?: string
  naddr: string
}

export type EventMarketRecord = "collection" | "calendar" | "pickup"

function eventMarketRecordKinds(record: EventMarketRecord): readonly number[] {
  return record === "collection"
    ? [EVENT_KINDS.PRODUCT_COLLECTION]
    : record === "calendar"
      ? [EVENT_KINDS.CALENDAR_DATE, EVENT_KINDS.CALENDAR_TIME]
      : [EVENT_KINDS.SHIPPING_OPTION]
}

export function organizerEventMarketSignedRecordCoordinate(
  record: EventMarketRecord,
  signedEvent: SignedPublicNostrEvent | null | undefined
): string | undefined {
  if (!signedEvent) return undefined
  const dTag = signedEvent.tags.find((tag) => tag[0] === "d")?.[1]
  if (!dTag) return undefined
  return parseAddressableCoordinate(
    `${signedEvent.kind}:${signedEvent.pubkey}:${dTag}`,
    eventMarketRecordKinds(record)
  )?.coordinate
}

function normalizedRecordCoordinate(
  value: unknown,
  record: EventMarketRecord
): string | undefined {
  return typeof value === "string"
    ? parseAddressableCoordinate(value, eventMarketRecordKinds(record))
        ?.coordinate
    : undefined
}

function normalizedCreatedAt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function normalizedEventId(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value)
    ? value.toLowerCase()
    : undefined
}

function compareEventMarketRecordFrontier(
  left: EventMarketRecordFrontier | undefined,
  right: EventMarketRecordFrontier | undefined
): number {
  if (!left) return right ? -1 : 0
  if (!right) return 1
  const createdAtDifference = left.createdAt - right.createdAt
  if (createdAtDifference !== 0) return createdAtDifference
  if (!left.eventId || !right.eventId || left.eventId === right.eventId) {
    return 0
  }
  // NIP-01 retains the lexicographically lowest id at equal timestamps.
  return left.eventId < right.eventId ? 1 : -1
}

function carrierFrontier(
  value: EventMarketFrontierCarrier | undefined,
  record: EventMarketRecord
): EventMarketRecordFrontier | undefined {
  const createdAt =
    record === "collection"
      ? value?.collectionCreatedAt
      : record === "calendar"
        ? value?.calendarCreatedAt
        : value?.pickupCreatedAt
  if (createdAt === undefined) return undefined
  const eventId =
    record === "collection"
      ? value?.collectionEventId
      : record === "calendar"
        ? value?.calendarEventId
        : value?.pickupEventId
  const coordinate =
    record === "collection"
      ? value?.collectionCoordinate
      : record === "calendar"
        ? value?.calendarCoordinate
        : value?.pickupCoordinate
  return {
    createdAt,
    ...(eventId ? { eventId } : {}),
    ...(coordinate ? { coordinate } : {}),
  }
}

function savedExpectedFrontier(
  value: SavedOrganizerEventMarketReference | undefined,
  record: EventMarketRecord
): EventMarketRecordFrontier | undefined {
  const expectedCreatedAt =
    record === "collection"
      ? value?.expectedCollectionCreatedAt
      : record === "calendar"
        ? value?.expectedCalendarCreatedAt
        : value?.expectedPickupCreatedAt
  if (expectedCreatedAt === undefined) return undefined
  const expectedEventId =
    record === "collection"
      ? value?.expectedCollectionEventId
      : record === "calendar"
        ? value?.expectedCalendarEventId
        : value?.expectedPickupEventId
  const expectedCoordinate =
    record === "collection"
      ? (value?.expectedCollectionCoordinate ??
        decodeEventMarketReference(value?.reference ?? "", [30405])?.coordinate)
      : record === "calendar"
        ? value?.expectedCalendarCoordinate
        : value?.expectedPickupCoordinate
  return {
    createdAt: expectedCreatedAt,
    ...(expectedEventId ? { eventId: expectedEventId } : {}),
    ...(expectedCoordinate ? { coordinate: expectedCoordinate } : {}),
  }
}

type EventMarketDeliveryFrontier = {
  record: EventMarketRecord
  signedEvent: SignedPublicNostrEvent | null
}

function signedDeliveryFrontier(
  delivery: EventMarketDeliveryFrontier | undefined
): EventMarketRecordFrontier | undefined {
  const signedEvent = delivery?.signedEvent
  if (!delivery || !signedEvent) return undefined
  const coordinate = organizerEventMarketSignedRecordCoordinate(
    delivery.record,
    signedEvent
  )
  return {
    createdAt: signedEvent.created_at * 1_000,
    eventId: signedEvent.id.toLowerCase(),
    ...(coordinate ? { coordinate } : {}),
  }
}

function eventMarketDeletionAppliesToFrontier(
  deletion: EventMarketDeletedRecordEvidence["deletions"][number],
  coordinate: string,
  frontier: EventMarketRecordFrontier | undefined
): boolean {
  if (deletion.authorPubkey !== coordinate.split(":")[1]?.toLowerCase()) {
    return false
  }
  if (
    frontier?.eventId &&
    deletion.eventTargets.includes(frontier.eventId.toLowerCase())
  ) {
    return true
  }
  if (
    !frontier ||
    frontier.coordinate !== coordinate ||
    !deletion.addressableTargets.includes(coordinate)
  ) {
    return false
  }
  // NIP-09 applies an addressable deletion to every matching revision whose
  // created_at is at or before the deletion timestamp. The NIP-01 event-id
  // tie-break only chooses between competing replaceable records; a kind-5
  // deletion is not part of that replacement chain.
  return deletion.deletionCreatedAt >= frontier.createdAt
}

export function organizerEventMarketDeletionRetiresDelivery(
  terminal: OrganizerEventMarketTerminalResolution,
  delivery: EventMarketDeliveryFrontier
): boolean {
  if (terminal.deletion.record !== delivery.record) return false
  const frontier = signedDeliveryFrontier(delivery)
  if (!frontier?.coordinate) return false
  return terminal.deletion.deletions.some((deletion) =>
    eventMarketDeletionAppliesToFrontier(
      deletion,
      terminal.deletion.coordinate,
      frontier
    )
  )
}

export function organizerEventMarketRetryRemainsCurrent(
  delivery: EventMarketDeliveryFrontier,
  savedReference: SavedOrganizerEventMarketReference | undefined,
  latestDelivery?: EventMarketDeliveryFrontier
): boolean {
  const retry = signedDeliveryFrontier(delivery)
  if (!retry) return false
  const stillReaches = (
    current: EventMarketRecordFrontier | undefined
  ): boolean =>
    !current ||
    ((!retry.coordinate ||
      !current.coordinate ||
      retry.coordinate === current.coordinate) &&
      compareEventMarketRecordFrontier(retry, current) >= 0)

  return (
    stillReaches(savedExpectedFrontier(savedReference, delivery.record)) &&
    (latestDelivery?.record !== delivery.record ||
      stillReaches(signedDeliveryFrontier(latestDelivery)))
  )
}

function mergeRecordFrontier(
  references: readonly NormalizedSavedOrganizerEventMarketReference[],
  record: EventMarketRecord
): EventMarketRecordFrontier | undefined {
  return references.reduce<EventMarketRecordFrontier | undefined>(
    (current, reference) => {
      const candidate = savedExpectedFrontier(reference, record)
      return compareEventMarketRecordFrontier(candidate, current) > 0
        ? candidate
        : current
    },
    undefined
  )
}

function expectedFrontierFields(
  record: EventMarketRecord,
  frontier: EventMarketRecordFrontier | undefined
): Partial<SavedOrganizerEventMarketReference> {
  if (!frontier) return {}
  if (record === "collection") {
    return {
      ...(frontier.coordinate
        ? { expectedCollectionCoordinate: frontier.coordinate }
        : {}),
      expectedCollectionCreatedAt: frontier.createdAt,
      ...(frontier.eventId
        ? { expectedCollectionEventId: frontier.eventId }
        : {}),
    }
  }
  if (record === "calendar") {
    return {
      ...(frontier.coordinate
        ? { expectedCalendarCoordinate: frontier.coordinate }
        : {}),
      expectedCalendarCreatedAt: frontier.createdAt,
      ...(frontier.eventId
        ? { expectedCalendarEventId: frontier.eventId }
        : {}),
    }
  }
  return {
    ...(frontier.coordinate
      ? { expectedPickupCoordinate: frontier.coordinate }
      : {}),
    expectedPickupCreatedAt: frontier.createdAt,
    ...(frontier.eventId ? { expectedPickupEventId: frontier.eventId } : {}),
  }
}

function organizerEventMarketTitleFrontiers(
  market: EventMarketFrontierCarrier | undefined
): {
  collection: EventMarketRecordFrontier
  calendar: EventMarketRecordFrontier
} | null {
  const collection = carrierFrontier(market, "collection")
  const calendar = carrierFrontier(market, "calendar")
  if (
    !collection?.coordinate ||
    !collection.eventId ||
    !calendar?.coordinate ||
    !calendar.eventId
  ) {
    return null
  }
  return { collection, calendar }
}

function savedOrganizerEventMarketTitleFrontiers(
  savedReference: SavedOrganizerEventMarketReference | undefined
): {
  collection: EventMarketRecordFrontier
  calendar: EventMarketRecordFrontier
} | null {
  if (!savedReference) return null
  const collectionCreatedAt = savedReference.titleCollectionCreatedAt
  const calendarCreatedAt = savedReference.titleCalendarCreatedAt
  const collectionCoordinate = normalizedRecordCoordinate(
    savedReference.titleCollectionCoordinate,
    "collection"
  )
  const calendarCoordinate = normalizedRecordCoordinate(
    savedReference.titleCalendarCoordinate,
    "calendar"
  )
  const collectionEventId = normalizedEventId(
    savedReference.titleCollectionEventId
  )
  const calendarEventId = normalizedEventId(savedReference.titleCalendarEventId)
  if (
    collectionCreatedAt === undefined ||
    calendarCreatedAt === undefined ||
    !collectionCoordinate ||
    !calendarCoordinate ||
    !collectionEventId ||
    !calendarEventId
  ) {
    return null
  }
  return {
    collection: {
      coordinate: collectionCoordinate,
      createdAt: collectionCreatedAt,
      eventId: collectionEventId,
    },
    calendar: {
      coordinate: calendarCoordinate,
      createdAt: calendarCreatedAt,
      eventId: calendarEventId,
    },
  }
}

function titleFrontierFields(
  frontiers: {
    collection: EventMarketRecordFrontier
    calendar: EventMarketRecordFrontier
  } | null
): Partial<SavedOrganizerEventMarketReference> {
  if (!frontiers) return {}
  return {
    titleCollectionCoordinate: frontiers.collection.coordinate,
    titleCollectionCreatedAt: frontiers.collection.createdAt,
    titleCollectionEventId: frontiers.collection.eventId,
    titleCalendarCoordinate: frontiers.calendar.coordinate,
    titleCalendarCreatedAt: frontiers.calendar.createdAt,
    titleCalendarEventId: frontiers.calendar.eventId,
  }
}

export function expectedOrganizerEventMarketTitleFrontiers(
  market: EventMarketFrontierCarrier | undefined
): Partial<SavedOrganizerEventMarketReference> {
  return titleFrontierFields(organizerEventMarketTitleFrontiers(market))
}

export function organizerEventMarketHasSavedTitleEvidence(
  market:
    (EventMarketFrontierCarrier & { state: string; title: string }) | undefined,
  savedReference: SavedOrganizerEventMarketReference | undefined
): boolean {
  const frontiers = organizerEventMarketTitleFrontiers(market)
  const savedFrontiers = savedOrganizerEventMarketTitleFrontiers(savedReference)
  const marketTitle = normalizeOrganizerEventMarketTitle(market?.title)
  const savedTitle = normalizeOrganizerEventMarketTitle(savedReference?.title)
  if (
    !market ||
    !savedReference ||
    !frontiers ||
    !savedFrontiers ||
    !marketTitle ||
    !savedTitle
  ) {
    return false
  }
  return (
    savedTitle === marketTitle &&
    savedFrontiers.collection.coordinate === frontiers.collection.coordinate &&
    savedFrontiers.collection.createdAt === frontiers.collection.createdAt &&
    savedFrontiers.collection.eventId === frontiers.collection.eventId &&
    savedFrontiers.calendar.coordinate === frontiers.calendar.coordinate &&
    savedFrontiers.calendar.createdAt === frontiers.calendar.createdAt &&
    savedFrontiers.calendar.eventId === frontiers.calendar.eventId
  )
}

export function shortenOrganizerEventMarketReference(
  reference: string
): string {
  const decoded = decodeEventMarketReference(reference, [30405])
  const canonicalReference = decoded
    ? encodeEventMarketNaddr(decoded.coordinate)
    : reference.trim()
  if (canonicalReference.length <= 28) return canonicalReference
  return `${canonicalReference.slice(0, 16)}…${canonicalReference.slice(-8)}`
}

export function getOrganizerEventMarketStorageKey(
  organizerPubkey: string
): string {
  return `${EVENT_MARKET_STORAGE_PREFIX}:${organizerPubkey.trim().toLowerCase()}`
}

export function getDiscoveredEventMarketStorageKey(
  merchantPubkey: string
): string {
  return `${DISCOVERED_EVENT_MARKET_STORAGE_PREFIX}:${merchantPubkey.trim().toLowerCase()}`
}

function normalizeSavedReference(
  value: unknown
): NormalizedSavedOrganizerEventMarketReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const candidate = value as {
    reference?: unknown
    title?: unknown
    savedAt?: unknown
    titleCollectionCreatedAt?: unknown
    titleCollectionEventId?: unknown
    titleCollectionCoordinate?: unknown
    titleCalendarCreatedAt?: unknown
    titleCalendarEventId?: unknown
    titleCalendarCoordinate?: unknown
    expectedCollectionCreatedAt?: unknown
    expectedCollectionEventId?: unknown
    expectedCollectionCoordinate?: unknown
    expectedCalendarCreatedAt?: unknown
    expectedCalendarEventId?: unknown
    expectedCalendarCoordinate?: unknown
    expectedPickupCreatedAt?: unknown
    expectedPickupEventId?: unknown
    expectedPickupCoordinate?: unknown
    replaceExpectedRecordFrontiers?: unknown
  }
  const rawReference =
    typeof candidate.reference === "string" ? candidate.reference.trim() : ""
  const decoded = decodeEventMarketReference(rawReference, [30405])
  if (
    !decoded ||
    typeof candidate.savedAt !== "number" ||
    !Number.isFinite(candidate.savedAt)
  ) {
    return null
  }

  const title = normalizeOrganizerEventMarketTitle(candidate.title)
  const titleCollectionCreatedAt = normalizedCreatedAt(
    candidate.titleCollectionCreatedAt
  )
  const titleCollectionEventId = normalizedEventId(
    candidate.titleCollectionEventId
  )
  const titleCollectionCoordinate = normalizedRecordCoordinate(
    candidate.titleCollectionCoordinate,
    "collection"
  )
  const titleCalendarCreatedAt = normalizedCreatedAt(
    candidate.titleCalendarCreatedAt
  )
  const titleCalendarEventId = normalizedEventId(candidate.titleCalendarEventId)
  const titleCalendarCoordinate = normalizedRecordCoordinate(
    candidate.titleCalendarCoordinate,
    "calendar"
  )
  const hasCompleteTitleEvidence =
    !!title &&
    titleCollectionCreatedAt !== undefined &&
    !!titleCollectionEventId &&
    !!titleCollectionCoordinate &&
    titleCalendarCreatedAt !== undefined &&
    !!titleCalendarEventId &&
    !!titleCalendarCoordinate
  const expectedCollectionCreatedAt = normalizedCreatedAt(
    candidate.expectedCollectionCreatedAt
  )
  const expectedCollectionEventId = normalizedEventId(
    candidate.expectedCollectionEventId
  )
  const expectedCollectionCoordinate = normalizedRecordCoordinate(
    candidate.expectedCollectionCoordinate,
    "collection"
  )
  const expectedCalendarCreatedAt = normalizedCreatedAt(
    candidate.expectedCalendarCreatedAt
  )
  const expectedCalendarEventId = normalizedEventId(
    candidate.expectedCalendarEventId
  )
  const expectedCalendarCoordinate = normalizedRecordCoordinate(
    candidate.expectedCalendarCoordinate,
    "calendar"
  )
  const expectedPickupCreatedAt = normalizedCreatedAt(
    candidate.expectedPickupCreatedAt
  )
  const expectedPickupEventId = normalizedEventId(
    candidate.expectedPickupEventId
  )
  const expectedPickupCoordinate = normalizedRecordCoordinate(
    candidate.expectedPickupCoordinate,
    "pickup"
  )
  return {
    reference:
      decoded.relayHints.length > 0
        ? encodeEventMarketNaddr(decoded.coordinate, decoded.relayHints)
        : decoded.coordinate,
    title,
    savedAt: candidate.savedAt,
    ...(hasCompleteTitleEvidence
      ? {
          titleCollectionCreatedAt,
          titleCollectionEventId,
          titleCollectionCoordinate,
          titleCalendarCreatedAt,
          titleCalendarEventId,
          titleCalendarCoordinate,
        }
      : {}),
    ...(expectedCollectionCreatedAt !== undefined
      ? {
          expectedCollectionCreatedAt,
          ...(expectedCollectionCoordinate
            ? { expectedCollectionCoordinate }
            : {}),
        }
      : {}),
    ...(expectedCollectionCreatedAt !== undefined &&
    expectedCollectionEventId !== undefined
      ? { expectedCollectionEventId }
      : {}),
    ...(expectedCalendarCreatedAt !== undefined
      ? {
          expectedCalendarCreatedAt,
          ...(expectedCalendarCoordinate ? { expectedCalendarCoordinate } : {}),
        }
      : {}),
    ...(expectedCalendarCreatedAt !== undefined &&
    expectedCalendarEventId !== undefined
      ? { expectedCalendarEventId }
      : {}),
    ...(expectedPickupCreatedAt !== undefined
      ? {
          expectedPickupCreatedAt,
          ...(expectedPickupCoordinate ? { expectedPickupCoordinate } : {}),
        }
      : {}),
    ...(expectedPickupCreatedAt !== undefined &&
    expectedPickupEventId !== undefined
      ? { expectedPickupEventId }
      : {}),
    ...(candidate.replaceExpectedRecordFrontiers === true
      ? { replaceExpectedRecordFrontiers: true as const }
      : {}),
    coordinate: decoded.coordinate,
    organizerPubkey: decoded.authorPubkey,
    relayHints: decoded.relayHints,
  }
}

function mergeNormalizedSavedReferences(
  references: readonly NormalizedSavedOrganizerEventMarketReference[]
): SavedOrganizerEventMarketReference {
  const sorted = [...references].sort(
    (left, right) => right.savedAt - left.savedAt
  )
  const newest = sorted[0]!
  const mergedRelayHints = Array.from(
    new Set(sorted.flatMap((reference) => reference.relayHints))
  )
  const completeExplicitReference = sorted.find((reference) =>
    mergedRelayHints.every((relayUrl) =>
      reference.relayHints.includes(relayUrl)
    )
  )
  const relayHints = completeExplicitReference
    ? completeExplicitReference.relayHints
    : mergedRelayHints.slice(0, SAVED_EVENT_MARKET_RELAY_HINT_LIMIT)
  const replacementIndex = sorted.findIndex(
    (reference) => reference.replaceExpectedRecordFrontiers === true
  )
  const frontierReferences =
    replacementIndex >= 0 ? sorted.slice(0, replacementIndex + 1) : sorted
  const expectedCollection = mergeRecordFrontier(
    frontierReferences,
    "collection"
  )
  const expectedCalendar = mergeRecordFrontier(frontierReferences, "calendar")
  const expectedPickup = mergeRecordFrontier(frontierReferences, "pickup")
  const anchoredTitleSources = sorted.filter(
    (reference) =>
      !!reference.title && !!savedOrganizerEventMarketTitleFrontiers(reference)
  )
  const titleSource =
    anchoredTitleSources.reduce<
      NormalizedSavedOrganizerEventMarketReference | undefined
    >((current, candidate) => {
      if (!current) return candidate
      const candidateFrontiers =
        savedOrganizerEventMarketTitleFrontiers(candidate)!
      const currentFrontiers = savedOrganizerEventMarketTitleFrontiers(current)!
      if (
        candidateFrontiers.calendar.coordinate ===
        currentFrontiers.calendar.coordinate
      ) {
        const calendarComparison = compareEventMarketRecordFrontier(
          candidateFrontiers.calendar,
          currentFrontiers.calendar
        )
        if (calendarComparison !== 0) {
          return calendarComparison > 0 ? candidate : current
        }
      }
      const collectionComparison = compareEventMarketRecordFrontier(
        candidateFrontiers.collection,
        currentFrontiers.collection
      )
      if (collectionComparison !== 0) {
        return collectionComparison > 0 ? candidate : current
      }
      return candidate.savedAt > current.savedAt ? candidate : current
    }, undefined) ?? sorted.find((reference) => reference.title)
  return {
    reference:
      relayHints.length > 0
        ? encodeEventMarketNaddr(newest.coordinate, relayHints)
        : newest.coordinate,
    title: titleSource?.title,
    savedAt: newest.savedAt,
    ...titleFrontierFields(
      savedOrganizerEventMarketTitleFrontiers(titleSource)
    ),
    ...expectedFrontierFields("collection", expectedCollection),
    ...expectedFrontierFields("calendar", expectedCalendar),
    ...expectedFrontierFields("pickup", expectedPickup),
    ...(replacementIndex >= 0
      ? { replaceExpectedRecordFrontiers: true as const }
      : {}),
  }
}

/** Merge saved/imported views without dropping relay hints or signed frontiers. */
export function mergeSavedOrganizerEventMarketReferences(
  references: readonly SavedOrganizerEventMarketReference[]
): SavedOrganizerEventMarketReference[] {
  const byCoordinate = new Map<
    string,
    NormalizedSavedOrganizerEventMarketReference[]
  >()
  for (const reference of references) {
    const normalized = normalizeSavedReference(reference)
    if (!normalized) continue
    byCoordinate.set(normalized.coordinate, [
      ...(byCoordinate.get(normalized.coordinate) ?? []),
      normalized,
    ])
  }
  return Array.from(byCoordinate.values())
    .map(mergeNormalizedSavedReferences)
    .sort((left, right) => right.savedAt - left.savedAt)
}

function loadSavedReferences(
  storageKey: string,
  storage: Pick<Storage, "getItem">,
  expectedOrganizerPubkey?: string
): SavedOrganizerEventMarketReference[] {
  try {
    const raw = storage.getItem(storageKey)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []

    const byCoordinate = new Map<
      string,
      NormalizedSavedOrganizerEventMarketReference[]
    >()
    for (const value of parsed) {
      const normalized = normalizeSavedReference(value)
      if (
        !normalized ||
        (expectedOrganizerPubkey &&
          normalized.organizerPubkey !== expectedOrganizerPubkey)
      ) {
        continue
      }
      byCoordinate.set(normalized.coordinate, [
        ...(byCoordinate.get(normalized.coordinate) ?? []),
        normalized,
      ])
    }
    return Array.from(byCoordinate.values())
      .map(mergeNormalizedSavedReferences)
      .sort((left, right) => right.savedAt - left.savedAt)
  } catch {
    return []
  }
}

function rememberSavedReference(
  storageKey: string,
  entry: SavedOrganizerEventMarketReference,
  storage: Pick<Storage, "getItem" | "setItem">,
  expectedOrganizerPubkey?: string
): SavedOrganizerEventMarketReference[] {
  const normalized = normalizeSavedReference(entry)
  if (
    !normalized ||
    (expectedOrganizerPubkey &&
      normalized.organizerPubkey !== expectedOrganizerPubkey)
  ) {
    return loadSavedReferences(storageKey, storage, expectedOrganizerPubkey)
  }

  const current = loadSavedReferences(
    storageKey,
    storage,
    expectedOrganizerPubkey
  )
  const sameIdentity = current.flatMap((item) => {
    const existing = normalizeSavedReference(item)
    return existing?.coordinate === normalized.coordinate ? [existing] : []
  })
  const merged = mergeNormalizedSavedReferences([normalized, ...sameIdentity])
  const next = [
    merged,
    ...current.filter((item) => {
      const existing = normalizeSavedReference(item)
      return existing?.coordinate !== normalized.coordinate
    }),
  ].sort((left, right) => right.savedAt - left.savedAt)
  try {
    storage.setItem(storageKey, JSON.stringify(next))
  } catch {
    // The public coordinate remains usable for this session when storage is
    // unavailable. Relay evidence, not local storage, is authoritative.
  }
  return next
}

export function loadSavedOrganizerEventMarkets(
  organizerPubkey: string,
  storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined"
    ? null
    : localStorage
): SavedOrganizerEventMarketReference[] {
  if (!organizerPubkey.trim() || !storage) return []
  return loadSavedReferences(
    getOrganizerEventMarketStorageKey(organizerPubkey),
    storage,
    organizerPubkey.trim().toLowerCase()
  )
}

export function loadSavedDiscoveredEventMarkets(
  merchantPubkey: string,
  storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined"
    ? null
    : localStorage
): SavedOrganizerEventMarketReference[] {
  if (!merchantPubkey.trim() || !storage) return []
  return loadSavedReferences(
    getDiscoveredEventMarketStorageKey(merchantPubkey),
    storage
  )
}

export function rememberOrganizerEventMarket(
  organizerPubkey: string,
  entry: SavedOrganizerEventMarketReference,
  storage: Pick<Storage, "getItem" | "setItem"> | null = typeof localStorage ===
  "undefined"
    ? null
    : localStorage
): SavedOrganizerEventMarketReference[] {
  if (!organizerPubkey.trim() || !storage) return []
  const normalizedOrganizer = organizerPubkey.trim().toLowerCase()
  return rememberSavedReference(
    getOrganizerEventMarketStorageKey(organizerPubkey),
    entry,
    storage,
    normalizedOrganizer
  )
}

export function rememberDiscoveredEventMarket(
  merchantPubkey: string,
  entry: SavedOrganizerEventMarketReference,
  storage: Pick<Storage, "getItem" | "setItem"> | null = typeof localStorage ===
  "undefined"
    ? null
    : localStorage
): SavedOrganizerEventMarketReference[] {
  if (!merchantPubkey.trim() || !storage) return []
  return rememberSavedReference(
    getDiscoveredEventMarketStorageKey(merchantPubkey),
    entry,
    storage
  )
}

export function forgetOrganizerEventMarket(
  organizerPubkey: string,
  reference: string,
  storage: Pick<Storage, "getItem" | "setItem"> | null = typeof localStorage ===
  "undefined"
    ? null
    : localStorage
): SavedOrganizerEventMarketReference[] {
  if (!organizerPubkey.trim() || !storage) return []
  const target = decodeEventMarketReference(reference, [30405])
  const next = loadSavedOrganizerEventMarkets(organizerPubkey, storage).filter(
    (item) => {
      const existing = decodeEventMarketReference(item.reference, [30405])
      return target
        ? existing?.coordinate !== target.coordinate
        : item.reference !== reference.trim()
    }
  )
  try {
    storage.setItem(
      getOrganizerEventMarketStorageKey(organizerPubkey),
      JSON.stringify(next)
    )
  } catch {
    // Keep local-storage failure from blocking organizer relay workflows.
  }
  return next
}

export function findSavedOrganizerEventMarketReference(
  references: readonly SavedOrganizerEventMarketReference[],
  reference: string
): SavedOrganizerEventMarketReference | undefined {
  const target = decodeEventMarketReference(reference, [30405])
  if (!target) return undefined
  return references.find(
    (item) =>
      decodeEventMarketReference(item.reference, [30405])?.coordinate ===
      target.coordinate
  )
}

export function isPreferredOrganizerEventMarketListResolution(
  market: { state: string } | undefined
): boolean {
  return (
    market !== undefined &&
    market.state !== "missing" &&
    market.state !== "unavailable" &&
    market.state !== "stale" &&
    market.state !== "deleted"
  )
}

export function shouldResolveOrganizerEventMarketReference(
  listMarket: ({ state: string } & EventMarketFrontierCarrier) | undefined,
  savedReference: SavedOrganizerEventMarketReference | undefined
): boolean {
  if (!isPreferredOrganizerEventMarketListResolution(listMarket)) return true
  const expectedRecords = expectedEventMarketRecords(savedReference)
  const importedRelayHints = decodeEventMarketReference(
    savedReference?.reference ?? "",
    [30405]
  )?.relayHints
  if (expectedRecords.length === 0 && (importedRelayHints?.length ?? 0) > 0) {
    return true
  }
  return !marketReachesExpectedFrontiers(
    listMarket,
    savedReference,
    expectedRecords
  )
}

function reconcileOrganizerEventMarketNaddr(
  coordinate: string,
  references: readonly (string | undefined)[]
): string {
  const hintGroups = references.map(
    (reference) =>
      decodeEventMarketReference(reference ?? "", [30405])?.relayHints ?? []
  )
  const mergedRelayHints = Array.from(new Set(hintGroups.flat()))
  const completeExplicitHints = hintGroups.find((relayHints) =>
    mergedRelayHints.every((relayUrl) => relayHints.includes(relayUrl))
  )
  const relayHints = completeExplicitHints
    ? completeExplicitHints
    : mergedRelayHints.slice(0, SAVED_EVENT_MARKET_RELAY_HINT_LIMIT)
  return encodeEventMarketNaddr(coordinate, relayHints)
}

const EVENT_MARKET_RECORDS = ["collection", "calendar", "pickup"] as const

function expectedEventMarketRecords(
  savedReference: SavedOrganizerEventMarketReference | undefined
): EventMarketRecord[] {
  return EVENT_MARKET_RECORDS.filter((record) =>
    savedExpectedFrontier(savedReference, record)
  )
}

function marketReachesExpectedFrontiers(
  market: EventMarketFrontierCarrier | undefined,
  savedReference: SavedOrganizerEventMarketReference | undefined,
  expectedRecords = expectedEventMarketRecords(savedReference)
): boolean {
  if (market?.calendarCoordinate && !carrierFrontier(market, "calendar")) {
    return false
  }
  if (market?.pickupCoordinate && !carrierFrontier(market, "pickup")) {
    return false
  }
  return expectedRecords.every((record) => {
    const current = carrierFrontier(market, record)
    const expected = savedExpectedFrontier(savedReference, record)
    if (
      record === "calendar" &&
      expected?.coordinate &&
      market?.calendarCoordinate !== expected.coordinate
    ) {
      if (!market?.calendarCoordinate || !current) return false
      // The collection owns the event-calendar relationship. A strictly newer
      // collection may replace the calendar coordinate without inheriting the
      // unrelated record timestamp of the previously linked calendar.
      const currentCollection = carrierFrontier(market, "collection")
      const expectedCollection = savedExpectedFrontier(
        savedReference,
        "collection"
      )
      return (
        !!currentCollection &&
        !!expectedCollection &&
        compareEventMarketRecordFrontier(
          currentCollection,
          expectedCollection
        ) > 0
      )
    }
    if (
      record === "pickup" &&
      expected?.coordinate &&
      market?.pickupCoordinate !== expected.coordinate
    ) {
      // The collection owns the organizer-pickup relationship. Only a strictly
      // newer collection can retire or replace a previously saved pickup.
      const currentCollection = carrierFrontier(market, "collection")
      const expectedCollection = savedExpectedFrontier(
        savedReference,
        "collection"
      )
      return (
        !!currentCollection &&
        !!expectedCollection &&
        compareEventMarketRecordFrontier(
          currentCollection,
          expectedCollection
        ) > 0
      )
    }
    if (!current || !expected) return false
    if (
      current.createdAt === expected.createdAt &&
      expected.eventId &&
      !current.eventId
    ) {
      return false
    }
    return compareEventMarketRecordFrontier(current, expected) >= 0
  })
}

export function organizerEventMarketReachesExpectedFrontiers(
  market: EventMarketFrontierCarrier | undefined,
  savedReference: SavedOrganizerEventMarketReference | undefined
): boolean {
  return marketReachesExpectedFrontiers(market, savedReference)
}

export function organizerEventMarketCanSupplySavedTitle(
  market:
    (EventMarketFrontierCarrier & { state: string; title: string }) | undefined,
  savedReference: SavedOrganizerEventMarketReference | undefined
): boolean {
  const titleFrontiers = organizerEventMarketTitleFrontiers(market)
  if (
    !market ||
    !savedReference ||
    !titleFrontiers ||
    !marketReachesExpectedFrontiers(market, savedReference)
  ) {
    return false
  }
  const marketTitle = normalizeOrganizerEventMarketTitle(market.title)
  const savedTitle = normalizeOrganizerEventMarketTitle(savedReference.title)
  if (!marketTitle) return false
  const savedTitleFrontiers =
    savedOrganizerEventMarketTitleFrontiers(savedReference)
  const savedTitleIsAnchored = !!savedTitleFrontiers
  if (savedTitle && savedTitle !== marketTitle && !savedTitleIsAnchored) {
    return false
  }
  if (
    savedTitleFrontiers &&
    !marketReachesExpectedFrontiers(
      market,
      {
        reference: savedReference.reference,
        savedAt: savedReference.savedAt,
        ...expectedFrontierFields("collection", savedTitleFrontiers.collection),
        ...expectedFrontierFields("calendar", savedTitleFrontiers.calendar),
      },
      ["collection", "calendar"]
    )
  ) {
    return false
  }
  return (
    !savedTitle ||
    savedTitle === marketTitle ||
    isPreferredOrganizerEventMarketListResolution(market)
  )
}

type OrganizerEventMarketCandidate = EventMarketFrontierCarrier & {
  state: string
  collectionCoordinate: string
  calendarCoordinate?: string
  pickupCoordinate?: string
  naddr: string
}

function terminalDeletionRemovesMarket(
  terminal: OrganizerEventMarketTerminalResolution,
  market: OrganizerEventMarketCandidate | undefined,
  savedReference: SavedOrganizerEventMarketReference | undefined
): boolean {
  const record = terminal.deletion.record
  const coordinate =
    record === "collection"
      ? terminal.collectionCoordinate
      : record === "calendar"
        ? terminal.calendarCoordinate
        : terminal.pickupCoordinate
  if (!coordinate || coordinate !== terminal.deletion.coordinate) return false

  if (record === "pickup" && market?.pickupCoordinate !== coordinate) {
    const marketCollection = carrierFrontier(market, "collection")
    const deletedPickupCollection = carrierFrontier(terminal, "collection")
    // A pickup tombstone belongs to the collection revision that advertised
    // that pickup. It cannot retire a strictly newer collection that removed
    // or replaced the relationship.
    if (
      marketCollection &&
      deletedPickupCollection &&
      compareEventMarketRecordFrontier(
        marketCollection,
        deletedPickupCollection
      ) > 0
    ) {
      return false
    }
  }

  const deletionAppliesToFrontier = (
    frontier: EventMarketRecordFrontier | undefined
  ): boolean =>
    terminal.deletion.deletions.some((deletion) =>
      eventMarketDeletionAppliesToFrontier(deletion, coordinate, frontier)
    )

  const knownFrontiers = [
    carrierFrontier(terminal, record),
    carrierFrontier(market, record),
    savedExpectedFrontier(savedReference, record),
  ].filter(
    (frontier, index, values): frontier is EventMarketRecordFrontier =>
      !!frontier &&
      values.findIndex(
        (candidate) =>
          candidate?.createdAt === frontier.createdAt &&
          candidate?.eventId === frontier.eventId
      ) === index
  )
  if (knownFrontiers.length > 0) {
    return knownFrontiers.every(deletionAppliesToFrontier)
  }
  return terminal.deletion.deletions.some(
    (deletion) =>
      deletion.authorPubkey === coordinate.split(":")[1]?.toLowerCase() &&
      deletion.addressableTargets.includes(coordinate)
  )
}

function compareOrganizerEventMarketGraphFrontier(
  left: EventMarketFrontierCarrier,
  right: EventMarketFrontierCarrier
): number | null {
  const collectionComparison = compareEventMarketRecordFrontier(
    carrierFrontier(left, "collection"),
    carrierFrontier(right, "collection")
  )
  const calendarRelationshipMatches =
    left.calendarCoordinate === right.calendarCoordinate
  const pickupRelationshipMatches =
    left.pickupCoordinate === right.pickupCoordinate
  // Equal collection revisions cannot truthfully advertise different linked
  // records. Across revisions, compare a child frontier only while both
  // collections still advertise the same coordinate.
  if (
    (!calendarRelationshipMatches || !pickupRelationshipMatches) &&
    collectionComparison === 0
  ) {
    return null
  }
  const comparisons = [
    collectionComparison,
    ...(calendarRelationshipMatches
      ? [
          compareEventMarketRecordFrontier(
            carrierFrontier(left, "calendar"),
            carrierFrontier(right, "calendar")
          ),
        ]
      : []),
    ...(pickupRelationshipMatches
      ? [
          compareEventMarketRecordFrontier(
            carrierFrontier(left, "pickup"),
            carrierFrontier(right, "pickup")
          ),
        ]
      : []),
  ]
  const advances = comparisons.some((comparison) => comparison > 0)
  const regresses = comparisons.some((comparison) => comparison < 0)
  if (advances && regresses) return null
  if (advances && !regresses) return 1
  if (regresses && !advances) return -1
  return comparisons[0] ?? 0
}

function pendingOrganizerEventMarketResolution(
  reason: OrganizerEventMarketPendingResolution["reason"],
  primary:
    OrganizerEventMarketCandidate | OrganizerEventMarketTerminalResolution,
  secondary?: OrganizerEventMarketCandidate
): OrganizerEventMarketPendingResolution {
  return {
    terminal: true,
    state: "pending",
    reason,
    collectionCoordinate: primary.collectionCoordinate,
    ...(primary.calendarCoordinate
      ? { calendarCoordinate: primary.calendarCoordinate }
      : secondary?.calendarCoordinate
        ? { calendarCoordinate: secondary.calendarCoordinate }
        : {}),
    ...(primary.pickupCoordinate
      ? { pickupCoordinate: primary.pickupCoordinate }
      : secondary?.pickupCoordinate
        ? { pickupCoordinate: secondary.pickupCoordinate }
        : {}),
    naddr: primary.naddr,
  }
}

export function selectOrganizerEventMarketResolution<
  T extends OrganizerEventMarketCandidate,
>(
  listMarket: T | undefined,
  hintedMarket: T | undefined,
  savedReference?: SavedOrganizerEventMarketReference
): T | OrganizerEventMarketPendingResolution | undefined
export function selectOrganizerEventMarketResolution<
  T extends OrganizerEventMarketCandidate,
>(
  listMarket: T | undefined,
  hintedMarket: T | OrganizerEventMarketTerminalResolution | undefined,
  savedReference?: SavedOrganizerEventMarketReference
):
  | T
  | OrganizerEventMarketTerminalResolution
  | OrganizerEventMarketPendingResolution
  | undefined
export function selectOrganizerEventMarketResolution<
  T extends OrganizerEventMarketCandidate,
>(
  listMarket: T | undefined,
  hintedMarket: T | OrganizerEventMarketTerminalResolution | undefined,
  savedReference?: SavedOrganizerEventMarketReference
):
  | T
  | OrganizerEventMarketTerminalResolution
  | OrganizerEventMarketPendingResolution
  | undefined {
  const expectedRecords = expectedEventMarketRecords(savedReference)
  const listReachesExpectedFrontiers = marketReachesExpectedFrontiers(
    listMarket,
    savedReference,
    expectedRecords
  )
  const hintedIsPreferred =
    isPreferredOrganizerEventMarketListResolution(hintedMarket)
  const preferredListMarket =
    isPreferredOrganizerEventMarketListResolution(listMarket) && listMarket
      ? listMarket
      : undefined
  const comparableHintedMarket =
    hintedIsPreferred && hintedMarket ? hintedMarket : undefined
  const graphFrontierComparison =
    preferredListMarket && comparableHintedMarket
      ? compareOrganizerEventMarketGraphFrontier(
          comparableHintedMarket,
          preferredListMarket
        )
      : undefined
  const selected =
    hintedMarket?.state === "deleted" && "terminal" in hintedMarket
      ? terminalDeletionRemovesMarket(
          hintedMarket,
          preferredListMarket,
          savedReference
        )
        ? hintedMarket
        : (preferredListMarket ??
          (savedExpectedFrontier(savedReference, hintedMarket.deletion.record)
            ? pendingOrganizerEventMarketResolution(
                "saved_frontier_ahead",
                hintedMarket
              )
            : undefined))
      : preferredListMarket
        ? comparableHintedMarket
          ? graphFrontierComparison === null
            ? pendingOrganizerEventMarketResolution(
                "crossed_frontiers",
                comparableHintedMarket,
                preferredListMarket
              )
            : (graphFrontierComparison ?? 0) > 0
              ? comparableHintedMarket
              : preferredListMarket
          : preferredListMarket
        : (hintedMarket ?? listMarket)
  if (!selected) return undefined
  const selectedReferenceIsAheadOfList =
    expectedRecords.length > 0 && !listReachesExpectedFrontiers
  const reconciledNaddr = reconcileOrganizerEventMarketNaddr(
    selected.collectionCoordinate,
    selectedReferenceIsAheadOfList
      ? [
          savedReference?.reference,
          selected.naddr,
          hintedMarket?.naddr,
          preferredListMarket?.naddr,
        ]
      : [
          selected.naddr,
          savedReference?.reference,
          hintedMarket?.naddr,
          preferredListMarket?.naddr,
        ]
  )
  if (reconciledNaddr === selected.naddr) return selected
  return {
    ...selected,
    naddr: reconciledNaddr,
  }
}

export function updateOrganizerCollectionProducts(
  currentProductCoordinates: readonly string[],
  productCoordinate: string,
  action: OrganizerCollectionMembershipAction
): string[] {
  const normalizedTarget = productCoordinate.trim()
  if (!PRODUCT_COORDINATE_PATTERN.test(normalizedTarget)) {
    throw new Error("Expected an exact kind-30402 product coordinate.")
  }

  const current = Array.from(
    new Set(
      currentProductCoordinates
        .map((coordinate) => coordinate.trim())
        .filter((coordinate) => PRODUCT_COORDINATE_PATTERN.test(coordinate))
    )
  )
  if (action === "remove") {
    return current.filter((coordinate) => coordinate !== normalizedTarget)
  }
  return current.includes(normalizedTarget)
    ? current
    : [...current, normalizedTarget]
}

export type OrganizerEventMarketDisplayState =
  "active" | "ended" | "degraded" | "deleted" | "unavailable"

export function getOrganizerEventMarketDisplayState(
  state: string
): OrganizerEventMarketDisplayState {
  switch (state) {
    case "active":
      return "active"
    case "ended":
      return "ended"
    case "deleted":
      return "deleted"
    case "partial":
    case "stale":
    case "missing":
    case "malformed":
    case "conflicting":
    case "unsupported":
      return "degraded"
    default:
      return "unavailable"
  }
}
