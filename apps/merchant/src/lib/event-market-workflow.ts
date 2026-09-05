import {
  decodeEventMarketReference,
  encodeEventMarketNaddr,
} from "@conduit/core"

export type OrganizerCollectionMembershipAction = "accept" | "remove"

export interface SavedOrganizerEventMarketReference {
  reference: string
  title?: string
  savedAt: number
  expectedCollectionCreatedAt?: number
  expectedCollectionEventId?: string
  expectedCalendarCreatedAt?: number
  expectedCalendarEventId?: string
  expectedPickupCreatedAt?: number
  expectedPickupEventId?: string
  replaceExpectedRecordFrontiers?: true
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
}

type EventMarketFrontierCarrier = {
  collectionCreatedAt?: number
  collectionEventId?: string
  calendarCreatedAt?: number
  calendarEventId?: string
  pickupCreatedAt?: number
  pickupEventId?: string
}

export interface OrganizerEventMarketTerminalResolution extends EventMarketFrontierCarrier {
  terminal: true
  state: "deleted"
  collectionCoordinate: string
  naddr: string
}

type EventMarketRecord = "collection" | "calendar" | "pickup"

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
  return {
    createdAt,
    ...(eventId ? { eventId } : {}),
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
  return {
    createdAt: expectedCreatedAt,
    ...(expectedEventId ? { eventId: expectedEventId } : {}),
  }
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
      expectedCollectionCreatedAt: frontier.createdAt,
      ...(frontier.eventId
        ? { expectedCollectionEventId: frontier.eventId }
        : {}),
    }
  }
  if (record === "calendar") {
    return {
      expectedCalendarCreatedAt: frontier.createdAt,
      ...(frontier.eventId
        ? { expectedCalendarEventId: frontier.eventId }
        : {}),
    }
  }
  return {
    expectedPickupCreatedAt: frontier.createdAt,
    ...(frontier.eventId ? { expectedPickupEventId: frontier.eventId } : {}),
  }
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
    expectedCollectionCreatedAt?: unknown
    expectedCollectionEventId?: unknown
    expectedCalendarCreatedAt?: unknown
    expectedCalendarEventId?: unknown
    expectedPickupCreatedAt?: unknown
    expectedPickupEventId?: unknown
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

  const title =
    typeof candidate.title === "string" && candidate.title.trim()
      ? candidate.title.trim()
      : undefined
  const expectedCollectionCreatedAt = normalizedCreatedAt(
    candidate.expectedCollectionCreatedAt
  )
  const expectedCollectionEventId = normalizedEventId(
    candidate.expectedCollectionEventId
  )
  const expectedCalendarCreatedAt = normalizedCreatedAt(
    candidate.expectedCalendarCreatedAt
  )
  const expectedCalendarEventId = normalizedEventId(
    candidate.expectedCalendarEventId
  )
  const expectedPickupCreatedAt = normalizedCreatedAt(
    candidate.expectedPickupCreatedAt
  )
  const expectedPickupEventId = normalizedEventId(
    candidate.expectedPickupEventId
  )
  return {
    reference:
      decoded.relayHints.length > 0
        ? encodeEventMarketNaddr(decoded.coordinate, decoded.relayHints)
        : decoded.coordinate,
    title,
    savedAt: candidate.savedAt,
    ...(expectedCollectionCreatedAt !== undefined
      ? { expectedCollectionCreatedAt }
      : {}),
    ...(expectedCollectionCreatedAt !== undefined &&
    expectedCollectionEventId !== undefined
      ? { expectedCollectionEventId }
      : {}),
    ...(expectedCalendarCreatedAt !== undefined
      ? { expectedCalendarCreatedAt }
      : {}),
    ...(expectedCalendarCreatedAt !== undefined &&
    expectedCalendarEventId !== undefined
      ? { expectedCalendarEventId }
      : {}),
    ...(expectedPickupCreatedAt !== undefined
      ? { expectedPickupCreatedAt }
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

function mergeSavedReferences(
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
  return {
    reference:
      relayHints.length > 0
        ? encodeEventMarketNaddr(newest.coordinate, relayHints)
        : newest.coordinate,
    title: newest.title ?? sorted.find((reference) => reference.title)?.title,
    savedAt: newest.savedAt,
    ...expectedFrontierFields("collection", expectedCollection),
    ...expectedFrontierFields("calendar", expectedCalendar),
    ...expectedFrontierFields("pickup", expectedPickup),
    ...(replacementIndex >= 0
      ? { replaceExpectedRecordFrontiers: true as const }
      : {}),
  }
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
      .map(mergeSavedReferences)
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
  const merged = mergeSavedReferences([normalized, ...sameIdentity])
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

export function findOrganizerEventMarketByReference<
  T extends { collectionCoordinate: string },
>(markets: readonly T[], reference: string): T | undefined {
  const target = decodeEventMarketReference(reference, [30405])
  if (!target) return undefined
  return markets.find(
    (market) => market.collectionCoordinate === target.coordinate
  )
}

export function isPreferredOrganizerEventMarketListResolution(
  market: { state: string } | undefined
): boolean {
  return (
    market !== undefined &&
    market.state !== "missing" &&
    market.state !== "unavailable" &&
    market.state !== "stale"
  )
}

export function shouldResolveOrganizerEventMarketReference(
  listMarket: ({ state: string } & EventMarketFrontierCarrier) | undefined,
  savedReference: SavedOrganizerEventMarketReference | undefined
): boolean {
  if (listMarket?.state === "deleted") return false
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
  return expectedRecords.every((record) => {
    const current = carrierFrontier(market, record)
    const expected = savedExpectedFrontier(savedReference, record)
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

function compareOrganizerEventMarketGraphFrontier(
  left: EventMarketFrontierCarrier,
  right: EventMarketFrontierCarrier
): number {
  const comparisons = EVENT_MARKET_RECORDS.map((record) =>
    compareEventMarketRecordFrontier(
      carrierFrontier(left, record),
      carrierFrontier(right, record)
    )
  )
  const advances = comparisons.some((comparison) => comparison > 0)
  const regresses = comparisons.some((comparison) => comparison < 0)
  if (advances && !regresses) return 1
  if (regresses && !advances) return -1
  return comparisons[0] ?? 0
}

export function selectOrganizerEventMarketResolution<
  T extends {
    state: string
    collectionCoordinate: string
    naddr: string
  } & EventMarketFrontierCarrier,
>(
  listMarket: T | undefined,
  hintedMarket: T | undefined,
  savedReference?: SavedOrganizerEventMarketReference
): T | undefined
export function selectOrganizerEventMarketResolution<
  T extends {
    state: string
    collectionCoordinate: string
    naddr: string
  } & EventMarketFrontierCarrier,
>(
  listMarket: T | undefined,
  hintedMarket: T | OrganizerEventMarketTerminalResolution | undefined,
  savedReference?: SavedOrganizerEventMarketReference
): T | OrganizerEventMarketTerminalResolution | undefined
export function selectOrganizerEventMarketResolution<
  T extends {
    state: string
    collectionCoordinate: string
    naddr: string
  } & EventMarketFrontierCarrier,
>(
  listMarket: T | undefined,
  hintedMarket: T | OrganizerEventMarketTerminalResolution | undefined,
  savedReference?: SavedOrganizerEventMarketReference
): T | OrganizerEventMarketTerminalResolution | undefined {
  const expectedRecords = expectedEventMarketRecords(savedReference)
  const listReachesExpectedFrontiers = marketReachesExpectedFrontiers(
    listMarket,
    savedReference,
    expectedRecords
  )
  const hintedReachesExpectedFrontiers = marketReachesExpectedFrontiers(
    hintedMarket,
    savedReference,
    expectedRecords
  )
  const hintedIsPreferred =
    isPreferredOrganizerEventMarketListResolution(hintedMarket)
  const preferredListMarket =
    isPreferredOrganizerEventMarketListResolution(listMarket) && listMarket
      ? listMarket
      : undefined
  const selected =
    listMarket?.state === "deleted"
      ? listMarket
      : hintedMarket?.state === "deleted"
        ? hintedMarket
        : preferredListMarket
          ? hintedIsPreferred && hintedMarket
            ? expectedRecords.length > 0 &&
              hintedReachesExpectedFrontiers !== listReachesExpectedFrontiers
              ? hintedReachesExpectedFrontiers
                ? hintedMarket
                : preferredListMarket
              : compareOrganizerEventMarketGraphFrontier(
                    hintedMarket,
                    preferredListMarket
                  ) > 0
                ? hintedMarket
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
