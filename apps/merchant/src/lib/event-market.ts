import {
  decodeEventMarketReference,
  discoverFollowedOrganizerEventMarkets,
  encodeEventMarketNaddr,
  getEventMarket,
  getOrganizerEventMarkets,
  isValidSignedPublicNostrEvent,
  publishOrganizerCollectionUpdate,
  publishOrganizerEventMarket,
  retryOrganizerEventMarketRecord,
  type FollowedEventMarketDiscoveryResult,
  type OrganizerEventMarketCalendarPublishInput,
  type OrganizerEventMarketCollectionPublishInput,
  type OrganizerEventMarketPickupPublishInput,
  type OrganizerEventMarketPublishResult,
  type OrganizerEventMarketSignedEvent,
  type OrganizerEventMarketSignedRecord,
  type SignedPublicNostrEvent,
  type EventMarketAcceptedProductEvidence,
  type EventMarketProductPreview,
  type EventMarketHandoffMode,
  type EventMarketParticipationRequest,
  type EventMarketResolution,
  type EventMarketResolutionState,
} from "@conduit/core"
import {
  epochSecondsToLocalDateTime,
  prepareOrganizerEventMarketForm,
  slugifyEventMarketTitle,
  type OrganizerEventMarketFormValues,
} from "./event-market-form"
import {
  updateOrganizerCollectionProducts,
  type OrganizerCollectionMembershipAction,
} from "./event-market-workflow"

export type MerchantOrganizerEventMarketState = EventMarketResolutionState

export type MerchantOrganizerEventRecord = "calendar" | "pickup" | "collection"

export interface MerchantOrganizerRecordDelivery {
  record: MerchantOrganizerEventRecord
  acknowledgedCount: number
  rejectedCount: number
  timedOutCount: number
  signedEvent: SignedPublicNostrEvent | null
}

export interface MerchantOrganizerParticipation {
  productCoordinate: string
  eventId?: string
  createdAt?: number
  title?: string
  merchantPubkey?: string
  productPreview?: EventMarketProductPreview
  fulfillmentStatus?: "none" | "ambiguous" | "resolved"
  fulfillmentReason?: string
  pickupCoordinate?: string
  pickupAuthorPubkey?: string
  handoffMode?: EventMarketHandoffMode
  handlerPubkey?: string
  status: "pending" | "accepted" | "organizer_only"
}

export interface MerchantOrganizerEventMarket {
  state: MerchantOrganizerEventMarketState
  organizerPubkey: string
  collectionCoordinate: string
  calendarCoordinate: string
  pickupCoordinate?: string
  pickupCoordinates: string[]
  naddr: string
  title: string
  summary?: string
  imageUrl?: string
  eventLocation?: string
  eventGeohash?: string
  calendarKind: 31922 | 31923
  start: string | number
  end?: string | number
  timezone?: string
  pickupTitle?: string
  pickupLocation?: string
  pickupGeohash?: string
  pickupCountry?: string
  pickupPrice?: string
  pickupCurrency?: string
  calendarCreatedAt?: number
  calendarEventId?: string
  pickupCreatedAt?: number
  pickupEventId?: string
  collectionCreatedAt?: number
  collectionEventId?: string
  productCoordinates: string[]
  participation: MerchantOrganizerParticipation[]
  source: EventMarketResolution
}

export interface MerchantOrganizerEventMarketDeletion {
  terminal: true
  state: "deleted"
  organizerPubkey: string
  collectionCoordinate: string
  naddr: string
}

export type MerchantOrganizerEventMarketRead =
  MerchantOrganizerEventMarket | MerchantOrganizerEventMarketDeletion

export interface MerchantOrganizerPublishResult {
  records: MerchantOrganizerRecordDelivery[]
  collectionCoordinate: string
  collectionCreatedAt: number
  naddr: string
}

export type MerchantEventMarketDiscovery = Omit<
  FollowedEventMarketDiscoveryResult,
  "markets"
> & {
  markets: MerchantOrganizerEventMarket[]
}

const EVENT_MARKET_DELIVERY_OUTBOX_PREFIX =
  "conduit:merchant:event-market-delivery:v1"
const EVENT_MARKET_DELIVERY_OUTBOX_LIMIT = 60

type StoredMerchantOrganizerDelivery = {
  reference: string
  delivery: MerchantOrganizerRecordDelivery
  savedAt: number
}

