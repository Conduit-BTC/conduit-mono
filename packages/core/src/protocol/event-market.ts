import { nip19 } from "@nostr-dev-kit/ndk"
import { EVENT_KINDS } from "./kinds"
import type { PublicRelayReadOptions } from "./relay-reader"
import { appendConduitClientTag, type ConduitAppId } from "./nip89"
import { readDurableAccountRelaySettingsPlanningSnapshot } from "./network-preferences"
import {
  getRelayLists,
  getRelayListsDetailed,
  type RelayList,
  type RelayListResolutionState,
} from "./relay-list"
import { planRelayReads } from "./relay-planner"
import {
  mergeRelayTargets,
  relayTargetsFromUrls,
  type RelayTarget,
} from "./relay-authority"
import {
  getConfiguredIsolatedE2eRelayUrl,
  normalizeOwnerSelectedRelayUrls,
  normalizePublicOrIsolatedE2eRelayHints,
  normalizeSecureOrIsolatedE2eRelayUrls,
  tryNormalizeRelayUrl,
} from "./relay-settings"
import { type SignedPublicNostrEvent } from "./signed-event"
import {
  isVerifiedNostrEvent,
  type VerifiedNostrEvent,
} from "./verified-public-event"
const HEX_64 = /^[0-9a-f]{64}$/i

const CONTROL_CHARACTER = /\p{Cc}/u

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const GEOHASH = /^[0-9bcdefghjkmnpqrstuvwxyz]{1,32}$/i

const EVENT_MARKET_MAX_D_TAG_LENGTH = 128

const EVENT_MARKET_MAX_RELAY_HINTS = 8

// Keep one event-market read slot available for the organizer/default relay
// plan when portable links supply observed source hints.
const EVENT_MARKET_SHARE_RELAY_HINT_LIMIT = EVENT_MARKET_MAX_RELAY_HINTS - 1

const EVENT_MARKET_MAX_DAY_BUCKETS = 370

export const EVENT_MARKET_ADDRESSABLE_KINDS = [
  EVENT_KINDS.PRODUCT,
  EVENT_KINDS.PRODUCT_COLLECTION,
  EVENT_KINDS.SHIPPING_OPTION,
  EVENT_KINDS.EVENT_MARKET,
  EVENT_KINDS.CALENDAR_DATE,
  EVENT_KINDS.CALENDAR_TIME,
  EVENT_KINDS.CALENDAR,
] as const

export const EVENT_MARKET_CALENDAR_KINDS = [
  EVENT_KINDS.CALENDAR_DATE,
  EVENT_KINDS.CALENDAR_TIME,
] as const

export interface AddressableEventCoordinate {
  kind: number
  authorPubkey: string
  dTag: string
  coordinate: string
}

export interface DecodedEventMarketReference extends AddressableEventCoordinate {
  relayHints: string[]
}

export interface EventMarketEventDraft {
  kind: number
  content: string
  tags: string[][]
}

interface EventMarketDisplayDraftInput {
  dTag: string
  title: string
  content?: string
  summary?: string
  image?: string
  locations?: string[]
  geohash?: string
  clientAppId?: ConduitAppId
}

export type EventMarketCalendarDraftInput =
  | (EventMarketDisplayDraftInput & {
      kind: typeof EVENT_KINDS.CALENDAR_DATE
      start: string
      end?: string
    })
  | (EventMarketDisplayDraftInput & {
      kind: typeof EVENT_KINDS.CALENDAR_TIME
      start: number
      end?: number
      startTzid?: string
      endTzid?: string
    })

export interface ParsedEventMarketCalendar {
  /** Exact verified public revision; retaining it does not establish freshness. */
  signedEvent?: SignedPublicNostrEvent
  coordinate: string
  eventId: string
  authorPubkey: string
  dTag: string
  kind: typeof EVENT_KINDS.CALENDAR_DATE | typeof EVENT_KINDS.CALENDAR_TIME
  title: string
  content: string
  summary?: string
  image?: string
  locations: string[]
  /** Signed NIP-52 topic tags, preserved for display and local filtering. */
  topics?: string[]
  geohash?: string
  /** Inclusive start instant in epoch milliseconds. */
  start: number
  /** Exclusive end instant in epoch milliseconds. */
  end: number
  startDate?: string
  endDate?: string
  startTzid?: string
  endTzid?: string
  createdAt: number
  sourceRelayUrls?: string[]
}

/** Historical router evidence only; new public markets use kind 31927. */
export type EventMarketOrderAcceptance = "open" | "closed"

const EVENT_MARKET_LIFECYCLE_TAG = "conduit_event_market"

export interface ParsedEventMarketPickup {
  /** Exact verified public revision; retaining it does not establish freshness. */
  signedEvent?: SignedPublicNostrEvent
  coordinate: string
  eventId: string
  authorPubkey: string
  dTag: string
  title: string
  content: string
  price: number
  currency: string
  countries: string[]
  location?: string
  geohash?: string
  createdAt: number
  sourceRelayUrls?: string[]
  /** Network-read provenance; retained records remain display-only. */
  evidenceState?: "live" | "retained"
}

