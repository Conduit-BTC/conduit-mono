import {
  decodeEventMarketReference,
  encodeEventMarketNaddr,
  getEventMarket,
  getOrganizerEventMarkets,
  isValidSignedPublicNostrEvent,
  publishOrganizerCollectionUpdate,
  publishOrganizerEventMarket,
  retryOrganizerEventMarketRecord,
  type OrganizerEventMarketCalendarPublishInput,
  type OrganizerEventMarketCollectionPublishInput,
  type OrganizerEventMarketPickupPublishInput,
  type OrganizerEventMarketSignedRecord,
  type SignedPublicNostrEvent,
  type EventMarketProductPreview,
  type EventMarketHandoffMode,
  type EventMarketResolution,
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

export type MerchantOrganizerEventMarketState =
  | "active"
  | "ended"
  | "missing"
  | "partial"
  | "unavailable"
  | "stale"
  | "deleted"
  | "malformed"
  | "conflicting"
  | "unsupported"

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
  pickupCreatedAt?: number
  collectionCreatedAt?: number
  productCoordinates: string[]
  participation: MerchantOrganizerParticipation[]
  source: EventMarketResolution
}

export interface MerchantOrganizerPublishResult {
  records: MerchantOrganizerRecordDelivery[]
  collectionCoordinate: string
  naddr: string
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

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(
    new Set(
      value.flatMap((item) =>
        typeof item === "string" && item.trim() ? [item.trim()] : []
      )
    )
  )
}

function isEventMarketProductPreview(
  value: unknown
): value is EventMarketProductPreview {
  const preview = asRecord(value)
  if (!preview) return false
  const images = preview.images
  const imageListValid =
    Array.isArray(images) &&
    images.every((image) => {
      const record = asRecord(image)
      return (
        !!record &&
        typeof record.url === "string" &&
        record.url.trim().length > 0 &&
        (record.alt === undefined || typeof record.alt === "string")
      )
    })
  const baseValid =
    typeof preview.coordinate === "string" &&
    preview.coordinate.trim().length > 0 &&
    typeof preview.eventId === "string" &&
    /^[0-9a-f]{64}$/i.test(preview.eventId) &&
    typeof preview.createdAt === "number" &&
    Number.isFinite(preview.createdAt) &&
    typeof preview.title === "string" &&
    preview.title.trim().length > 0 &&
    (preview.summary === undefined || typeof preview.summary === "string") &&
    imageListValid &&
    (preview.type === "simple" ||
      preview.type === "variable" ||
      preview.type === "variation") &&
    (preview.format === "physical" || preview.format === "digital") &&
    (preview.stock === undefined ||
      (typeof preview.stock === "number" &&
        Number.isFinite(preview.stock) &&
        preview.stock >= 0))
  if (!baseValid) return false
  if (preview.priceStatus === "malformed") return true
  return (
    preview.priceStatus === "resolved" &&
    typeof preview.price === "number" &&
    Number.isFinite(preview.price) &&
    preview.price >= 0 &&
    typeof preview.currency === "string" &&
    preview.currency.trim().length > 0
  )
}

function coordinateDTag(coordinate: string): string {
  return coordinate.split(":").slice(2).join(":")
}

function normalizeParticipation(
  value: unknown,
  status: MerchantOrganizerParticipation["status"]
): MerchantOrganizerParticipation[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (typeof item === "string") {
      return item.trim() ? [{ productCoordinate: item.trim(), status }] : []
    }
    const record = asRecord(item)
    if (!record) return []
    const product = asRecord(record.product)
    const fulfillment = asRecord(record.fulfillment)
    const productCoordinate = textValue(
      record.productCoordinate,
      record.coordinate,
      product?.coordinate,
      product?.id
    )
    if (!productCoordinate) return []
    return [
      {
        productCoordinate,
        eventId: textValue(record.eventId),
        createdAt: numberValue(record.createdAt),
        title: textValue(record.title, product?.title),
        merchantPubkey: textValue(record.merchantPubkey, product?.pubkey),
        productPreview: isEventMarketProductPreview(record.productPreview)
          ? record.productPreview
          : undefined,
        fulfillmentStatus:
          record.fulfillmentStatus === "none" ||
          record.fulfillmentStatus === "ambiguous" ||
          record.fulfillmentStatus === "resolved"
            ? record.fulfillmentStatus
            : undefined,
        fulfillmentReason: textValue(record.fulfillmentReason),
        pickupCoordinate: textValue(
          record.pickupCoordinate,
          fulfillment?.pickupCoordinate,
          asRecord(fulfillment?.selectedPickup)?.coordinate
        ),
        pickupAuthorPubkey: textValue(
          record.pickupAuthorPubkey,
          fulfillment?.pickupAuthorPubkey
        ),
        handoffMode:
          record.handoffMode === "merchant_handoff" ||
          record.handoffMode === "organizer_handoff"
            ? record.handoffMode
            : fulfillment?.handoffMode === "merchant_handoff" ||
                fulfillment?.handoffMode === "organizer_handoff"
              ? fulfillment.handoffMode
              : undefined,
        handlerPubkey: textValue(
          record.handlerPubkey,
          record.handoffPubkey,
          fulfillment?.handlerPubkey,
          fulfillment?.handoffPubkey
        ),
        status,
      },
    ]
  })
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