export interface MerchantOrganizerEventMarketReference {
  coordinate: string
  naddr: string
  relayHints: string[]
}

function eventMarketDeliveryStorageKey(organizerPubkey: string): string {
  return `${EVENT_MARKET_DELIVERY_OUTBOX_PREFIX}:${organizerPubkey.trim().toLowerCase()}`
}

function validStoredDelivery(
  value: unknown,
  organizerPubkey: string
): StoredMerchantOrganizerDelivery | null {
  const stored = asRecord(value)
  const delivery = asRecord(stored?.delivery)
  const signedEvent = delivery?.signedEvent as
    SignedPublicNostrEvent | null | undefined
  const reference = textValue(stored?.reference)
  const decodedReference = reference
    ? decodeEventMarketReference(reference, [30405])
    : null
  const record = textValue(delivery?.record)
  const expectedKind =
    record === "calendar"
      ? [31922, 31923]
      : record === "pickup"
        ? [30406]
        : record === "collection"
          ? [30405]
          : []
  const signedEventValid =
    !!signedEvent && isValidSignedPublicNostrEvent(signedEvent)
  if (
    !decodedReference ||
    decodedReference.authorPubkey !== organizerPubkey ||
    !signedEvent ||
    !signedEventValid
  ) {
    return null
  }
  const signedCollectionCoordinate =
    record === "collection"
      ? decodeEventMarketReference(
          `${signedEvent.kind}:${signedEvent.pubkey}:${singleSignedEventDTag(signedEvent) ?? ""}`,
          [30405]
        )?.coordinate
      : undefined
  if (
    !expectedKind.includes(signedEvent.kind) ||
    signedEvent.pubkey.toLowerCase() !== organizerPubkey ||
    (record === "collection" &&
      signedCollectionCoordinate !== decodedReference.coordinate)
  ) {
    return null
  }
  const count = (field: string): number => {
    const candidate = numberValue(delivery?.[field])
    return candidate !== undefined && candidate >= 0 ? Math.floor(candidate) : 0
  }
  return {
    reference: decodedReference.coordinate,
    delivery: {
      record: record as MerchantOrganizerEventRecord,
      acknowledgedCount: count("acknowledgedCount"),
      rejectedCount: count("rejectedCount"),
      timedOutCount: count("timedOutCount"),
      signedEvent,
    },
    savedAt: numberValue(stored?.savedAt) ?? 0,
  }
}

function singleSignedEventDTag(event: SignedPublicNostrEvent): string | null {
  const values = event.tags
    .filter((tag) => tag[0] === "d" && typeof tag[1] === "string")
    .map((tag) => tag[1]!)
  return values.length === 1 ? values[0]! : null
}

export function mergeOrganizerEventMarketDeliveryState(
  current: Record<string, MerchantOrganizerRecordDelivery[]>,
  reference: string,
  record: MerchantOrganizerRecordDelivery
): Record<string, MerchantOrganizerRecordDelivery[]> {
  const coordinate = parseOrganizerEventMarketReference(reference).coordinate
  return {
    ...current,
    [coordinate]: [
      ...(current[coordinate] ?? []).filter(
        (item) => item.record !== record.record
      ),
      record,
    ],
  }
}

export function loadOrganizerEventMarketDeliveryOutbox(
  organizerPubkey: string,
  storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined"
    ? null
    : localStorage
): Record<string, MerchantOrganizerRecordDelivery[]> {
  const normalizedOrganizer = organizerPubkey.trim().toLowerCase()
  if (!normalizedOrganizer || !storage) return {}
  try {
    const parsed = JSON.parse(
      storage.getItem(eventMarketDeliveryStorageKey(normalizedOrganizer)) ??
        "[]"
    ) as unknown
    if (!Array.isArray(parsed)) return {}
    const latest = new Map<string, StoredMerchantOrganizerDelivery>()
    for (const value of parsed) {
      const stored = validStoredDelivery(value, normalizedOrganizer)
      if (!stored) continue
      const key = `${stored.reference}:${stored.delivery.record}`
      const current = latest.get(key)
      if (!current || stored.savedAt >= current.savedAt) latest.set(key, stored)
    }
    const result: Record<string, MerchantOrganizerRecordDelivery[]> = {}
    for (const stored of latest.values()) {
      result[stored.reference] = [
        ...(result[stored.reference] ?? []),
        stored.delivery,
      ]
    }
    return result
  } catch {
    return {}
  }
}