export interface ParsedEventMarketCollection {
  /** Exact verified revision used for lossless lifecycle-only updates. */
  signedEvent?: SignedPublicNostrEvent
  /** Omitted only for legacy events whose scheduled end closes ordering. */
  orderAcceptance?: EventMarketOrderAcceptance
  coordinate: string
  eventId: string
  authorPubkey: string
  dTag: string
  title: string
  content: string
  summary?: string
  image?: string
  location?: string
  geohash?: string
  eventCoordinates: string[]
  pickupCoordinates: string[]
  productCoordinates: string[]
  /** Valid bounded relay hints from product `a` tags, keyed by coordinate. */
  productRelayHintsByCoordinate?: Record<string, string[]>
  unsupportedReferences: string[]
  createdAt: number
  sourceRelayUrls?: string[]
}

function normalizeAllowedKinds(
  allowedKinds: readonly number[] | undefined
): ReadonlySet<number> | null {
  return allowedKinds ? new Set(allowedKinds) : null
}

function validDTag(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= EVENT_MARKET_MAX_D_TAG_LENGTH &&
    !CONTROL_CHARACTER.test(value)
  )
}

export function parseAddressableCoordinate(
  value: string | null | undefined,
  allowedKinds?: readonly number[]
): AddressableEventCoordinate | null {
  const trimmed = value?.trim()
  if (!trimmed) return null

  const firstSeparator = trimmed.indexOf(":")
  const secondSeparator = trimmed.indexOf(":", firstSeparator + 1)
  if (firstSeparator < 1 || secondSeparator < 0) return null

  const kindText = trimmed.slice(0, firstSeparator)
  if (!/^\d{1,5}$/.test(kindText)) return null
  const kind = Number(kindText)
  const authorPubkey = trimmed.slice(firstSeparator + 1, secondSeparator)
  const dTag = trimmed.slice(secondSeparator + 1)
  const allowed = normalizeAllowedKinds(allowedKinds)
  if (
    !Number.isSafeInteger(kind) ||
    kind < 30_000 ||
    kind >= 40_000 ||
    (allowed && !allowed.has(kind)) ||
    !HEX_64.test(authorPubkey) ||
    !validDTag(dTag)
  ) {
    return null
  }

  const normalizedAuthor = authorPubkey.toLowerCase()
  return {
    kind,
    authorPubkey: normalizedAuthor,
    dTag,
    coordinate: `${kind}:${normalizedAuthor}:${dTag}`,
  }
}