function normalizeState(value: unknown): MerchantOrganizerEventMarketState {
  switch (value) {
    case "active":
    case "ended":
    case "missing":
    case "partial":
    case "unavailable":
    case "stale":
    case "deleted":
    case "malformed":
    case "conflicting":
    case "unsupported":
      return value
    default:
      return "unavailable"
  }
}

function normalizeEventMarket(
  value: unknown
): MerchantOrganizerEventMarket | null {
  const root = asRecord(value)
  if (!root) return null
  const resolution = asRecord(root.data) ?? root
  const calendar = asRecord(resolution.calendar)
  const pickup = asRecord(resolution.pickup)
  const collection = asRecord(resolution.collection)
  const organizerPubkey = textValue(
    resolution.organizerPubkey,
    collection?.authorPubkey,
    collection?.pubkey
  )
  const collectionCoordinate = textValue(
    resolution.collectionCoordinate,
    resolution.reference,
    collection?.coordinate,
    collection?.id
  )
  const calendarCoordinate = textValue(
    resolution.calendarCoordinate,
    calendar?.coordinate,
    calendar?.id
  )
  const pickupCoordinate = textValue(
    resolution.pickupCoordinate,
    pickup?.coordinate,
    pickup?.id
  )
  const pickupCoordinates = stringList(
    resolution.pickupCoordinates ?? collection?.pickupCoordinates
  )
  if (pickupCoordinate && !pickupCoordinates.includes(pickupCoordinate)) {
    pickupCoordinates.unshift(pickupCoordinate)
  }
  if (!organizerPubkey || !collectionCoordinate) {
    return null
  }

  const productCoordinates = stringList(
    resolution.organizerProductCoordinates ??
      collection?.productCoordinates ??
      resolution.productCoordinates
  )
  const acceptedProductCoordinates = stringList(
    resolution.acceptedProductCoordinates
  )
  const pending = normalizeParticipation(
    resolution.participationRequests ?? resolution.requests,
    "pending"
  )
  const acceptedDetails = normalizeParticipation(
    resolution.acceptedProductEvidence,
    "accepted"
  )
  const acceptedByCoordinate = new Map(
    acceptedDetails.map((item) => [item.productCoordinate, item])
  )
  const accepted = productCoordinates
    .map((productCoordinate): MerchantOrganizerParticipation | null =>
      acceptedProductCoordinates.includes(productCoordinate)
        ? (acceptedByCoordinate.get(productCoordinate) ?? {
            productCoordinate,
            status: "accepted",
          })
        : null
    )
    .filter((item): item is MerchantOrganizerParticipation => item !== null)
  const organizerOnlyCoordinates = stringList(
    resolution.organizerOnlyProductCoordinates
  )
  const organizerOnly = organizerOnlyCoordinates.map(
    (productCoordinate): MerchantOrganizerParticipation => ({
      productCoordinate,
      status: "organizer_only",
    })
  )
  const naddr = encodeEventMarketNaddr(collectionCoordinate)
  const calendarKind = numberValue(calendar?.kind) === 31922 ? 31922 : 31923

  return {
    state: normalizeState(resolution.state),
    organizerPubkey,
    collectionCoordinate,
    calendarCoordinate: calendarCoordinate ?? "",
    pickupCoordinate,
    pickupCoordinates,
    naddr,
    title:
      textValue(calendar?.title, collection?.title) ??
      "Event evidence unavailable",
    summary: textValue(calendar?.summary, collection?.summary),
    imageUrl: textValue(calendar?.imageUrl, calendar?.image, collection?.image),
    eventLocation:
      stringList(calendar?.locations)[0] ?? textValue(calendar?.location),
    eventGeohash: textValue(calendar?.geohash, calendar?.g),
    calendarKind,
    start:
      calendarKind === 31922
        ? (textValue(calendar?.startDate, calendar?.start) ?? "")
        : (numberValue(calendar?.start) ?? 0) / 1_000,
    end:
      calendarKind === 31922
        ? textValue(calendar?.endDate, calendar?.end)
        : numberValue(calendar?.end) !== undefined
          ? numberValue(calendar?.end)! / 1_000
          : undefined,
    timezone: textValue(
      calendar?.timezone,
      calendar?.startTzid,
      calendar?.endTzid
    ),
    pickupTitle: textValue(pickup?.title),
    pickupLocation: textValue(pickup?.location),
    pickupGeohash: textValue(pickup?.geohash, pickup?.g),
    pickupCountry:
      stringList(pickup?.countries ?? pickup?.countryCodes)[0] ??
      textValue(pickup?.country),
    pickupPrice:
      textValue(pickup?.price) ??
      (numberValue(pickup?.price) !== undefined
        ? String(numberValue(pickup?.price))
        : undefined),
    pickupCurrency: textValue(pickup?.currency),
    calendarCreatedAt: numberValue(calendar?.createdAt, calendar?.created_at),
    pickupCreatedAt: numberValue(pickup?.createdAt, pickup?.created_at),
    collectionCreatedAt: numberValue(
      collection?.createdAt,
      collection?.created_at
    ),
    productCoordinates,
    participation: [...pending, ...accepted, ...organizerOnly],
    source: resolution as unknown as EventMarketResolution,
  }
}