function readStoredDeliveryRows(
  organizerPubkey: string,
  storage: Pick<Storage, "getItem">
): StoredMerchantOrganizerDelivery[] {
  const raw = storage.getItem(eventMarketDeliveryStorageKey(organizerPubkey))
  if (!raw) return []
  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed)) {
    throw new Error("Organizer delivery storage is malformed.")
  }
  return parsed.flatMap((value) => {
    const stored = validStoredDelivery(value, organizerPubkey)
    return stored ? [stored] : []
  })
}

export function saveOrganizerEventMarketDelivery(
  organizerPubkey: string,
  reference: string,
  delivery: MerchantOrganizerRecordDelivery,
  storage: Pick<Storage, "getItem" | "setItem"> | null = typeof localStorage ===
  "undefined"
    ? null
    : localStorage
): void {
  const normalizedOrganizer = organizerPubkey.trim().toLowerCase()
  if (!normalizedOrganizer || !storage) {
    throw new Error("Durable organizer delivery storage is unavailable.")
  }
  const candidate = validStoredDelivery(
    { reference, delivery, savedAt: Date.now() },
    normalizedOrganizer
  )
  if (!candidate) {
    throw new Error("Signed organizer delivery record is invalid.")
  }
  try {
    const latest = new Map<string, StoredMerchantOrganizerDelivery>()
    for (const stored of readStoredDeliveryRows(normalizedOrganizer, storage)) {
      const key = `${stored.reference}:${stored.delivery.record}`
      const current = latest.get(key)
      if (!current || stored.savedAt >= current.savedAt) latest.set(key, stored)
    }
    latest.set(`${candidate.reference}:${candidate.delivery.record}`, candidate)
    const sorted = Array.from(latest.values()).sort(
      (left, right) => right.savedAt - left.savedAt
    )
    const candidateKey = `${candidate.reference}:${candidate.delivery.record}`
    const required = sorted.filter(
      (stored) =>
        stored.delivery.acknowledgedCount === 0 ||
        stored.delivery.rejectedCount + stored.delivery.timedOutCount > 0 ||
        `${stored.reference}:${stored.delivery.record}` === candidateKey
    )
    if (required.length > EVENT_MARKET_DELIVERY_OUTBOX_LIMIT) {
      throw new Error("Organizer delivery storage is at capacity.")
    }
    const acknowledgedHistory = sorted.filter(
      (stored) =>
        stored.delivery.acknowledgedCount > 0 &&
        stored.delivery.rejectedCount + stored.delivery.timedOutCount === 0 &&
        `${stored.reference}:${stored.delivery.record}` !== candidateKey
    )
    const rows = [
      ...required,
      ...acknowledgedHistory.slice(
        0,
        Math.max(0, EVENT_MARKET_DELIVERY_OUTBOX_LIMIT - required.length)
      ),
    ]
    storage.setItem(
      eventMarketDeliveryStorageKey(normalizedOrganizer),
      JSON.stringify(rows)
    )
    const persisted = readStoredDeliveryRows(normalizedOrganizer, storage).find(
      (stored) =>
        stored.reference === candidate.reference &&
        stored.delivery.record === candidate.delivery.record
    )
    if (
      persisted?.delivery.signedEvent?.id !==
        candidate.delivery.signedEvent?.id ||
      persisted?.delivery.signedEvent?.sig !==
        candidate.delivery.signedEvent?.sig
    ) {
      throw new Error("Signed organizer delivery record was not retained.")
    }
  } catch {
    throw new Error(
      "The signed organizer record could not be saved for exact retry. Relay publishing was stopped."
    )
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function textValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

function numberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return undefined
}

function coordinateDTag(coordinate: string): string {
  return coordinate.split(":").slice(2).join(":")
}

function projectParticipation(
  item: EventMarketParticipationRequest | EventMarketAcceptedProductEvidence,
  status: MerchantOrganizerParticipation["status"]
): MerchantOrganizerParticipation {
  return {
    productCoordinate: item.productCoordinate,
    eventId: item.eventId,
    createdAt: item.createdAt,
    title: item.title,
    merchantPubkey: item.merchantPubkey,
    productPreview: item.productPreview,
    fulfillmentStatus: item.fulfillmentStatus,
    fulfillmentReason: item.fulfillmentReason,
    pickupCoordinate: item.pickupCoordinate,
    pickupAuthorPubkey: item.pickupAuthorPubkey,
    handoffMode: item.handoffMode,
    handlerPubkey: item.handoffPubkey,
    status,
  }
}

export function isParticipationHandoffVerified(
  item: MerchantOrganizerParticipation,
  organizerPubkey: string
): boolean {
  if (
    item.fulfillmentStatus !== "resolved" ||
    !item.merchantPubkey ||
    !item.pickupCoordinate ||
    !item.pickupAuthorPubkey ||
    !item.handoffMode ||
    !item.handlerPubkey
  ) {
    return false
  }
  const organizer = organizerPubkey.trim().toLowerCase()
  const merchant = item.merchantPubkey.trim().toLowerCase()
  const pickupAuthor = item.pickupAuthorPubkey.trim().toLowerCase()
  const handler = item.handlerPubkey.trim().toLowerCase()
  const pickupCoordinateAuthor =
    item.pickupCoordinate.split(":")[1]?.trim().toLowerCase() ?? ""
  if (
    !/^[0-9a-f]{64}$/.test(organizer) ||
    !/^[0-9a-f]{64}$/.test(merchant) ||
    !/^[0-9a-f]{64}$/.test(pickupAuthor) ||
    pickupCoordinateAuthor !== pickupAuthor
  ) {
    return false
  }
  return item.handoffMode === "organizer_handoff"
    ? pickupAuthor === organizer && handler === organizer
    : pickupAuthor === merchant && handler === merchant
}

export function isParticipationProductPreviewVerified(
  item: MerchantOrganizerParticipation
): item is MerchantOrganizerParticipation & {
  eventId: string
  createdAt: number
  merchantPubkey: string
  productPreview: Extract<
    EventMarketProductPreview,
    { priceStatus: "resolved" }
  >
} {
  const preview = item.productPreview
  return (
    !!preview &&
    preview.priceStatus === "resolved" &&
    preview.coordinate === item.productCoordinate &&
    preview.eventId === item.eventId &&
    preview.createdAt === item.createdAt &&
    typeof item.merchantPubkey === "string" &&
    /^[0-9a-f]{64}$/i.test(item.merchantPubkey) &&
    preview.title.trim().length > 0 &&
    Number.isFinite(preview.price) &&
    preview.price >= 0 &&
    preview.currency.trim().length > 0
  )
}

function resolvedEventMarketRelayHints(
  resolution: EventMarketResolution
): string[] {
  return boundedEventMarketShareRelayHints([
    resolution.collection?.sourceRelayUrls,
    resolution.calendar?.sourceRelayUrls,
    ...resolution.pickups.map((pickup) => pickup.sourceRelayUrls),
  ])
}

function publishedEventMarketRelayHints(
  value: OrganizerEventMarketPublishResult
): string[] {
  return boundedEventMarketShareRelayHints([
    value.collection.delivery.acknowledgedRelayUrls,
    value.calendar.delivery.acknowledgedRelayUrls,
    value.pickup?.delivery.acknowledgedRelayUrls,
  ])
}

// Event-market reads currently allow eight relays. Keep one slot available for
// the organizer/default read plan so imported or observed hints cannot replace
// every normal fallback. Take one relay from every required record before
// adding secondary observations so disjoint collection/calendar/pickup
// delivery remains reachable from the portable link.
const EVENT_MARKET_SHARE_RELAY_HINT_LIMIT = 7

function boundedEventMarketShareRelayHints(
  groups: readonly (readonly string[] | undefined)[]
): string[] {
  const normalizedGroups = groups
    .map((group) => [...(group ?? [])])
    .filter((group) => group.length > 0)
  const prioritized = [
    ...normalizedGroups.flatMap((group) => group.slice(0, 1)),
    ...normalizedGroups.flatMap((group) => group.slice(1)),
  ]
  const seen = new Set<string>()
  const result: string[] = []
  for (const relayUrl of prioritized) {
    const key = relayUrl.trim().toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(relayUrl)
    if (result.length >= EVENT_MARKET_SHARE_RELAY_HINT_LIMIT) break
  }
  return result
}

function projectEventMarket(
  resolution: EventMarketResolution
): MerchantOrganizerEventMarket | null {
  const { calendar, collection, pickup } = resolution
  const organizerPubkey = resolution.organizerPubkey
  const collectionCoordinate = resolution.collectionCoordinate
  const calendarCoordinate = resolution.calendarCoordinate
  const pickupCoordinate = resolution.pickupCoordinate
  const pickupCoordinates = [...(collection?.pickupCoordinates ?? [])]
  if (pickupCoordinate && !pickupCoordinates.includes(pickupCoordinate)) {
    pickupCoordinates.unshift(pickupCoordinate)
  }
  if (!organizerPubkey || !collectionCoordinate || !calendar) {
    return null
  }

  const productCoordinates = [...resolution.organizerProductCoordinates]
  const pending = resolution.participationRequests.map((item) =>
    projectParticipation(item, "pending")
  )
  const acceptedByCoordinate = new Map(
    resolution.acceptedProductEvidence.map((item) => [
      item.productCoordinate,
      projectParticipation(item, "accepted"),
    ])
  )
  const accepted = productCoordinates
    .map((productCoordinate): MerchantOrganizerParticipation | null =>
      resolution.acceptedProductCoordinates.includes(productCoordinate)
        ? (acceptedByCoordinate.get(productCoordinate) ?? {
            productCoordinate,
            status: "accepted",
          })
        : null
    )
    .filter((item): item is MerchantOrganizerParticipation => item !== null)
  const organizerOnly = resolution.organizerOnlyProductCoordinates.map(
    (productCoordinate): MerchantOrganizerParticipation => ({
      productCoordinate,
      status: "organizer_only",
    })
  )
  const naddr = encodeEventMarketNaddr(
    collectionCoordinate,
    resolvedEventMarketRelayHints(resolution)
  )
  const calendarKind = calendar.kind === 31922 ? 31922 : 31923
  const start =
    calendarKind === 31922
      ? calendar.startDate
      : typeof calendar.start === "number"
        ? calendar.start / 1_000
        : undefined
  if (start === undefined) return null
  const end =
    calendarKind === 31922
      ? calendar.endDate
      : typeof calendar.end === "number"
        ? calendar.end / 1_000
        : undefined

  return {
    state: resolution.state,
    organizerPubkey,
    collectionCoordinate,
    calendarCoordinate: calendarCoordinate ?? "",
    pickupCoordinate,
    pickupCoordinates,
    naddr,
    title: calendar.title ?? collection?.title ?? "Event evidence unavailable",
    summary: calendar.summary ?? collection?.summary,
    imageUrl: calendar.image ?? collection?.image,
    eventLocation: calendar.locations[0],
    eventGeohash: calendar.geohash,
    calendarKind,
    start,
    end,
    timezone: calendar.startTzid ?? calendar.endTzid,
    pickupTitle: pickup?.title,
    pickupLocation: pickup?.location,
    pickupGeohash: pickup?.geohash,
    pickupCountry: pickup?.countries[0],
    pickupPrice: pickup ? String(pickup.price) : undefined,
    pickupCurrency: pickup?.currency,
    calendarCreatedAt: calendar.createdAt,
    calendarEventId: calendar.eventId,
    pickupCreatedAt: pickup?.createdAt,
    pickupEventId: pickup?.eventId,
    collectionCreatedAt: collection?.createdAt,
    collectionEventId: collection?.eventId,
    productCoordinates,
    participation: [...pending, ...accepted, ...organizerOnly],
    source: resolution,
  }
}

function projectMarketList(
  values: readonly EventMarketResolution[]
): MerchantOrganizerEventMarket[] {
  return values.flatMap((resolution) => {
    const projected = projectEventMarket(resolution)
    return projected ? [projected] : []
  })
}

type OrganizerEventMarketDeliverySource =
  OrganizerEventMarketSignedEvent | OrganizerEventMarketSignedRecord

function projectDeliveryRecord(
  value: OrganizerEventMarketDeliverySource
): MerchantOrganizerRecordDelivery {
  const delivery = "delivery" in value ? value.delivery : undefined
  const successful = delivery?.successfulRelayUrls ?? []
  const acknowledged = delivery?.acknowledgedRelayUrls ?? []
  const rejected = delivery?.rejectedRelayUrls ?? []
  const timedOut = delivery?.timedOutRelayUrls ?? []
  const failed = delivery?.failedRelayUrls ?? []
  return {
    record: value.record,
    acknowledgedCount: acknowledged.length || successful.length,
    rejectedCount: rejected.length,
    timedOutCount:
      timedOut.length || Math.max(0, failed.length - rejected.length),
    signedEvent: value.signedEvent,
  }
}

function projectPublishResult(
  value: OrganizerEventMarketPublishResult,
  collectionCoordinate: string
): MerchantOrganizerPublishResult {
  const records = [
    projectDeliveryRecord(value.calendar),
    ...(value.pickup ? [projectDeliveryRecord(value.pickup)] : []),
    projectDeliveryRecord(value.collection),
  ]
  return {
    records,
    collectionCoordinate,
    collectionCreatedAt: value.collection.signedEvent.created_at * 1_000,
    naddr: encodeEventMarketNaddr(
      collectionCoordinate,
      publishedEventMarketRelayHints(value)
    ),
  }
}

export function parseOrganizerEventMarketReference(
  value: string
): MerchantOrganizerEventMarketReference {
  const decoded = decodeEventMarketReference(value, [30405])
  if (!decoded?.coordinate.startsWith("30405:")) {
    throw new Error("Paste a kind-30405 event catalog naddr or share link.")
  }
  return {
    coordinate: decoded.coordinate,
    naddr: encodeEventMarketNaddr(decoded.coordinate, decoded.relayHints),
    relayHints: decoded.relayHints,
  }
}

export function decodeOrganizerEventMarketReference(value: string): string {
  return parseOrganizerEventMarketReference(value).coordinate
}

export function organizerEventMarketReferencesMatch(
  left: string,
  right: string
): boolean {
  try {
    return (
      parseOrganizerEventMarketReference(left).coordinate ===
      parseOrganizerEventMarketReference(right).coordinate
    )
  } catch {
    return false
  }
}

export async function listOrganizerEventMarkets(
  organizerPubkey: string
): Promise<MerchantOrganizerEventMarket[]> {
  const result = await getOrganizerEventMarkets({
    organizerPubkey,
    authenticatedPubkey: organizerPubkey,
  })
  return projectMarketList(result)
}

export async function discoverFollowedEventMarkets(
  merchantPubkey: string,
  options: { signal?: AbortSignal; nowMs?: number } = {}
): Promise<MerchantEventMarketDiscovery> {
  const discovery = await discoverFollowedOrganizerEventMarkets({
    merchantPubkey,
    authenticatedPubkey: merchantPubkey,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
  })
  return {
    ...discovery,
    markets: projectMarketList(discovery.markets),
  }
}

export async function resolveOrganizerEventMarketRead(
  reference: string,
  organizerPubkey?: string,
  authenticatedPubkey: string | null = organizerPubkey ?? null,
  signal?: AbortSignal
): Promise<MerchantOrganizerEventMarketRead> {
  const parsedReference = parseOrganizerEventMarketReference(reference)
  const result = await getEventMarket({
    reference: parsedReference.naddr,
    ...(organizerPubkey ? { expectedOrganizerPubkey: organizerPubkey } : {}),
    authenticatedPubkey,
    ...(signal ? { signal } : {}),
  })
  if (
    result.state === "deleted" &&
    result.organizerPubkey &&
    result.collectionCoordinate === parsedReference.coordinate
  ) {
    return {
      terminal: true,
      state: "deleted",
      organizerPubkey: result.organizerPubkey,
      collectionCoordinate: result.collectionCoordinate,
      naddr: parsedReference.naddr,
    }
  }
  const normalized = projectEventMarket(result)
  if (
    !normalized ||
    normalized.collectionCoordinate !== parsedReference.coordinate
  ) {
    throw new Error("The organizer event records could not be resolved.")
  }
  const projectedHints =
    decodeEventMarketReference(normalized.naddr, [30405])?.relayHints ?? []
  const parsedHintKeys = new Set(
    parsedReference.relayHints.map((relayUrl) => relayUrl.trim().toLowerCase())
  )
  const parsedReferenceContainsResolvedHints = projectedHints.every(
    (relayUrl) => parsedHintKeys.has(relayUrl.trim().toLowerCase())
  )
  return {
    ...normalized,
    naddr: encodeEventMarketNaddr(
      parsedReference.coordinate,
      parsedReferenceContainsResolvedHints &&
        parsedReference.relayHints.length > 0
        ? parsedReference.relayHints
        : boundedEventMarketShareRelayHints([
            parsedReference.relayHints.slice(0, 1),
            projectedHints,
            parsedReference.relayHints.slice(1),
          ])
    ),
  }
}

export async function resolveOrganizerEventMarket(
  reference: string,
  organizerPubkey?: string,
  authenticatedPubkey: string | null = organizerPubkey ?? null,
  signal?: AbortSignal
): Promise<MerchantOrganizerEventMarket> {
  const result = await resolveOrganizerEventMarketRead(
    reference,
    organizerPubkey,
    authenticatedPubkey,
    signal
  )
  if ("terminal" in result) {
    throw new Error("The organizer event records were deleted.")
  }
  return result
}

function randomDTagSuffix(): string {
  try {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 8)
  } catch {
    return Math.random().toString(36).slice(2, 10)
  }
}