function normalizeRelayHint(value: string): string | null {
  try {
    const parsed = new URL(value.trim())
    const local =
      parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"
    if (
      (parsed.protocol !== "wss:" && !(local && parsed.protocol === "ws:")) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return null
    }
    const path =
      parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "")
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}`
  } catch {
    return null
  }
}

function normalizeRemoteRelayHint(value: string): string | null {
  const normalized = normalizeRelayHint(value)
  return normalized?.startsWith("wss://") ? normalized : null
}

function normalizeRelayHints(values: readonly string[] | undefined): string[] {
  const hints = new Set<string>()
  for (const value of values ?? []) {
    const normalized = normalizeSecureOrIsolatedE2eRelayUrls([value])[0]
    if (normalized) hints.add(normalized)
    if (hints.size >= EVENT_MARKET_MAX_RELAY_HINTS) break
  }
  return Array.from(hints)
}

function normalizePortableRelayHints(
  values: readonly string[] | undefined
): string[] {
  return normalizePublicOrIsolatedE2eRelayHints(values ?? []).slice(
    0,
    EVENT_MARKET_MAX_RELAY_HINTS
  )
}

/**
 * Selects portable event-market relay hints without letting one record type
 * consume the full bounded read plan. Each non-empty source group contributes
 * its first observed relay before secondary observations are considered.
 */
export function buildEventMarketShareRelayHints(
  groups: readonly (readonly string[] | undefined)[]
): string[] {
  const normalizedGroups = groups
    .map((group) => normalizePortableRelayHints(group))
    .filter((group) => group.length > 0)
  const prioritized = [
    ...normalizedGroups.flatMap((group) => group.slice(0, 1)),
    ...normalizedGroups.flatMap((group) => group.slice(1)),
  ]
  const result = new Set<string>()
  for (const relayUrl of prioritized) {
    result.add(relayUrl)
    if (result.size >= EVENT_MARKET_SHARE_RELAY_HINT_LIMIT) break
  }
  return Array.from(result)
}

function extractNaddr(value: string): string | null {
  const trimmed = value.trim()
  if (/^naddr1/i.test(trimmed)) return trimmed
  try {
    const decoded = decodeURIComponent(trimmed)
    const match = decoded.match(
      /(?:^|[^0-9a-z])(naddr1[023456789acdefghjklmnpqrstuvwxyz]+)/i
    )
    return match?.[1] ?? null
  } catch {
    return null
  }
}

export function decodeEventMarketReference(
  value: string,
  allowedKinds: readonly number[] = EVENT_MARKET_ADDRESSABLE_KINDS
): DecodedEventMarketReference | null {
  const direct = parseAddressableCoordinate(value, allowedKinds)
  if (direct) return { ...direct, relayHints: [] }

  const encoded = extractNaddr(value)
  if (!encoded) return null
  try {
    const decoded = nip19.decode(encoded)
    if (
      decoded.type !== "naddr" ||
      !decoded.data ||
      typeof decoded.data !== "object" ||
      typeof decoded.data.kind !== "number" ||
      typeof decoded.data.pubkey !== "string" ||
      typeof decoded.data.identifier !== "string"
    ) {
      return null
    }
    const coordinate = parseAddressableCoordinate(
      `${decoded.data.kind}:${decoded.data.pubkey}:${decoded.data.identifier}`,
      allowedKinds
    )
    if (!coordinate) return null
    return {
      ...coordinate,
      relayHints: normalizeRelayHints(decoded.data.relays),
    }
  } catch {
    return null
  }
}

export function encodeEventMarketNaddr(
  coordinate: string | AddressableEventCoordinate,
  relayUrls: readonly string[] = []
): string {
  const parsed =
    typeof coordinate === "string"
      ? parseAddressableCoordinate(coordinate, EVENT_MARKET_ADDRESSABLE_KINDS)
      : parseAddressableCoordinate(
          coordinate.coordinate,
          EVENT_MARKET_ADDRESSABLE_KINDS
        )
  if (!parsed) throw new Error("Event-market coordinate is invalid.")
  return nip19.naddrEncode({
    kind: parsed.kind,
    pubkey: parsed.authorPubkey,
    identifier: parsed.dTag,
    relays: normalizeRelayHints(relayUrls),
  })
}

export function encodeEventMarketShareLink(
  coordinate: string | AddressableEventCoordinate,
  options: { origin?: string; relayUrls?: readonly string[] } = {}
): string {
  const origin = new URL(options.origin ?? "https://shop.conduit.market")
  if (origin.protocol !== "https:" && origin.hostname !== "localhost") {
    throw new Error("Event-market share origin must use HTTPS.")
  }
  const naddr = encodeEventMarketNaddr(coordinate, options.relayUrls)
  return new URL(`/events/${naddr}`, origin).toString()
}

function normalizeRequiredText(
  value: string,
  label: string,
  maxLength: number
): string {
  const normalized = value.trim()
  if (
    !normalized ||
    normalized.length > maxLength ||
    CONTROL_CHARACTER.test(normalized)
  ) {
    throw new Error(`${label} is invalid.`)
  }
  return normalized
}

function normalizeOptionalText(
  value: string | undefined,
  label: string,
  maxLength: number
): string | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim()
  if (!normalized) return undefined
  if (normalized.length > maxLength || CONTROL_CHARACTER.test(normalized)) {
    throw new Error(`${label} is invalid.`)
  }
  return normalized
}

function normalizeDTag(value: string): string {
  const normalized = value.trim()
  if (!validDTag(normalized)) throw new Error("Event-market d tag is invalid.")
  return normalized
}

function parseIsoDate(value: string): number | null {
  if (!ISO_DATE.test(value)) return null
  const timestamp = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(timestamp)) return null
  return new Date(timestamp).toISOString().slice(0, 10) === value
    ? timestamp
    : null
}

function normalizeTimeZone(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalText(value, "Calendar time zone", 100)
  if (!normalized) return undefined
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(0)
    return normalized
  } catch {
    throw new Error("Calendar time zone is invalid.")
  }
}

function timeDayBuckets(start: number, end: number | undefined): string[] {
  const lastInclusive = end === undefined ? start : end - 1
  const firstDay = Math.floor(start / 86_400)
  const lastDay = Math.floor(lastInclusive / 86_400)
  const count = lastDay - firstDay + 1
  if (count < 1 || count > EVENT_MARKET_MAX_DAY_BUCKETS) {
    throw new Error("Calendar event spans too many day buckets.")
  }
  return Array.from({ length: count }, (_, index) => String(firstDay + index))
}

function parseTimeDayBuckets(
  start: number,
  end: number | undefined
): string[] | null {
  try {
    return timeDayBuckets(start, end)
  } catch {
    return null
  }
}

function calendarEpochMilliseconds(value: number): number | null {
  if (!Number.isSafeInteger(value) || value <= 0) return null
  const milliseconds = value * 1_000
  if (!Number.isSafeInteger(milliseconds)) return null
  return Number.isFinite(new Date(milliseconds).getTime()) ? milliseconds : null
}

function normalizeLocations(values: readonly string[] | undefined): string[] {
  const result = new Set<string>()
  for (const value of values ?? []) {
    const normalized = normalizeOptionalText(value, "Calendar location", 500)
    if (normalized) result.add(normalized)
    if (result.size > 8) throw new Error("Calendar has too many locations.")
  }
  return Array.from(result)
}

export function buildEventMarketCalendarDraft(
  input: EventMarketCalendarDraftInput
): EventMarketEventDraft {
  const dTag = normalizeDTag(input.dTag)
  const title = normalizeRequiredText(input.title, "Calendar title", 200)
  let tags: string[][] = [
    ["d", dTag],
    ["title", title],
  ]
  const summary = normalizeOptionalText(input.summary, "Summary", 1_000)
  const image = normalizeOptionalText(input.image, "Image", 2_048)
  const geohash = normalizeOptionalText(input.geohash, "Geohash", 32)
  if (geohash && !GEOHASH.test(geohash)) throw new Error("Geohash is invalid.")
  if (summary) tags.push(["summary", summary])
  if (image) tags.push(["image", image])
  for (const location of normalizeLocations(input.locations)) {
    tags.push(["location", location])
  }
  if (geohash) tags.push(["g", geohash.toLowerCase()])

  if (input.kind === EVENT_KINDS.CALENDAR_DATE) {
    const start = input.start.trim()
    const startMs = parseIsoDate(start)
    const end = input.end?.trim()
    const endMs = end ? parseIsoDate(end) : null
    if (startMs === null || (end !== undefined && endMs === null)) {
      throw new Error("Calendar date is invalid.")
    }
    if (endMs !== null && endMs <= startMs) {
      throw new Error("Calendar end must be after start.")
    }
    tags.push(["start", start])
    if (end) tags.push(["end", end])
  } else {
    const startMs = calendarEpochMilliseconds(input.start)
    const endMs =
      input.end === undefined ? undefined : calendarEpochMilliseconds(input.end)
    if (
      startMs === null ||
      (input.end !== undefined &&
        (endMs === null || endMs === undefined || endMs <= startMs))
    ) {
      throw new Error("Calendar timestamp range is invalid.")
    }
    const startTzid = normalizeTimeZone(input.startTzid)
    const endTzid = normalizeTimeZone(input.endTzid)
    tags.push(["start", String(input.start)])
    if (input.end !== undefined) tags.push(["end", String(input.end)])
    if (startTzid) tags.push(["start_tzid", startTzid])
    if (endTzid) tags.push(["end_tzid", endTzid])
    for (const bucket of timeDayBuckets(input.start, input.end)) {
      tags.push(["D", bucket])
    }
  }

  if (input.clientAppId) tags = appendConduitClientTag(tags, input.clientAppId)
  return {
    kind: input.kind,
    content:
      normalizeOptionalText(input.content, "Calendar content", 10_000) ??
      summary ??
      "",
    tags,
  }
}

function tagValues(
  tags: readonly (readonly string[])[],
  name: string
): string[] {
  return tags
    .filter((tag) => tag[0] === name && typeof tag[1] === "string")
    .map((tag) => tag[1]!)
}

function singleTag(
  tags: readonly (readonly string[])[],
  name: string
): string | null {
  const values = tagValues(tags, name)
  return values.length === 1 ? values[0]! : null
}

function eventCoordinate(
  event: SignedPublicNostrEvent,
  allowedKinds: readonly number[]
): AddressableEventCoordinate | null {
  const dTag = singleTag(event.tags, "d")
  if (!dTag) return null
  return parseAddressableCoordinate(
    `${event.kind}:${event.pubkey}:${dTag}`,
    allowedKinds
  )
}

function optionalSingleTag(
  tags: readonly (readonly string[])[],
  name: string
): string | undefined | null {
  const values = tagValues(tags, name)
  if (values.length > 1) return null
  return values[0]
}

export function parseEventMarketCalendarEvent(
  event: VerifiedNostrEvent
): ParsedEventMarketCalendar | null {
  return isVerifiedNostrEvent(event)
    ? parseEventMarketCalendarFieldsForPrivateOrder(event)
    : null
}

/** Field parser for the private order schema after its own signature refinement. */
export function parseEventMarketCalendarFieldsForPrivateOrder(
  event: SignedPublicNostrEvent
): ParsedEventMarketCalendar | null {
  if (!EVENT_MARKET_CALENDAR_KINDS.includes(event.kind as never)) return null
  const coordinate = eventCoordinate(event, EVENT_MARKET_CALENDAR_KINDS)
  const title = singleTag(event.tags, "title")
  const startValue = singleTag(event.tags, "start")
  const endValue = optionalSingleTag(event.tags, "end")
  const summary = optionalSingleTag(event.tags, "summary")
  const image = optionalSingleTag(event.tags, "image")
  const geohash = optionalSingleTag(event.tags, "g")
  if (
    !coordinate ||
    !title ||
    !startValue ||
    endValue === null ||
    summary === null ||
    image === null ||
    geohash === null
  ) {
    return null
  }
  if (geohash && !GEOHASH.test(geohash)) return null

  let start: number
  let end: number
  let startDate: string | undefined
  let endDate: string | undefined
  let startTzid: string | undefined
  let endTzid: string | undefined

  if (event.kind === EVENT_KINDS.CALENDAR_DATE) {
    const startMs = parseIsoDate(startValue)
    const endMs = endValue ? parseIsoDate(endValue) : null
    if (startMs === null || (endValue !== undefined && endMs === null))
      return null
    if (endMs !== null && endMs <= startMs) return null
    start = startMs
    end = endMs ?? startMs + 86_400_000
    startDate = startValue
    endDate = endValue
  } else {
    const startSeconds = Number(startValue)
    const endSeconds = endValue === undefined ? undefined : Number(endValue)
    const startMs = calendarEpochMilliseconds(startSeconds)
    const endMs =
      endSeconds === undefined
        ? undefined
        : calendarEpochMilliseconds(endSeconds)
    if (
      startMs === null ||
      (endSeconds !== undefined &&
        (endMs === null || endMs === undefined || endMs <= startMs))
    ) {
      return null
    }
    const rawStartTzid = optionalSingleTag(event.tags, "start_tzid")
    const rawEndTzid = optionalSingleTag(event.tags, "end_tzid")
    if (rawStartTzid === null || rawEndTzid === null) return null
    try {
      startTzid = normalizeTimeZone(rawStartTzid)
      endTzid = normalizeTimeZone(rawEndTzid)
    } catch {
      return null
    }
    const expectedBuckets = parseTimeDayBuckets(startSeconds, endSeconds)
    if (!expectedBuckets) return null
    const actualBuckets = new Set(tagValues(event.tags, "D"))
    if (expectedBuckets.some((bucket) => !actualBuckets.has(bucket)))
      return null
    start = startMs
    end = endMs ?? startMs
  }

  const topics = Array.from(
    new Set(
      tagValues(event.tags, "t")
        .map((topic) => topic.trim())
        .filter(Boolean)
    )
  )

  return {
    signedEvent: event,
    coordinate: coordinate.coordinate,
    eventId: event.id.toLowerCase(),
    authorPubkey: coordinate.authorPubkey,
    dTag: coordinate.dTag,
    kind:
      event.kind === EVENT_KINDS.CALENDAR_DATE
        ? EVENT_KINDS.CALENDAR_DATE
        : EVENT_KINDS.CALENDAR_TIME,
    title,
    content: event.content,
    ...(summary ? { summary } : {}),
    ...(image ? { image } : {}),
    locations: tagValues(event.tags, "location").filter(Boolean),
    ...(topics.length > 0 ? { topics } : {}),
    ...(geohash ? { geohash: geohash.toLowerCase() } : {}),
    start,
    end,
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate } : {}),
    ...(startTzid ? { startTzid } : {}),
    ...(endTzid ? { endTzid } : {}),
    createdAt: event.created_at * 1_000,
  }
}

/** Parse a signed legacy pickup revision for immutable checkout recovery only. */
export function parseEventMarketPickupEvent(
  event: VerifiedNostrEvent
): ParsedEventMarketPickup | null {
  return isVerifiedNostrEvent(event)
    ? parseEventMarketPickupFieldsForPrivateOrder(event)
    : null
}

/** Historical private-order fields; its owner validates the signature first. */
export function parseEventMarketPickupFieldsForPrivateOrder(
  event: SignedPublicNostrEvent
): ParsedEventMarketPickup | null {
  if (event.kind !== EVENT_KINDS.SHIPPING_OPTION) return null
  if (
    event.tags.some(
      (tag) => tag[0] === "destination_schema" || tag[0] === "destination"
    )
  ) {
    return null
  }
  const coordinate = eventCoordinate(event, [EVENT_KINDS.SHIPPING_OPTION])
  const title = singleTag(event.tags, "title")
  const service = singleTag(event.tags, "service")
  const priceTags = event.tags.filter((tag) => tag[0] === "price")
  const location = optionalSingleTag(event.tags, "location")
  const geohash = optionalSingleTag(event.tags, "g")
  if (
    !coordinate ||
    !title ||
    service !== "pickup" ||
    priceTags.length !== 1 ||
    location === null ||
    geohash === null ||
    (!location && !geohash) ||
    (geohash !== undefined && !GEOHASH.test(geohash))
  ) {
    return null
  }
  const priceValue = priceTags[0]?.[1]
  const price =
    priceValue !== undefined && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(priceValue)
      ? Number(priceValue)
      : NaN
  const currency = priceTags[0]?.[2]?.trim().toUpperCase()
  if (!Number.isFinite(price) || price < 0 || !currency) return null
  const countries = Array.from(
    new Set(
      event.tags
        .filter((tag) => tag[0] === "country")
        .flatMap((tag) => tag.slice(1))
        .map((country) => country.trim().toUpperCase())
    )
  )
  if (
    countries.length === 0 ||
    countries.some((country) => !/^[A-Z]{2}$/.test(country))
  ) {
    return null
  }

  return {
    signedEvent: event,
    coordinate: coordinate.coordinate,
    eventId: event.id.toLowerCase(),
    authorPubkey: coordinate.authorPubkey,
    dTag: coordinate.dTag,
    title,
    content: event.content,
    price,
    currency,
    countries,
    ...(location ? { location } : {}),
    ...(geohash ? { geohash: geohash.toLowerCase() } : {}),
    createdAt: event.created_at * 1_000,
  }
}

/** Parse a signed legacy collection revision for immutable checkout recovery only. */
export function parseEventMarketCollectionEvent(
  event: VerifiedNostrEvent
): ParsedEventMarketCollection | null {
  return isVerifiedNostrEvent(event)
    ? parseEventMarketCollectionFieldsForPrivateOrder(event)
    : null
}

/** Historical private-order fields; its owner validates the signature first. */
export function parseEventMarketCollectionFieldsForPrivateOrder(
  event: SignedPublicNostrEvent
): ParsedEventMarketCollection | null {
  if (event.kind !== EVENT_KINDS.PRODUCT_COLLECTION) return null
  const coordinate = eventCoordinate(event, [EVENT_KINDS.PRODUCT_COLLECTION])
  const title = singleTag(event.tags, "title")
  const summary = optionalSingleTag(event.tags, "summary")
  const image = optionalSingleTag(event.tags, "image")
  const location = optionalSingleTag(event.tags, "location")
  const geohash = optionalSingleTag(event.tags, "g")
  const lifecycleTags = event.tags.filter(
    (tag) => tag[0] === EVENT_MARKET_LIFECYCLE_TAG
  )
  const lifecycle = lifecycleTags[0]
  if (
    lifecycleTags.length > 1 ||
    (lifecycle &&
      (lifecycle.length !== 3 ||
        lifecycle[1] !== "1" ||
        (lifecycle[2] !== "open" && lifecycle[2] !== "closed")))
  ) {
    return null
  }
  const orderAcceptance = lifecycle?.[2] as
    EventMarketOrderAcceptance | undefined
  if (
    !coordinate ||
    !title ||
    summary === null ||
    image === null ||
    location === null ||
    geohash === null
  ) {
    return null
  }
  if (geohash && !GEOHASH.test(geohash)) return null

  const eventCoordinates: string[] = []
  const productCoordinates: string[] = []
  const productRelayHintsByCoordinate = new Map<string, string[]>()
  const pickupCoordinates: string[] = []
  const unsupportedReferences: string[] = []
  for (const tag of event.tags) {
    if (tag[0] === "a" && tag[1]) {
      const parsed = parseAddressableCoordinate(tag[1])
      if (!parsed) unsupportedReferences.push(tag[1])
      else if (EVENT_MARKET_CALENDAR_KINDS.includes(parsed.kind as never)) {
        eventCoordinates.push(parsed.coordinate)
      } else if (parsed.kind === EVENT_KINDS.PRODUCT) {
        productCoordinates.push(parsed.coordinate)
        const relayHints = normalizePortableRelayHints(tag[2] ? [tag[2]] : [])
        if (relayHints.length > 0) {
          productRelayHintsByCoordinate.set(
            parsed.coordinate,
            Array.from(
              new Set([
                ...(productRelayHintsByCoordinate.get(parsed.coordinate) ?? []),
                ...relayHints,
              ])
            )
          )
        }
      } else {
        unsupportedReferences.push(parsed.coordinate)
      }
    }
    if (tag[0] === "shipping_option" && tag[1]) {
      const parsed = parseAddressableCoordinate(tag[1])
      if (
        parsed?.kind === EVENT_KINDS.SHIPPING_OPTION &&
        parsed.authorPubkey === coordinate.authorPubkey
      ) {
        pickupCoordinates.push(parsed.coordinate)
      } else {
        unsupportedReferences.push(parsed?.coordinate ?? tag[1])
      }
    }
  }

  return {
    signedEvent: event,
    coordinate: coordinate.coordinate,
    eventId: event.id.toLowerCase(),
    authorPubkey: coordinate.authorPubkey,
    dTag: coordinate.dTag,
    title,
    content: event.content,
    ...(summary ? { summary } : {}),
    ...(image ? { image } : {}),
    ...(location ? { location } : {}),
    ...(geohash ? { geohash: geohash.toLowerCase() } : {}),
    ...(orderAcceptance ? { orderAcceptance } : {}),
    eventCoordinates: Array.from(new Set(eventCoordinates)),
    pickupCoordinates: Array.from(new Set(pickupCoordinates)),
    productCoordinates: Array.from(new Set(productCoordinates)),
    ...(productRelayHintsByCoordinate.size > 0
      ? {
          productRelayHintsByCoordinate: Object.fromEntries(
            productRelayHintsByCoordinate
          ),
        }
      : {}),
    unsupportedReferences: Array.from(new Set(unsupportedReferences)),
    createdAt: event.created_at * 1_000,
  }
}

export interface EventMarketDeletionEvidence {
  /** Signed kind-5 event that supplied this deletion evidence. */
  deletionEventId: string
  deletionCreatedAt: number
  authorPubkey: string
  /** Exact event ids named by valid `e` tags. */
  eventTargets: string[]
  /** Canonical addressable coordinates named by valid `a` tags. */
  addressableTargets: string[]
}

function normalizePubkey(value: string | null | undefined): string | null {
  return value && HEX_64.test(value) ? value.toLowerCase() : null
}

function validDeletionEvents(
  events: readonly SignedPublicNostrEvent[]
): SignedPublicNostrEvent[] {
  return events.filter(
    (event) =>
      event.kind === EVENT_KINDS.DELETION && isVerifiedNostrEvent(event)
  )
}

function deletionEvidenceForAddressableEvent(
  event: Pick<SignedPublicNostrEvent, "created_at" | "id"> | undefined,
  coordinate: AddressableEventCoordinate,
  deletions: readonly SignedPublicNostrEvent[]
): EventMarketDeletionEvidence[] {
  return deletionEvidenceForVerifiedAddressableEvent(
    event,
    coordinate,
    validDeletionEvents(deletions)
  )
}

function deletionEvidenceForVerifiedAddressableEvent(
  event: Pick<SignedPublicNostrEvent, "created_at" | "id"> | undefined,
  coordinate: AddressableEventCoordinate,
  deletions: readonly SignedPublicNostrEvent[]
): EventMarketDeletionEvidence[] {
  const evidenceById = new Map<string, EventMarketDeletionEvidence>()
  for (const deletion of deletions) {
    if (deletion.pubkey.toLowerCase() !== coordinate.authorPubkey) continue

    const eventTargets = Array.from(
      new Set(
        deletion.tags.flatMap((tag) =>
          tag[0] === "e" && typeof tag[1] === "string" && HEX_64.test(tag[1])
            ? [tag[1].toLowerCase()]
            : []
        )
      )
    )
    const addressableTargets = Array.from(
      new Set(
        deletion.tags.flatMap((tag) => {
          if (tag[0] !== "a" || !tag[1]) return []
          const target = parseAddressableCoordinate(tag[1])
          return target ? [target.coordinate] : []
        })
      )
    )
    const exactEventDeletion = event
      ? eventTargets.includes(event.id.toLowerCase())
      : false
    const addressableDeletion =
      addressableTargets.includes(coordinate.coordinate) &&
      (!event || deletion.created_at >= event.created_at)
    if (!exactEventDeletion && !addressableDeletion) continue

    const deletionEventId = deletion.id.toLowerCase()
    evidenceById.set(deletionEventId, {
      deletionEventId,
      deletionCreatedAt: deletion.created_at * 1_000,
      authorPubkey: deletion.pubkey.toLowerCase(),
      eventTargets,
      addressableTargets,
    })
  }
  return Array.from(evidenceById.values())
}

/** Apply the same NIP-09 exact-event and addressable deletion rules used by
 * event-market resolution to one previously parsed revision. */
export function isEventMarketAddressableRevisionDeleted(
  revision: {
    coordinate: string
    eventId: string
    createdAt: number
  },
  events: readonly SignedPublicNostrEvent[]
): boolean {
  const coordinate = parseAddressableCoordinate(
    revision.coordinate,
    EVENT_MARKET_ADDRESSABLE_KINDS
  )
  if (!coordinate || !HEX_64.test(revision.eventId)) return false
  return (
    deletionEvidenceForAddressableEvent(
      {
        id: revision.eventId,
        created_at: revision.createdAt / 1_000,
      },
      coordinate,
      events
    ).length > 0
  )
}

interface EventMarketTestOverrides {
  getRelayLists?: typeof getRelayLists
  getRelayListsDetailed?: typeof getRelayListsDetailed
  readAccountRelaySettingsPlanningSnapshot?: typeof readDurableAccountRelaySettingsPlanningSnapshot
}

let eventMarketTestOverrides: EventMarketTestOverrides = {}

export function __setEventMarketTestOverrides(
  overrides: EventMarketTestOverrides
): void {
  eventMarketTestOverrides = { ...eventMarketTestOverrides, ...overrides }
}

export function __resetEventMarketTestOverrides(): void {
  eventMarketTestOverrides = {}
}

function mergeRelayCandidatesWithOwnerAuthority(
  ownerSelectedRelayUrls: readonly string[],
  ...groups: readonly (readonly string[])[]
): string[] {
  if (getConfiguredIsolatedE2eRelayUrl()) {
    return normalizeSecureOrIsolatedE2eRelayUrls(groups.flat())
  }
  const ownerSelected = new Set(
    normalizeOwnerSelectedRelayUrls(ownerSelectedRelayUrls)
  )
  const result = new Set<string>()
  for (const group of groups) {
    for (const value of group) {
      const remoteRelayUrl = normalizeRemoteRelayHint(value)
      if (remoteRelayUrl) {
        result.add(remoteRelayUrl)
      } else {
        const normalized = tryNormalizeRelayUrl(value)
        if (!normalized.ok || !ownerSelected.has(normalized.url)) continue
        result.add(normalized.url)
      }
    }
  }
  return Array.from(result)
}

function mergeRelayUrlsWithOwnerAuthority(
  ownerSelectedRelayUrls: readonly string[],
  ...groups: readonly (readonly string[])[]
): string[] {
  return mergeRelayCandidatesWithOwnerAuthority(
    ownerSelectedRelayUrls,
    ...groups
  ).slice(0, EVENT_MARKET_MAX_RELAY_HINTS)
}

export interface EventMarketReadPlan {
  /** Bounded prefix used for coverage and truncation reporting. */
  relayUrls: string[]
  /** Full ordered candidates passed to final source-policy admission. */
  candidateRelayUrls: string[]
  relayTargets: RelayTarget[]
  maxRelayAttempts?: number
  ownerSelectedRelayUrls: string[]
  appRelayUrls: string[]
  personalRelayUrls: string[]
  independentRelayUrls: string[]
  relayListState: RelayListResolutionState
  relayHintTruncated: boolean
}

function relayListStateFromLegacyLookup(
  relayLists: ReadonlyMap<string, RelayList>,
  organizerPubkey: string
): RelayListResolutionState {
  const list = relayLists.get(organizerPubkey)
  if (!list) return "missing"
  return list.lookupState ?? "fresh-cache"
}

export async function getEventMarketReadPlan(input: {
  organizerPubkey: string
  relayHints?: readonly string[]
  authenticatedPubkey?: string | null
  accountNetworkLocalStateRepository?: PublicRelayReadOptions["accountNetworkLocalStateRepository"]
  shouldContinue?: PublicRelayReadOptions["shouldContinue"]
  signal?: AbortSignal
}): Promise<EventMarketReadPlan> {
  const authenticatedPubkey = input.authenticatedPubkey
    ? normalizePubkey(input.authenticatedPubkey)
    : null
  let ownerSettingsSnapshot: Awaited<
    ReturnType<typeof readDurableAccountRelaySettingsPlanningSnapshot>
  > | null = null
  if (authenticatedPubkey) {
    try {
      ownerSettingsSnapshot = await (
        eventMarketTestOverrides.readAccountRelaySettingsPlanningSnapshot ??
        readDurableAccountRelaySettingsPlanningSnapshot
      )(authenticatedPubkey)
    } catch {
      // Missing durable owner evidence grants no ws:// transport authority.
    }
  }
  const ownerSelectedRelayUrls = normalizeOwnerSelectedRelayUrls(
    ownerSettingsSnapshot?.settings.entries.flatMap((entry) =>
      entry.readEnabled ||
      (authenticatedPubkey === input.organizerPubkey && entry.writeEnabled)
        ? [entry.url]
        : []
    ) ?? []
  )
  const relayListLookupPlan = planRelayReads({
    intent: "relay_lists",
    authenticatedPubkey,
    ownerSelectedRelayUrls,
    settings: ownerSettingsSnapshot?.settings,
    signedRelayListAuthoritative:
      ownerSettingsSnapshot?.signedRelayListAuthoritative,
  })
  const lookupOptions = {
    signal: input.signal,
    relayUrls: relayListLookupPlan.candidateRelayUrls,
    relayTargets: relayListLookupPlan.relayTargets,
    maxRelayAttempts: relayListLookupPlan.maxRelayAttempts,
    accountPubkey: authenticatedPubkey,
    authenticatedPubkey,
    ownerSelectedRelayUrls,
    appRelayUrls: relayListLookupPlan.appRelayUrls,
    personalRelayUrls: relayListLookupPlan.personalRelayUrls,
    independentRelayUrls: relayListLookupPlan.independentRelayUrls,
    accountNetworkLocalStateRepository:
      input.accountNetworkLocalStateRepository,
    shouldContinue: input.shouldContinue,
  }
  let relayLists: Map<string, RelayList>
  let relayListState: RelayListResolutionState
  if (eventMarketTestOverrides.getRelayListsDetailed) {
    const detailed = await eventMarketTestOverrides.getRelayListsDetailed(
      [input.organizerPubkey],
      lookupOptions
    )
    relayLists = detailed.relayLists
    relayListState =
      detailed.resolutionStates.get(input.organizerPubkey) ??
      "lookup-unavailable"
  } else if (eventMarketTestOverrides.getRelayLists) {
    relayLists = await eventMarketTestOverrides.getRelayLists(
      [input.organizerPubkey],
      lookupOptions
    )
    relayListState = relayListStateFromLegacyLookup(
      relayLists,
      input.organizerPubkey
    )
  } else {
    const detailed = await getRelayListsDetailed(
      [input.organizerPubkey],
      lookupOptions
    )
    relayLists = detailed.relayLists
    relayListState =
      detailed.resolutionStates.get(input.organizerPubkey) ??
      "lookup-unavailable"
  }
  const plan = planRelayReads({
    intent: "author_products",
    authors: [input.organizerPubkey],
    relayLists,
    authenticatedPubkey,
    ownerSelectedRelayUrls,
    maxRelays: EVENT_MARKET_MAX_RELAY_HINTS,
    settings: ownerSettingsSnapshot?.settings,
    signedRelayListAuthoritative:
      ownerSettingsSnapshot?.signedRelayListAuthoritative,
  })
  const parkedRelays = new Set(
    plan.parkedRelayUrls.map((relayUrl) => relayUrl.toLowerCase())
  )
  const usableOrganizerHints = plan.hintRelayUrls.filter(
    (relayUrl) => !parkedRelays.has(relayUrl.toLowerCase())
  )
  const organizerHintRelays = new Set(
    plan.hintRelayUrls.map((relayUrl) => relayUrl.toLowerCase())
  )
  const ownerSelectedRelays = new Set(
    (plan.ownerSelectedRelayUrls ?? []).map((relayUrl) =>
      relayUrl.toLowerCase()
    )
  )
  const planFallbackRelayUrls = plan.candidateRelayUrls.filter((relayUrl) => {
    const key = relayUrl.toLowerCase()
    return !organizerHintRelays.has(key) && !ownerSelectedRelays.has(key)
  })
  const relayPrefix = mergeRelayUrlsWithOwnerAuthority(
    plan.ownerSelectedRelayUrls ?? [],
    usableOrganizerHints
  )
  const portableRelayHints = normalizePortableRelayHints(input.relayHints)
  const independentRelaySet = new Set([
    ...(plan.independentRelayUrls ?? []),
    ...portableRelayHints,
  ])
  const reservedPlanFallback =
    portableRelayHints.length > 0 ? planFallbackRelayUrls.slice(0, 1) : []
  const portableHintsBeforeFallback = portableRelayHints.slice(
    0,
    Math.max(
      0,
      EVENT_MARKET_MAX_RELAY_HINTS -
        relayPrefix.length -
        reservedPlanFallback.length
    )
  )
  const selectedRelayUrls = mergeRelayUrlsWithOwnerAuthority(
    plan.ownerSelectedRelayUrls ?? [],
    relayPrefix,
    portableHintsBeforeFallback,
    reservedPlanFallback,
    portableRelayHints.slice(portableHintsBeforeFallback.length),
    plan.candidateRelayUrls
  )
  const relayUrls = mergeRelayCandidatesWithOwnerAuthority(
    plan.ownerSelectedRelayUrls ?? [],
    selectedRelayUrls,
    usableOrganizerHints,
    portableRelayHints,
    planFallbackRelayUrls,
    plan.candidateRelayUrls
  )
  const selectedRelays = new Set(
    selectedRelayUrls.map((relayUrl) => relayUrl.toLowerCase())
  )
  return {
    relayUrls: selectedRelayUrls,
    candidateRelayUrls: relayUrls,
    relayTargets: mergeRelayTargets(
      plan.relayTargets,
      relayTargetsFromUrls(portableRelayHints, {
        kind: "public_hint",
        operation: "read",
      })
    ).filter((target) => relayUrls.includes(target.url)),
    maxRelayAttempts: plan.maxRelayAttempts ?? EVENT_MARKET_MAX_RELAY_HINTS,
    ownerSelectedRelayUrls: plan.ownerSelectedRelayUrls ?? [],
    appRelayUrls: plan.appRelayUrls ?? [],
    personalRelayUrls: plan.personalRelayUrls ?? [],
    independentRelayUrls: relayUrls.filter((relayUrl) =>
      independentRelaySet.has(relayUrl)
    ),
    relayListState,
    relayHintTruncated: plan.hintRelayUrls.some(
      (relayUrl) => !selectedRelays.has(relayUrl.toLowerCase())
    ),
  }
}