function normalizeMarketList(value: unknown): MerchantOrganizerEventMarket[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const normalized = normalizeEventMarket(item)
      return normalized ? [normalized] : []
    })
  }
  const root = asRecord(value)
  const values = root?.data ?? root?.markets
  return Array.isArray(values) ? normalizeMarketList(values) : []
}

function relayUrlList(record: Record<string, unknown> | null, key: string) {
  return stringList(record?.[key])
}

function normalizeDeliveryRecord(
  value: unknown,
  fallbackRecord?: MerchantOrganizerEventRecord
): MerchantOrganizerRecordDelivery | null {
  const root = asRecord(value)
  if (!root) return null
  const delivery = asRecord(root.delivery) ?? root
  const record = textValue(root.record, fallbackRecord)
  if (record !== "calendar" && record !== "pickup" && record !== "collection") {
    return null
  }
  const successful = relayUrlList(delivery, "successfulRelayUrls")
  const acknowledged = relayUrlList(delivery, "acknowledgedRelayUrls")
  const rejected = relayUrlList(delivery, "rejectedRelayUrls")
  const timedOut = relayUrlList(delivery, "timedOutRelayUrls")
  const failed = relayUrlList(delivery, "failedRelayUrls")
  return {
    record,
    acknowledgedCount: acknowledged.length || successful.length,
    rejectedCount: rejected.length,
    timedOutCount:
      timedOut.length || Math.max(0, failed.length - rejected.length),
    signedEvent:
      (root.signedEvent as SignedPublicNostrEvent | undefined) ?? null,
  }
}

function normalizePublishResult(
  value: unknown,
  collectionCoordinate: string
): MerchantOrganizerPublishResult {
  const root = asRecord(value) ?? {}
  const records = (["calendar", "pickup", "collection"] as const).flatMap(
    (record) => {
      const normalized = normalizeDeliveryRecord(root[record], record)
      return normalized ? [normalized] : []
    }
  )
  return {
    records,
    collectionCoordinate,
    naddr: encodeEventMarketNaddr(collectionCoordinate),
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
  const result = await getOrganizerEventMarkets({ organizerPubkey })
  return normalizeMarketList(result)
}

export async function resolveOrganizerEventMarket(
  reference: string,
  organizerPubkey?: string
): Promise<MerchantOrganizerEventMarket> {
  const parsedReference = parseOrganizerEventMarketReference(reference)
  const result = await getEventMarket({
    reference: parsedReference.naddr,
    ...(organizerPubkey ? { expectedOrganizerPubkey: organizerPubkey } : {}),
  })
  const normalized = normalizeEventMarket(result)
  if (
    !normalized ||
    normalized.collectionCoordinate !== parsedReference.coordinate
  ) {
    throw new Error("The organizer event records could not be resolved.")
  }
  return { ...normalized, naddr: parsedReference.naddr }
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
  const prepared = prepareOrganizerEventMarketForm(input.form)
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
      const normalized = normalizeDeliveryRecord(record)
      if (normalized) {
        await input.onSignedEvent?.(normalized, collectionCoordinate)
      }
    },
    onSignedRecord: (record: OrganizerEventMarketSignedRecord) => {
      const normalized = normalizeDeliveryRecord(record)
      if (normalized) input.onSignedRecord?.(normalized, collectionCoordinate)
    },
  })
  return normalizePublishResult(result, collectionCoordinate)
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
  const resolution = asRecord(input.market.source)
  const sourceCollection = asRecord(resolution?.collection) ?? {}
  const collection: OrganizerEventMarketCollectionPublishInput = {
    dTag: coordinateDTag(input.market.collectionCoordinate),
    title: input.market.title,
    content: textValue(sourceCollection.content) ?? "",
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
      const normalized = normalizeDeliveryRecord(record, "collection")
      if (normalized) {
        await input.onSignedEvent?.(
          normalized,
          input.market.collectionCoordinate
        )
      }
    },
  })
  const normalized = normalizeDeliveryRecord(result, "collection")
  if (!normalized) throw new Error("Collection delivery result was invalid.")
  return normalized
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
  const normalized = normalizeDeliveryRecord(result, input.record.record)
  if (!normalized) throw new Error("Retry delivery result was invalid.")
  return normalized
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