export async function publishMerchantOrganizerEventMarket(input: {
  organizerPubkey: string
  form: OrganizerEventMarketFormValues
  existing?: MerchantOrganizerEventMarket | null
  onSignedRecord?: (
    record: MerchantOrganizerRecordDelivery,
    collectionCoordinate: string
  ) => void
  onSignedEvent?: (
    record: MerchantOrganizerRecordDelivery,
    collectionCoordinate: string
  ) => void | Promise<void>
}): Promise<MerchantOrganizerPublishResult> {
  const prepared = prepareOrganizerEventMarketForm(input.form, {
    requireFutureStart: !input.existing,
  })
  const baseDTag = input.existing
    ? coordinateDTag(input.existing.collectionCoordinate).replace(
        /-market$/,
        ""
      )
    : `${slugifyEventMarketTitle(input.form.title)}-${randomDTagSuffix()}`
  const calendarDTag = input.existing
    ? coordinateDTag(input.existing.calendarCoordinate)
    : `${baseDTag}-calendar`
  const pickupDTag = prepared.pickup
    ? input.existing?.pickupCoordinate
      ? coordinateDTag(input.existing.pickupCoordinate)
      : `${baseDTag}-pickup`
    : undefined
  const collectionDTag = input.existing
    ? coordinateDTag(input.existing.collectionCoordinate)
    : `${baseDTag}-market`
  const calendarCoordinate = `${prepared.calendar.kind}:${input.organizerPubkey}:${calendarDTag}`
  const pickupCoordinate = pickupDTag
    ? `30406:${input.organizerPubkey}:${pickupDTag}`
    : undefined
  const collectionCoordinate = `30405:${input.organizerPubkey}:${collectionDTag}`

  const calendar: OrganizerEventMarketCalendarPublishInput =
    prepared.calendar.kind === 31922
      ? {
          dTag: calendarDTag,
          kind: 31922,
          title: prepared.calendar.title,
          content: "",
          summary: prepared.calendar.summary,
          image: prepared.calendar.imageUrl,
          locations: [prepared.calendar.location],
          geohash: prepared.calendar.geohash,
          start: prepared.calendar.start as string,
          end: prepared.calendar.end as string | undefined,
        }
      : {
          dTag: calendarDTag,
          kind: 31923,
          title: prepared.calendar.title,
          content: "",
          summary: prepared.calendar.summary,
          image: prepared.calendar.imageUrl,
          locations: [prepared.calendar.location],
          geohash: prepared.calendar.geohash,
          start: prepared.calendar.start as number,
          end: prepared.calendar.end as number | undefined,
          startTzid: prepared.calendar.timezone,
          endTzid: prepared.calendar.timezone,
        }
  const pickup: OrganizerEventMarketPickupPublishInput | undefined =
    prepared.pickup && pickupDTag
      ? {
          dTag: pickupDTag,
          title: prepared.pickup.title,
          content: "",
          price: Number(prepared.pickup.price),
          currency: prepared.pickup.currency,
          countries: [prepared.pickup.country],
          location: prepared.pickup.location,
          geohash: prepared.pickup.geohash,
        }
      : undefined
  const collection: OrganizerEventMarketCollectionPublishInput = {
    dTag: collectionDTag,
    title: prepared.collection.title,
    content: "",
    summary: prepared.collection.summary,
    image: prepared.collection.imageUrl,
    location: prepared.calendar.location,
    eventCoordinate: calendarCoordinate,
    pickupCoordinates: pickupCoordinate ? [pickupCoordinate] : [],
    productCoordinates: input.existing?.productCoordinates ?? [],
  }
  const result = await publishOrganizerEventMarket({
    organizerPubkey: input.organizerPubkey,
    calendar,
    pickup,
    collection,
    previousCreatedAt: input.existing?.collectionCreatedAt,
    previousCreatedAtByRecord: input.existing
      ? {
          calendar: input.existing.calendarCreatedAt,
          ...(input.existing.pickupCoordinate
            ? { pickup: input.existing.pickupCreatedAt }
            : {}),
          collection: input.existing.collectionCreatedAt,
        }
      : undefined,
    onSignedEvent: async (record) => {
      await input.onSignedEvent?.(
        projectDeliveryRecord(record),
        collectionCoordinate
      )
    },
    onSignedRecord: (record: OrganizerEventMarketSignedRecord) => {
      input.onSignedRecord?.(
        projectDeliveryRecord(record),
        collectionCoordinate
      )
    },
  })
  return projectPublishResult(result, collectionCoordinate)
}

export async function publishMerchantOrganizerMembership(input: {
  organizerPubkey: string
  market: MerchantOrganizerEventMarket
  item: MerchantOrganizerParticipation
  action: OrganizerCollectionMembershipAction
  onSignedEvent?: (
    record: MerchantOrganizerRecordDelivery,
    collectionCoordinate: string
  ) => void | Promise<void>
}): Promise<MerchantOrganizerRecordDelivery> {
  const productCoordinates = updateOrganizerCollectionProducts(
    input.market.productCoordinates,
    input.item.productCoordinate,
    input.action
  )
  if (
    input.action === "accept" &&
    (!isParticipationHandoffVerified(
      input.item,
      input.market.organizerPubkey
    ) ||
      !isParticipationProductPreviewVerified(input.item))
  ) {
    throw new Error(
      "Current signed product preview or handoff evidence is unavailable or unsupported."
    )
  }
  const sourceCollection = input.market.source.collection
  const collection: OrganizerEventMarketCollectionPublishInput = {
    dTag: coordinateDTag(input.market.collectionCoordinate),
    title: input.market.title,
    content: sourceCollection?.content ?? "",
    summary: input.market.summary,
    image: input.market.imageUrl,
    location: input.market.eventLocation,
    geohash: input.market.eventGeohash,
    eventCoordinate: input.market.calendarCoordinate,
    pickupCoordinates: input.market.pickupCoordinate
      ? [input.market.pickupCoordinate]
      : [],
    productCoordinates,
  }
  const result = await publishOrganizerCollectionUpdate({
    organizerPubkey: input.organizerPubkey,
    collection,
    previousCreatedAt: input.market.collectionCreatedAt,
    onSignedEvent: async (record) => {
      await input.onSignedEvent?.(
        projectDeliveryRecord(record),
        input.market.collectionCoordinate
      )
    },
  })
  return projectDeliveryRecord(result)
}

export async function retryMerchantOrganizerRecord(input: {
  organizerPubkey: string
  record: MerchantOrganizerRecordDelivery
}): Promise<MerchantOrganizerRecordDelivery> {
  if (!input.record.signedEvent) {
    throw new Error("Signed organizer record is unavailable for retry.")
  }
  const result = await retryOrganizerEventMarketRecord({
    organizerPubkey: input.organizerPubkey,
    signedEvent: input.record.signedEvent,
  })
  return projectDeliveryRecord(result)
}

export function organizerEventMarketToForm(
  market: MerchantOrganizerEventMarket
): OrganizerEventMarketFormValues {
  const timed = market.calendarKind === 31923
  const toInput = (value: string | number | undefined): string => {
    if (typeof value === "string") return value
    if (typeof value !== "number") return ""
    if (timed) {
      return epochSecondsToLocalDateTime(value, market.timezone ?? "UTC")
    }
    return new Date(value * 1_000).toISOString().slice(0, 10)
  }
  return {
    calendarType: timed ? "timed" : "date",
    title: market.title,
    summary: market.summary ?? "",
    imageUrl: market.imageUrl ?? "",
    eventLocation: market.eventLocation ?? "",
    eventGeohash: market.eventGeohash ?? "",
    start: toInput(market.start),
    end: toInput(market.end),
    timezone: market.timezone ?? "UTC",
    organizerHandoffEnabled: !!market.pickupCoordinate,
    pickupTitle: market.pickupTitle ?? "Event pickup",
    pickupLocation: market.pickupLocation ?? "",
    pickupGeohash: market.pickupGeohash ?? "",
    pickupCountry: market.pickupCountry ?? "US",
    pickupPrice: market.pickupPrice ?? "0",
    pickupCurrency: market.pickupCurrency ?? "SAT",
  }
}
