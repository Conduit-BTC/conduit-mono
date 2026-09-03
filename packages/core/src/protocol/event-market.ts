import { NDKEvent, nip19, type NDKFilter } from "@nostr-dev-kit/ndk"
import { db, type CachedEventMarketEvidence } from "../db"
import type { ProductSchema } from "../schemas"
import { EVENT_KINDS } from "./kinds"
import { waitForVisibleDocument } from "./interactive-signer"
import {
  fetchEventsFanoutDetailed,
  getEventSourceRelayUrls,
  getNdk,
  type FetchEventsFanoutResult,
} from "./ndk"
import { appendConduitClientTag, type ConduitAppId } from "./nip89"
import {
  resolveEventMarketProductFulfillment,
  type EventMarketHandoffMode,
  type EventMarketProductFulfillmentAmbiguityReason,
} from "./event-market-fulfillment"
import {
  projectSignedProductFulfillmentEvidence,
  projectSignedProductPreviewEvidence,
} from "./product-event-evidence"
import {
  getRelayLists,
  getRelayListsDetailed,
  type RelayList,
  type RelayListResolutionState,
} from "./relay-list"
import {
  publishWithPlanner,
  type PublishWithPlannerResult,
} from "./relay-publish"
import { planRelayReads } from "./relay-planner"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

const HEX_64 = /^[0-9a-f]{64}$/i
const CONTROL_CHARACTER = /\p{Cc}/u
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const NON_NEGATIVE_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/
const GEOHASH = /^[0-9bcdefghjkmnpqrstuvwxyz]{1,32}$/i
const EVENT_MARKET_MAX_D_TAG_LENGTH = 128
const EVENT_MARKET_MAX_RELAY_HINTS = 8
const EVENT_MARKET_MAX_DAY_BUCKETS = 370
const EVENT_MARKET_MAX_AUTHOR_EVENTS = 500
const EVENT_MARKET_MAX_CACHED_EVIDENCE_PER_ORGANIZER = 750
const EVENT_MARKET_FRONTIER_FILTER_BATCH_SIZE = 32
const EVENT_MARKET_FRONTIER_QUERY_CONCURRENCY = 4
// On broad-read saturation, discover at most one beyond the exact-frontier
// budget so an incomplete organizer list becomes explicit instead of empty.
const EVENT_MARKET_COLLECTION_DISCOVERY_TARGET_LIMIT = 64
const EVENT_MARKET_COLLECTION_DISCOVERY_READ_LIMIT =
  EVENT_MARKET_COLLECTION_DISCOVERY_TARGET_LIMIT + 1
const DEFAULT_EVENT_MARKET_EVIDENCE_MAX_AGE_MS = 5 * 60_000

/**
 * Client execution-safety budget for one bounded participation read. This is
 * not a Nostr, Gamma Markets, location, or event-specific protocol limit.
 */
export const EVENT_MARKET_PARTICIPATION_FRONTIER_TARGET_LIMIT = 64
/** Per-coordinate revision cap within the same client execution budget. */
export const EVENT_MARKET_PARTICIPATION_REVISIONS_PER_TARGET_LIMIT = 4
/** Maximum exact NIP-09 `a` plus `e` targets for one participation read. */
export const EVENT_MARKET_PARTICIPATION_DELETION_TARGET_LIMIT =
  EVENT_MARKET_PARTICIPATION_FRONTIER_TARGET_LIMIT *
  (EVENT_MARKET_PARTICIPATION_REVISIONS_PER_TARGET_LIMIT + 1)

export const EVENT_MARKET_ADDRESSABLE_KINDS = [
  EVENT_KINDS.PRODUCT,
  EVENT_KINDS.PRODUCT_COLLECTION,
  EVENT_KINDS.SHIPPING_OPTION,
  EVENT_KINDS.CALENDAR_DATE,
  EVENT_KINDS.CALENDAR_TIME,
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

export interface EventMarketPickupDraftInput {
  dTag: string
  title: string
  price: number
  currency: string
  countries: string[]
  location?: string
  geohash?: string
  content?: string
  clientAppId?: ConduitAppId
}

export interface EventMarketCollectionDraftInput {
  dTag: string
  title: string
  eventCoordinate: string
  /** Organizer-owned event pickup; omitted when merchants handle pickup. */
  pickupCoordinate?: string
  /** Compatibility projection; at most one organizer-owned coordinate. */
  pickupCoordinates?: string[]
  productCoordinates?: string[]
  content?: string
  summary?: string
  image?: string
  location?: string
  geohash?: string
  clientAppId?: ConduitAppId
}

export interface ParsedEventMarketCalendar {
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

export interface ParsedEventMarketPickup {
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
}

export interface ParsedEventMarketCollection {
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

function normalizeRelayHints(values: readonly string[] | undefined): string[] {
  const hints = new Set<string>()
  for (const value of values ?? []) {
    const normalized = normalizeRelayHint(value)
    if (normalized) hints.add(normalized)
    if (hints.size >= EVENT_MARKET_MAX_RELAY_HINTS) break
  }
  return Array.from(hints)
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

function parseNonNegativeDecimal(value: string | undefined): number | null {
  if (value === undefined || !NON_NEGATIVE_DECIMAL.test(value)) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
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

function addDisplayTags(
  tags: string[][],
  input: EventMarketDisplayDraftInput
): void {
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
  addDisplayTags(tags, input)

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
      normalizeOptionalText(input.content, "Calendar content", 10_000) ?? "",
    tags,
  }
}

function normalizeCountries(values: readonly string[]): string[] {
  const countries = new Set<string>()
  for (const value of values) {
    const country = value.trim().toUpperCase()
    if (!/^[A-Z]{2}$/.test(country))
      throw new Error("Pickup country is invalid.")
    countries.add(country)
  }
  if (countries.size === 0) throw new Error("Pickup requires a country.")
  return Array.from(countries)
}

export function buildEventMarketPickupDraft(
  input: EventMarketPickupDraftInput
): EventMarketEventDraft {
  const dTag = normalizeDTag(input.dTag)
  const title = normalizeRequiredText(input.title, "Pickup title", 200)
  if (
    !Number.isFinite(input.price) ||
    input.price < 0 ||
    !NON_NEGATIVE_DECIMAL.test(String(input.price))
  ) {
    throw new Error("Pickup price is invalid.")
  }
  const currency = normalizeRequiredText(
    input.currency,
    "Pickup currency",
    12
  ).toUpperCase()
  const countries = normalizeCountries(input.countries)
  const location = normalizeOptionalText(input.location, "Pickup location", 500)
  const geohash = normalizeOptionalText(input.geohash, "Pickup geohash", 32)
  if (geohash && !GEOHASH.test(geohash))
    throw new Error("Pickup geohash is invalid.")
  if (!location && !geohash) {
    throw new Error("Pickup requires a public location or geohash.")
  }

  let tags: string[][] = [
    ["d", dTag],
    ["title", title],
    ["price", String(input.price), currency],
    ["country", ...countries],
    ["service", "pickup"],
  ]
  if (location) tags.push(["location", location])
  if (geohash) tags.push(["g", geohash.toLowerCase()])
  if (input.clientAppId) tags = appendConduitClientTag(tags, input.clientAppId)

  return {
    kind: EVENT_KINDS.SHIPPING_OPTION,
    content:
      normalizeOptionalText(input.content, "Pickup content", 10_000) ?? "",
    tags,
  }
}

function uniqueCoordinates(
  values: readonly string[] | undefined,
  allowedKinds: readonly number[],
  label: string
): string[] {
  const result = new Set<string>()
  for (const value of values ?? []) {
    const parsed = parseAddressableCoordinate(value, allowedKinds)
    if (!parsed) throw new Error(`${label} coordinate is invalid.`)
    result.add(parsed.coordinate)
  }
  return Array.from(result)
}

export function buildEventMarketCollectionDraft(
  input: EventMarketCollectionDraftInput
): EventMarketEventDraft {
  const dTag = normalizeDTag(input.dTag)
  const title = normalizeRequiredText(input.title, "Collection title", 200)
  const eventCoordinate = uniqueCoordinates(
    [input.eventCoordinate],
    EVENT_MARKET_CALENDAR_KINDS,
    "Calendar"
  )[0]!
  const pickupCoordinates = uniqueCoordinates(
    [
      ...(input.pickupCoordinates ?? []),
      ...(input.pickupCoordinate ? [input.pickupCoordinate] : []),
    ],
    [EVENT_KINDS.SHIPPING_OPTION],
    "Pickup"
  )
  const calendarIdentity = parseAddressableCoordinate(
    eventCoordinate,
    EVENT_MARKET_CALENDAR_KINDS
  )!
  if (
    pickupCoordinates.length > 1 ||
    pickupCoordinates.some(
      (value) =>
        parseAddressableCoordinate(value, [EVENT_KINDS.SHIPPING_OPTION])
          ?.authorPubkey !== calendarIdentity.authorPubkey
    )
  ) {
    throw new Error(
      "Collection supports at most one organizer-authored pickup option."
    )
  }
  const productCoordinates = uniqueCoordinates(
    input.productCoordinates,
    [EVENT_KINDS.PRODUCT],
    "Product"
  )
  const summary = normalizeOptionalText(
    input.summary,
    "Collection summary",
    1_000
  )
  const image = normalizeOptionalText(input.image, "Collection image", 2_048)
  const location = normalizeOptionalText(
    input.location,
    "Collection location",
    500
  )
  const geohash = normalizeOptionalText(input.geohash, "Collection geohash", 32)
  if (geohash && !GEOHASH.test(geohash))
    throw new Error("Collection geohash is invalid.")

  let tags: string[][] = [
    ["d", dTag],
    ["title", title],
    ["a", eventCoordinate],
    ...pickupCoordinates.map((coordinate) => ["shipping_option", coordinate]),
    ...productCoordinates.map((coordinate) => ["a", coordinate]),
  ]
  if (summary) tags.push(["summary", summary])
  if (image) tags.push(["image", image])
  if (location) tags.push(["location", location])
  if (geohash) tags.push(["g", geohash.toLowerCase()])
  if (input.clientAppId) tags = appendConduitClientTag(tags, input.clientAppId)

  return {
    kind: EVENT_KINDS.PRODUCT_COLLECTION,
    content:
      normalizeOptionalText(input.content, "Collection content", 10_000) ?? "",
    tags,
  }
}

function tagValues(tags: readonly string[][], name: string): string[] {
  return tags
    .filter((tag) => tag[0] === name && typeof tag[1] === "string")
    .map((tag) => tag[1]!)
}

function singleTag(tags: readonly string[][], name: string): string | null {
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
  tags: readonly string[][],
  name: string
): string | undefined | null {
  const values = tagValues(tags, name)
  if (values.length > 1) return null
  return values[0]
}

function validSignedKind(
  event: SignedPublicNostrEvent,
  kinds: readonly number[]
): boolean {
  return kinds.includes(event.kind) && isValidSignedPublicNostrEvent(event)
}

export function parseEventMarketCalendarEvent(
  event: SignedPublicNostrEvent
): ParsedEventMarketCalendar | null {
  if (!validSignedKind(event, EVENT_MARKET_CALENDAR_KINDS)) return null
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

  return {
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

export function parseEventMarketPickupEvent(
  event: SignedPublicNostrEvent
): ParsedEventMarketPickup | null {
  if (!validSignedKind(event, [EVENT_KINDS.SHIPPING_OPTION])) return null
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
  const price = parseNonNegativeDecimal(priceTags[0]?.[1])
  const currency = priceTags[0]?.[2]?.trim().toUpperCase()
  if (price === null || !currency) return null
  let countries: string[]
  try {
    countries = normalizeCountries(
      event.tags
        .filter((tag) => tag[0] === "country")
        .flatMap((tag) => tag.slice(1))
    )
  } catch {
    return null
  }

  return {
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

export function parseEventMarketCollectionEvent(
  event: SignedPublicNostrEvent
): ParsedEventMarketCollection | null {
  if (!validSignedKind(event, [EVENT_KINDS.PRODUCT_COLLECTION])) return null
  const coordinate = eventCoordinate(event, [EVENT_KINDS.PRODUCT_COLLECTION])
  const title = singleTag(event.tags, "title")
  const summary = optionalSingleTag(event.tags, "summary")
  const image = optionalSingleTag(event.tags, "image")
  const location = optionalSingleTag(event.tags, "location")
  const geohash = optionalSingleTag(event.tags, "g")
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
    eventCoordinates: Array.from(new Set(eventCoordinates)),
    pickupCoordinates: Array.from(new Set(pickupCoordinates)),
    productCoordinates: Array.from(new Set(productCoordinates)),
    unsupportedReferences: Array.from(new Set(unsupportedReferences)),
    createdAt: event.created_at * 1_000,
  }
}

export type EventMarketResolutionState =
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

export interface EventMarketRelayCoverage {
  attemptedRelayCount: number
  completeRelayCount: number
  partialRelayCount: number
  failedRelayCount: number
}

type EventMarketProductPreviewBase = Pick<
  ProductSchema,
  "title" | "summary" | "type" | "format" | "stock"
> & {
  /** Exact kind-30402 coordinate whose signed revision produced this preview. */
  coordinate: string
  /** Exact signed revision selected by NIP-01 addressable-event ordering. */
  eventId: string
  createdAt: number
  /** Bounded display media copied from the same signed revision. */
  images: ProductSchema["images"]
}

/**
 * Display-only projection of the exact verified product participation revision.
 * A malformed price remains previewable but never acquires fallback price terms.
 */
export type EventMarketProductPreview = EventMarketProductPreviewBase &
  (
    | ({
        priceStatus: "resolved"
      } & Pick<
        ProductSchema,
        "price" | "currency" | "priceSats" | "sourcePrice"
      >)
    | {
        priceStatus: "malformed"
      }
  )

export interface EventMarketParticipationRequest {
  productCoordinate: string
  merchantPubkey: string
  eventId?: string
  createdAt?: number
  title?: string
  productPreview?: EventMarketProductPreview
  fulfillmentStatus?: "none" | "ambiguous" | "resolved"
  fulfillmentReason?: EventMarketProductFulfillmentAmbiguityReason
  pickupCoordinate?: string
  pickupAuthorPubkey?: string
  handoffMode?: EventMarketHandoffMode
  handoffPubkey?: string
}

export interface EventMarketAcceptedProductEvidence {
  productCoordinate: string
  eventId: string
  createdAt: number
  shippingOptionCoordinates: string[]
  merchantPubkey?: string
  title?: string
  productPreview?: EventMarketProductPreview
  fulfillmentStatus?: "none" | "ambiguous" | "resolved"
  fulfillmentReason?: EventMarketProductFulfillmentAmbiguityReason
  pickupCoordinate?: string
  pickupAuthorPubkey?: string
  handoffMode?: EventMarketHandoffMode
  handoffPubkey?: string
}

export interface EventMarketParticipationBudget {
  state: "within_budget" | "exceeded"
  targetCount: number
  targetLimit: number
}

export interface EventMarketResolution {
  state: EventMarketResolutionState
  /** Canonical kind-30405 coordinate. */
  reference: string
  organizerPubkey?: string
  collectionCoordinate?: string
  calendarCoordinate?: string
  /** Unique organizer-authored event pickup, when exactly one is advertised. */
  pickupCoordinate?: string
  collection?: ParsedEventMarketCollection
  calendar?: ParsedEventMarketCalendar
  /** Parsed revision for pickupCoordinate; merchant booths remain in pickups. */
  pickup?: ParsedEventMarketPickup
  /** Current organizer offer plus verified product-selected merchant booths. */
  pickups: ParsedEventMarketPickup[]
  /** Exact product coordinates signed into the current organizer collection. */
  organizerProductCoordinates: string[]
  /** Current products that still request the collection and are organizer-listed. */
  acceptedProductCoordinates: string[]
  /** Exact current merchant revisions behind acceptedProductCoordinates. */
  acceptedProductEvidence: EventMarketAcceptedProductEvidence[]
  /** Organizer-listed products whose current merchant request is absent. */
  organizerOnlyProductCoordinates: string[]
  participationRequests: EventMarketParticipationRequest[]
  participationBudget: EventMarketParticipationBudget
  pickupBudget: EventMarketParticipationBudget
  coverage: EventMarketRelayCoverage
}

export interface ResolveEventMarketEvidenceInput {
  reference: string
  events?: readonly SignedPublicNostrEvent[]
  collectionEvents?: readonly SignedPublicNostrEvent[]
  calendarEvents?: readonly SignedPublicNostrEvent[]
  pickupEvents?: readonly SignedPublicNostrEvent[]
  deletionEvents?: readonly SignedPublicNostrEvent[]
  productRequestEvents?: readonly SignedPublicNostrEvent[]
  participationBudget?: EventMarketParticipationBudget
  pickupBudget?: EventMarketParticipationBudget
  coverage?: EventMarketRelayCoverage
  /** When retained evidence was last observed from relays. */
  evidenceObservedAt?: number
  nowMs?: number
  maxEvidenceAgeMs?: number
  expectedOrganizerPubkey?: string
  /**
   * A followed-organizer card only needs the organizer-authored collection,
   * calendar, and pickup graph. Exact event reads keep the default and resolve
   * the complete participant frontier before any selling action is exposed.
   */
  includeParticipation?: boolean
}

export type EventMarketProductParticipationStatus =
  "none" | "pending" | "accepted"

export interface EventMarketProductParticipation {
  status: EventMarketProductParticipationStatus
  requested: boolean
  accepted: boolean
  pickupReferenced: boolean
  collectionReferencedForFulfillment: boolean
  purchaseReady: boolean
}

const COMPLETE_LOCAL_COVERAGE: EventMarketRelayCoverage = {
  attemptedRelayCount: 0,
  completeRelayCount: 0,
  partialRelayCount: 0,
  failedRelayCount: 0,
}

const EMPTY_PARTICIPATION_BUDGET: EventMarketParticipationBudget = {
  state: "within_budget",
  targetCount: 0,
  targetLimit: EVENT_MARKET_PARTICIPATION_FRONTIER_TARGET_LIMIT,
}

function emptyResolution(
  reference: string,
  state: EventMarketResolutionState,
  coverage: EventMarketRelayCoverage = COMPLETE_LOCAL_COVERAGE
): EventMarketResolution {
  return {
    state,
    reference,
    organizerProductCoordinates: [],
    acceptedProductCoordinates: [],
    acceptedProductEvidence: [],
    organizerOnlyProductCoordinates: [],
    participationRequests: [],
    participationBudget: EMPTY_PARTICIPATION_BUDGET,
    pickupBudget: EMPTY_PARTICIPATION_BUDGET,
    pickups: [],
    coverage,
  }
}

function normalizePubkey(value: string | null | undefined): string | null {
  return value && HEX_64.test(value) ? value.toLowerCase() : null
}

function compareAddressableEvents(
  left: SignedPublicNostrEvent,
  right: SignedPublicNostrEvent
): number {
  if (left.created_at !== right.created_at) {
    return right.created_at - left.created_at
  }
  return left.id.localeCompare(right.id)
}

function eventHasCoordinateShape(
  event: SignedPublicNostrEvent,
  coordinate: AddressableEventCoordinate
): boolean {
  return (
    event.kind === coordinate.kind &&
    event.pubkey.toLowerCase() === coordinate.authorPubkey &&
    event.tags.some((tag) => tag[0] === "d" && tag[1] === coordinate.dTag)
  )
}

function validDeletionEvents(
  events: readonly SignedPublicNostrEvent[]
): SignedPublicNostrEvent[] {
  return events.filter(
    (event) =>
      event.kind === EVENT_KINDS.DELETION &&
      isValidSignedPublicNostrEvent(event)
  )
}

function deletionRemovesAddressableEvent(
  event: SignedPublicNostrEvent,
  coordinate: AddressableEventCoordinate,
  deletions: readonly SignedPublicNostrEvent[]
): boolean {
  return deletions.some((deletion) => {
    if (deletion.pubkey.toLowerCase() !== coordinate.authorPubkey) return false

    const exactEventDeletion = deletion.tags.some(
      (tag) =>
        tag[0] === "e" &&
        typeof tag[1] === "string" &&
        tag[1].toLowerCase() === event.id.toLowerCase()
    )
    if (exactEventDeletion) return true

    if (deletion.created_at < event.created_at) return false
    return deletion.tags.some((tag) => {
      if (tag[0] !== "a" || !tag[1]) return false
      const target = parseAddressableCoordinate(tag[1], [coordinate.kind])
      return (
        target?.authorPubkey === coordinate.authorPubkey &&
        target.coordinate === coordinate.coordinate
      )
    })
  })
}

type AddressableRecordResult<T> =
  | { state: "current"; value: T; event: SignedPublicNostrEvent }
  | { state: "missing" | "deleted" | "malformed" }

function resolveAddressableRecord<T>(input: {
  coordinate: AddressableEventCoordinate
  events: readonly SignedPublicNostrEvent[]
  deletions: readonly SignedPublicNostrEvent[]
  parse: (event: SignedPublicNostrEvent) => T | null
}): AddressableRecordResult<T> {
  const candidates = input.events
    .filter(
      (event) =>
        eventHasCoordinateShape(event, input.coordinate) &&
        isValidSignedPublicNostrEvent(event)
    )
    .sort(compareAddressableEvents)
  if (candidates.length === 0) return { state: "missing" }

  let deletedRevisionObserved = false
  for (const candidate of candidates) {
    if (
      deletionRemovesAddressableEvent(
        candidate,
        input.coordinate,
        input.deletions
      )
    ) {
      deletedRevisionObserved = true
      continue
    }
    const parsed = input.parse(candidate)
    return parsed
      ? { state: "current", value: parsed, event: candidate }
      : { state: "malformed" }
  }
  return { state: deletedRevisionObserved ? "deleted" : "missing" }
}

function coverageFromRelayStatuses(
  relays: FetchEventsFanoutResult["relays"]
): EventMarketRelayCoverage {
  return {
    attemptedRelayCount: relays.length,
    completeRelayCount: relays.filter((relay) => relay.status === "success")
      .length,
    partialRelayCount: relays.filter((relay) => relay.status === "partial")
      .length,
    failedRelayCount: relays.filter((relay) => relay.status === "failed")
      .length,
  }
}

function mergeRelayReadStatuses(
  ...groups: ReadonlyArray<FetchEventsFanoutResult["relays"]>
): FetchEventsFanoutResult["relays"] {
  const byRelay = new Map<
    string,
    {
      relayUrl: string
      eventCount: number
      success: boolean
      partial: boolean
      failed: boolean
    }
  >()
  for (const relay of groups.flat()) {
    const key = relay.relayUrl.toLowerCase()
    const aggregate = byRelay.get(key) ?? {
      relayUrl: relay.relayUrl,
      eventCount: 0,
      success: false,
      partial: false,
      failed: false,
    }
    aggregate.eventCount += relay.eventCount
    aggregate[relay.status] = true
    byRelay.set(key, aggregate)
  }
  return Array.from(byRelay.values()).map((relay) => ({
    relayUrl: relay.relayUrl,
    eventCount: relay.eventCount,
    status:
      relay.partial || (relay.success && relay.failed)
        ? "partial"
        : relay.success
          ? "success"
          : "failed",
  }))
}

function relayUrlsWithoutObservedFailures(
  relayUrls: readonly string[],
  ...groups: ReadonlyArray<FetchEventsFanoutResult["relays"]>
): string[] {
  const failed = new Set(
    groups
      .flat()
      .flatMap((relay) =>
        relay.status === "failed" ? [relay.relayUrl.toLowerCase()] : []
      )
  )
  return relayUrls.filter((relayUrl) => !failed.has(relayUrl.toLowerCase()))
}

function coverageForNetworkRead(
  relays: FetchEventsFanoutResult["relays"],
  plannedRelayCount: number
): EventMarketRelayCoverage {
  const coverage = coverageFromRelayStatuses(relays)
  if (coverage.attemptedRelayCount > 0 || plannedRelayCount === 0) {
    return plannedRelayCount === 0
      ? {
          attemptedRelayCount: 1,
          completeRelayCount: 0,
          partialRelayCount: 0,
          failedRelayCount: 1,
        }
      : coverage
  }
  return {
    attemptedRelayCount: plannedRelayCount,
    completeRelayCount: 0,
    partialRelayCount: 0,
    failedRelayCount: plannedRelayCount,
  }
}

function coverageState(
  coverage: EventMarketRelayCoverage
): "complete" | "partial" | "unavailable" {
  if (coverage.attemptedRelayCount === 0) return "complete"
  if (coverage.completeRelayCount === 0 && coverage.partialRelayCount === 0) {
    return "unavailable"
  }
  return coverage.partialRelayCount > 0 || coverage.failedRelayCount > 0
    ? "partial"
    : "complete"
}

function organizerMarketsReadState(
  coverage: EventMarketRelayCoverage,
  plan: Pick<EventMarketReadPlan, "relayListState" | "relayHintTruncated">
): OrganizerEventMarketsReadState {
  const networkState = coverageState(coverage)
  if (networkState === "unavailable") return "unavailable"
  const relayListComplete =
    plan.relayListState === "network" ||
    plan.relayListState === "fresh-cache" ||
    plan.relayListState === "missing"
  return networkState === "complete" &&
    relayListComplete &&
    !plan.relayHintTruncated
    ? "complete"
    : "partial"
}

function parsedWithSources<T extends { eventId: string }>(
  parsed: T,
  sourceRelayUrlsById: ReadonlyMap<string, string[]>
): T {
  const sourceRelayUrls =
    sourceRelayUrlsById.get(parsed.eventId.toLowerCase()) ?? []
  return sourceRelayUrls.length > 0 ? { ...parsed, sourceRelayUrls } : parsed
}

function collectEventEvidence(
  input: ResolveEventMarketEvidenceInput
): SignedPublicNostrEvent[] {
  return [
    ...(input.events ?? []),
    ...(input.collectionEvents ?? []),
    ...(input.calendarEvents ?? []),
    ...(input.pickupEvents ?? []),
  ]
}

function currentEventMarketProductRequests(input: {
  events: readonly SignedPublicNostrEvent[]
  collectionCoordinate: string
  organizerProducts: readonly string[]
}): Map<string, SignedPublicNostrEvent> {
  const candidateCoordinates = new Map<string, AddressableEventCoordinate>()
  for (const productCoordinate of input.organizerProducts) {
    const coordinate = parseAddressableCoordinate(productCoordinate, [
      EVENT_KINDS.PRODUCT,
    ])
    if (coordinate) candidateCoordinates.set(coordinate.coordinate, coordinate)
  }
  for (const event of input.events) {
    if (
      event.kind !== EVENT_KINDS.PRODUCT ||
      !isValidSignedPublicNostrEvent(event) ||
      !event.tags.some(
        (tag) => tag[0] === "a" && tag[1] === input.collectionCoordinate
      )
    ) {
      continue
    }
    const dTags = tagValues(event.tags, "d")
    if (dTags.length !== 1) continue
    const coordinate = parseAddressableCoordinate(
      `${EVENT_KINDS.PRODUCT}:${event.pubkey}:${dTags[0]}`,
      [EVENT_KINDS.PRODUCT]
    )
    if (coordinate) candidateCoordinates.set(coordinate.coordinate, coordinate)
  }

  const deletions = validDeletionEvents(input.events)
  const currentRequests = new Map<string, SignedPublicNostrEvent>()
  for (const coordinate of candidateCoordinates.values()) {
    const current = resolveAddressableRecord({
      coordinate,
      events: input.events,
      deletions,
      parse: (event) =>
        eventCoordinate(event, [EVENT_KINDS.PRODUCT]) ? event : null,
    })
    if (
      current.state !== "current" ||
      !current.value.tags.some(
        (tag) => tag[0] === "a" && tag[1] === input.collectionCoordinate
      )
    ) {
      continue
    }
    currentRequests.set(coordinate.coordinate, current.value)
  }
  return currentRequests
}

function directMerchantPickupCoordinatesFromProductEvidence(input: {
  events: readonly SignedPublicNostrEvent[]
  collectionCoordinate: string
  organizerProducts: readonly string[]
  organizerPubkey: string
}): AddressableEventCoordinate[] {
  const coordinates = new Map<string, AddressableEventCoordinate>()
  const currentRequests = currentEventMarketProductRequests(input)
  for (const [productCoordinate, event] of currentRequests) {
    const product = parseAddressableCoordinate(productCoordinate, [
      EVENT_KINDS.PRODUCT,
    ])
    if (!product || product.authorPubkey === input.organizerPubkey) continue
    const projection = projectSignedProductFulfillmentEvidence(event)
    for (const reference of projection.shippingOptionRefs ?? []) {
      const pickup = parseAddressableCoordinate(reference.coordinate, [
        EVENT_KINDS.SHIPPING_OPTION,
      ])
      if (pickup?.authorPubkey === product.authorPubkey) {
        coordinates.set(pickup.coordinate, pickup)
      }
    }
  }
  return Array.from(coordinates.values()).sort((left, right) =>
    left.coordinate.localeCompare(right.coordinate)
  )
}

function getCurrentParticipation(
  events: readonly SignedPublicNostrEvent[],
  organizerPubkey: string,
  collection: ParsedEventMarketCollection,
  pickups: readonly ParsedEventMarketPickup[],
  collectionCoordinate: string,
  organizerProducts: readonly string[]
): {
  acceptedProductCoordinates: string[]
  acceptedProductEvidence: EventMarketAcceptedProductEvidence[]
  organizerOnlyProductCoordinates: string[]
  participationRequests: EventMarketParticipationRequest[]
} {
  const currentRequests = currentEventMarketProductRequests({
    events,
    collectionCoordinate,
    organizerProducts,
  })

  const projectProductPreview = (
    productCoordinate: string,
    event: SignedPublicNostrEvent
  ): EventMarketProductPreview | undefined => {
    const product = projectSignedProductPreviewEvidence(event)
    if (!product) return undefined
    return {
      coordinate: productCoordinate,
      eventId: event.id.toLowerCase(),
      createdAt: event.created_at * 1_000,
      ...product,
    }
  }

  const projectProduct = (
    productCoordinate: string,
    event: SignedPublicNostrEvent
  ) => {
    const productEvidence = projectSignedProductFulfillmentEvidence(event)
    const shippingOptionCoordinates = Array.from(
      new Set(
        (productEvidence.shippingOptionRefs ?? []).map(
          (reference) => reference.coordinate
        )
      )
    )
    const organizerPickups = pickups.filter(
      (pickup) => pickup.authorPubkey === organizerPubkey
    )
    const fulfillment = resolveEventMarketProductFulfillment(
      {
        id: productCoordinate,
        ...productEvidence,
      },
      {
        organizerPubkey,
        collection,
        pickup: organizerPickups.length === 1 ? organizerPickups[0] : undefined,
        pickups: [...pickups],
      }
    )
    const titles = tagValues(event.tags, "title")
      .map((value) => value.trim())
      .filter((value) => value && !CONTROL_CHARACTER.test(value))
    const productPreview = projectProductPreview(productCoordinate, event)
    return {
      eventId: event.id.toLowerCase(),
      createdAt: event.created_at * 1_000,
      shippingOptionCoordinates,
      ...(titles.length === 1 ? { title: titles[0] } : {}),
      ...(productPreview ? { productPreview } : {}),
      fulfillmentStatus: fulfillment.status,
      ...(fulfillment.status === "ambiguous"
        ? { fulfillmentReason: fulfillment.reason }
        : {}),
      ...(fulfillment.status === "resolved"
        ? {
            pickupCoordinate: fulfillment.selectedPickup.coordinate,
            pickupAuthorPubkey: fulfillment.pickupAuthorPubkey,
            handoffMode: fulfillment.handoffMode,
            handoffPubkey: fulfillment.handoffPubkey,
          }
        : {}),
    }
  }

  const organizerProductSet = new Set(organizerProducts)
  const acceptedProductCoordinates = organizerProducts
    .filter((coordinate) => currentRequests.has(coordinate))
    .sort()
  const acceptedProductEvidence = acceptedProductCoordinates.map(
    (productCoordinate) => {
      const event = currentRequests.get(productCoordinate)!
      const coordinate = parseAddressableCoordinate(productCoordinate, [
        EVENT_KINDS.PRODUCT,
      ])!
      const product = projectProduct(productCoordinate, event)
      return {
        productCoordinate,
        merchantPubkey: coordinate.authorPubkey,
        ...product,
      }
    }
  )
  const organizerOnlyProductCoordinates = organizerProducts
    .filter((coordinate) => !currentRequests.has(coordinate))
    .sort()
  const participationRequests = Array.from(currentRequests.keys())
    .filter((coordinate) => !organizerProductSet.has(coordinate))
    .sort()
    .map((productCoordinate) => {
      const coordinate = parseAddressableCoordinate(productCoordinate, [
        EVENT_KINDS.PRODUCT,
      ])!
      const event = currentRequests.get(productCoordinate)!
      return {
        productCoordinate,
        merchantPubkey: coordinate.authorPubkey,
        ...projectProduct(productCoordinate, event),
      }
    })
  return {
    acceptedProductCoordinates,
    acceptedProductEvidence,
    organizerOnlyProductCoordinates,
    participationRequests,
  }
}

function participationBudgetForEvidence(input: {
  organizerProductCoordinates: readonly string[]
  productRequestEvents: readonly SignedPublicNostrEvent[]
  networkBudget?: EventMarketParticipationBudget
}): EventMarketParticipationBudget {
  const localTargetCount = candidateProductCoordinates({
    candidateEvents: input.productRequestEvents,
    candidateCoordinates: input.organizerProductCoordinates,
  }).length
  const networkTargetCount = Number.isSafeInteger(
    input.networkBudget?.targetCount
  )
    ? Math.max(0, input.networkBudget!.targetCount)
    : 0
  const targetCount = Math.max(localTargetCount, networkTargetCount)
  return {
    state:
      input.networkBudget?.state === "exceeded" ||
      targetCount > EVENT_MARKET_PARTICIPATION_FRONTIER_TARGET_LIMIT
        ? "exceeded"
        : "within_budget",
    targetCount,
    targetLimit: EVENT_MARKET_PARTICIPATION_FRONTIER_TARGET_LIMIT,
  }
}

export function resolveEventMarketEvidence(
  input: ResolveEventMarketEvidenceInput
): EventMarketResolution {
  const decoded = decodeEventMarketReference(input.reference, [
    EVENT_KINDS.PRODUCT_COLLECTION,
  ])
  const coverage = input.coverage ?? COMPLETE_LOCAL_COVERAGE
  if (!decoded) return emptyResolution(input.reference, "malformed", coverage)

  const expectedOrganizer = input.expectedOrganizerPubkey
    ? normalizePubkey(input.expectedOrganizerPubkey)
    : null
  if (
    input.expectedOrganizerPubkey &&
    (!expectedOrganizer || expectedOrganizer !== decoded.authorPubkey)
  ) {
    return emptyResolution(decoded.coordinate, "unsupported", coverage)
  }

  const evidence = collectEventEvidence(input)
  const deletions = validDeletionEvents([
    ...evidence,
    ...(input.deletionEvents ?? []),
  ])
  const collectionResult = resolveAddressableRecord({
    coordinate: decoded,
    events: evidence,
    deletions,
    parse: parseEventMarketCollectionEvent,
  })
  if (collectionResult.state !== "current") {
    const readState = coverageState(coverage)
    const state =
      collectionResult.state === "missing" && readState !== "complete"
        ? readState
        : collectionResult.state
    return {
      ...emptyResolution(decoded.coordinate, state, coverage),
      organizerPubkey: decoded.authorPubkey,
      collectionCoordinate: decoded.coordinate,
    }
  }

  const collection = collectionResult.value
  const includeParticipation = input.includeParticipation !== false
  const participationBudget = includeParticipation
    ? participationBudgetForEvidence({
        organizerProductCoordinates: collection.productCoordinates,
        productRequestEvents: input.productRequestEvents ?? [],
        networkBudget: input.participationBudget,
      })
    : EMPTY_PARTICIPATION_BUDGET
  const directMerchantPickupCoordinates =
    includeParticipation && participationBudget.state === "within_budget"
      ? directMerchantPickupCoordinatesFromProductEvidence({
          events: input.productRequestEvents ?? [],
          collectionCoordinate: collection.coordinate,
          organizerProducts: collection.productCoordinates,
          organizerPubkey: decoded.authorPubkey,
        })
      : []
  const collectionPickupCoordinates = collection.pickupCoordinates.map(
    (coordinate) =>
      parseAddressableCoordinate(coordinate, [EVENT_KINDS.SHIPPING_OPTION])
  )
  const pickupTargetCount = new Set([
    ...collection.pickupCoordinates,
    ...directMerchantPickupCoordinates.map(
      (coordinate) => coordinate.coordinate
    ),
  ]).size
  const pickupBudget: EventMarketParticipationBudget = {
    state:
      input.pickupBudget?.state === "exceeded" ||
      pickupTargetCount > EVENT_MARKET_PARTICIPATION_FRONTIER_TARGET_LIMIT
        ? "exceeded"
        : "within_budget",
    targetCount: Math.max(
      pickupTargetCount,
      input.pickupBudget?.targetCount ?? 0
    ),
    targetLimit: EVENT_MARKET_PARTICIPATION_FRONTIER_TARGET_LIMIT,
  }
  const base = {
    reference: decoded.coordinate,
    organizerPubkey: decoded.authorPubkey,
    collectionCoordinate: collection.coordinate,
    organizerProductCoordinates: includeParticipation
      ? [...collection.productCoordinates]
      : [],
    acceptedProductCoordinates: [] as string[],
    acceptedProductEvidence: [] as EventMarketAcceptedProductEvidence[],
    organizerOnlyProductCoordinates: [] as string[],
    participationRequests: [] as EventMarketParticipationRequest[],
    participationBudget,
    pickupBudget,
    pickups: [] as ParsedEventMarketPickup[],
    coverage,
  }
  if (collection.unsupportedReferences.length > 0) {
    return { ...base, state: "unsupported", collection }
  }
  if (collection.eventCoordinates.length > 1) {
    return { ...base, state: "conflicting", collection }
  }
  if (collection.pickupCoordinates.length > 1) {
    return { ...base, state: "conflicting", collection }
  }
  if (pickupBudget.state === "exceeded") {
    return { ...base, state: "unsupported", collection }
  }
  const calendarCoordinate = parseAddressableCoordinate(
    collection.eventCoordinates[0],
    EVENT_MARKET_CALENDAR_KINDS
  )
  if (
    !calendarCoordinate ||
    collectionPickupCoordinates.some((value) => !value)
  ) {
    return { ...base, state: "malformed", collection }
  }
  if (calendarCoordinate.authorPubkey !== decoded.authorPubkey) {
    const organizerPickupCoordinates = collectionPickupCoordinates.filter(
      (coordinate) => coordinate?.authorPubkey === decoded.authorPubkey
    )
    return {
      ...base,
      state: "unsupported",
      collection,
      calendarCoordinate: calendarCoordinate.coordinate,
      ...(organizerPickupCoordinates.length === 1
        ? { pickupCoordinate: organizerPickupCoordinates[0]!.coordinate }
        : {}),
    }
  }

  const calendarResult = resolveAddressableRecord({
    coordinate: calendarCoordinate,
    events: evidence,
    deletions,
    parse: parseEventMarketCalendarEvent,
  })
  const organizerPickupCoordinate = collectionPickupCoordinates[0]
  const organizerPickupResult = organizerPickupCoordinate
    ? resolveAddressableRecord({
        coordinate: organizerPickupCoordinate,
        events: evidence,
        deletions,
        parse: parseEventMarketPickupEvent,
      })
    : null
  const directMerchantPickupResults = directMerchantPickupCoordinates.map(
    (coordinate) => ({
      coordinate,
      result: resolveAddressableRecord({
        coordinate,
        events: evidence,
        deletions,
        parse: parseEventMarketPickupEvent,
      }),
    })
  )
  const organizerPickupCoordinates = collectionPickupCoordinates.filter(
    (coordinate) => coordinate?.authorPubkey === decoded.authorPubkey
  )
  const graphBase = {
    ...base,
    collection,
    calendarCoordinate: calendarCoordinate.coordinate,
    ...(organizerPickupCoordinates.length === 1
      ? { pickupCoordinate: organizerPickupCoordinates[0]!.coordinate }
      : {}),
  }
  const readState = coverageState(coverage)
  if (calendarResult.state !== "current") {
    return {
      ...graphBase,
      state:
        calendarResult.state === "missing" && readState !== "complete"
          ? readState
          : calendarResult.state,
    }
  }
  if (organizerPickupResult && organizerPickupResult.state !== "current") {
    return {
      ...graphBase,
      state:
        organizerPickupResult.state === "missing" && readState !== "complete"
          ? readState
          : organizerPickupResult.state,
      calendar: calendarResult.value,
    }
  }
  const organizerPickup =
    organizerPickupResult?.state === "current"
      ? organizerPickupResult.value
      : undefined
  const pickups = [
    ...(organizerPickup ? [organizerPickup] : []),
    ...directMerchantPickupResults.flatMap((entry) =>
      entry.result.state === "current" ? [entry.result.value] : []
    ),
  ]

  if (participationBudget.state === "exceeded") {
    return {
      ...graphBase,
      state: "unsupported",
      calendar: calendarResult.value,
      ...(organizerPickup ? { pickup: organizerPickup } : {}),
      pickups,
      organizerOnlyProductCoordinates: [
        ...collection.productCoordinates,
      ].sort(),
      acceptedProductCoordinates: [],
      acceptedProductEvidence: [],
      participationRequests: [],
    }
  }
  const participation = includeParticipation
    ? getCurrentParticipation(
        input.productRequestEvents ?? [],
        decoded.authorPubkey,
        collection,
        pickups,
        collection.coordinate,
        collection.productCoordinates
      )
    : {
        acceptedProductCoordinates: [],
        acceptedProductEvidence: [],
        organizerOnlyProductCoordinates: [],
        participationRequests: [],
      }
  const resolved = {
    ...graphBase,
    calendar: calendarResult.value,
    ...(organizerPickup ? { pickup: organizerPickup } : {}),
    pickups,
    ...participation,
  }
  const nowMs = input.nowMs ?? Date.now()
  // Once the exact current calendar revision is present, an ended event is a
  // stronger fact than incomplete relay coverage. Partial coverage may remain
  // purchase-ready only while the signed event window is still active.
  if (readState === "partial" && nowMs >= calendarResult.value.end) {
    return { ...resolved, state: "ended" }
  }
  if (readState === "partial") return { ...resolved, state: "partial" }
  if (readState === "unavailable") {
    return {
      ...resolved,
      state: input.evidenceObservedAt === undefined ? "unavailable" : "stale",
    }
  }

  if (
    input.evidenceObservedAt !== undefined &&
    nowMs - input.evidenceObservedAt >
      (input.maxEvidenceAgeMs ?? DEFAULT_EVENT_MARKET_EVIDENCE_MAX_AGE_MS)
  ) {
    return { ...resolved, state: "stale" }
  }
  return {
    ...resolved,
    state: nowMs >= calendarResult.value.end ? "ended" : "active",
  }
}

export function resolveEventMarketProductParticipation(
  product: Pick<
    ProductSchema,
    | "id"
    | "collectionRefs"
    | "shippingOptionRefs"
    | "shippingOptionId"
    | "priceEvidenceMalformed"
  >,
  market: EventMarketResolution
): EventMarketProductParticipation {
  const collectionCoordinate = market.collection?.coordinate
  const collectionRefs = product.collectionRefs ?? []
  const requested = Boolean(
    collectionCoordinate && collectionRefs.includes(collectionCoordinate)
  )
  const organizerAccepted = market.acceptedProductCoordinates.includes(
    product.id
  )
  const accepted = requested && organizerAccepted
  const fulfillment = resolveEventMarketProductFulfillment(product, market)
  const { pickupReferenced, collectionReferencedForFulfillment } = fulfillment
  return {
    status: accepted ? "accepted" : requested ? "pending" : "none",
    requested,
    accepted,
    pickupReferenced,
    collectionReferencedForFulfillment,
    purchaseReady:
      (market.state === "active" || market.state === "partial") &&
      requested &&
      accepted &&
      fulfillment.status === "resolved",
  }
}

export interface GetEventMarketInput {
  reference: string
  expectedOrganizerPubkey?: string
  nowMs?: number
  maxEvidenceAgeMs?: number
  authenticatedPubkey?: string | null
  signal?: AbortSignal
}

export interface GetOrganizerEventMarketsInput {
  organizerPubkey: string
  nowMs?: number
  maxEvidenceAgeMs?: number
  authenticatedPubkey?: string | null
  /**
   * Discovery cards only need the organizer collection, calendar, and
   * organizer-authored pickup graph. The exact selected-event read hydrates
   * participant products and merchant-authored pickup frontiers.
   */
  projection?: "full" | "discovery"
  signal?: AbortSignal
}

export type OrganizerEventMarketsReadState =
  "complete" | "partial" | "unavailable"

export interface OrganizerEventMarketsReadResult {
  markets: EventMarketResolution[]
  state: OrganizerEventMarketsReadState
  coverage: EventMarketRelayCoverage
  relayListState: RelayListResolutionState
  relayHintTruncated: boolean
}

export class EventMarketDiscoveryBoundError extends Error {
  readonly code = "event_market_discovery_bound"

  constructor(message: string) {
    super(message)
    this.name = "EventMarketDiscoveryBoundError"
  }
}

interface EventMarketTestOverrides {
  fetchEventsFanoutDetailed?: typeof fetchEventsFanoutDetailed
  getRelayLists?: typeof getRelayLists
  getRelayListsDetailed?: typeof getRelayListsDetailed
  getNdk?: () => ReturnType<typeof getNdk> | Promise<ReturnType<typeof getNdk>>
  publishWithPlanner?: typeof publishWithPlanner
  signDraft?: (input: {
    draft: EventMarketEventDraft
    createdAt: number
    organizerPubkey: string
  }) => Promise<SignedPublicNostrEvent>
  loadCachedEvidence?: (
    organizerPubkey: string
  ) => Promise<CachedEventMarketEvidence[]>
  persistCachedEvidence?: (input: {
    organizerPubkey: string
    events: readonly SignedPublicNostrEvent[]
    sourceRelayUrlsById: ReadonlyMap<string, string[]>
    participantCoordinates?: readonly string[]
    participantPickupCoordinates?: readonly string[]
  }) => Promise<void>
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

function mergeRelayUrls(...groups: readonly (readonly string[])[]): string[] {
  const result = new Set<string>()
  for (const group of groups) {
    for (const value of group) {
      const normalized = normalizeRelayHint(value)
      if (normalized) result.add(normalized)
      if (result.size >= EVENT_MARKET_MAX_RELAY_HINTS) return Array.from(result)
    }
  }
  return Array.from(result)
}

interface EventMarketReadPlan {
  relayUrls: string[]
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

async function eventMarketReadPlanDetailed(input: {
  organizerPubkey: string
  relayHints?: readonly string[]
  authenticatedPubkey?: string | null
  signal?: AbortSignal
}): Promise<EventMarketReadPlan> {
  const lookupOptions = {
    signal: input.signal,
    allowInsecureRelayUrlsForPubkey: input.authenticatedPubkey,
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
    authenticatedPubkey: input.authenticatedPubkey,
    maxRelays: EVENT_MARKET_MAX_RELAY_HINTS,
  })
  const selectedRelays = new Set(
    plan.relayUrls.map((relayUrl) => relayUrl.toLowerCase())
  )
  return {
    relayUrls: mergeRelayUrls(input.relayHints ?? [], plan.relayUrls),
    relayListState,
    relayHintTruncated: plan.hintRelayUrls.some(
      (relayUrl) => !selectedRelays.has(relayUrl.toLowerCase())
    ),
  }
}

async function fetchEventMarketRecords(input: {
  organizerPubkey: string
  relayUrls: string[]
  signal?: AbortSignal
}): Promise<FetchEventsFanoutResult> {
  const fetch =
    eventMarketTestOverrides.fetchEventsFanoutDetailed ??
    fetchEventsFanoutDetailed
  const filter = {
    kinds: [
      EVENT_KINDS.PRODUCT_COLLECTION,
      EVENT_KINDS.SHIPPING_OPTION,
      EVENT_KINDS.CALENDAR_DATE,
      EVENT_KINDS.CALENDAR_TIME,
      EVENT_KINDS.DELETION,
    ],
    authors: [input.organizerPubkey],
    limit: EVENT_MARKET_MAX_AUTHOR_EVENTS,
  } as NDKFilter
  return fetch(filter, {
    relayUrls: input.relayUrls,
    signal: input.signal,
    reuseRelayConnections: true,
  })
}

function eventMarketReadReachedLimit(
  result: FetchEventsFanoutResult,
  limit: number
): boolean {
  return (
    result.events.length >= limit ||
    result.relays.some(
      (relay) => relay.status !== "failed" && relay.eventCount >= limit
    )
  )
}

function eventMarketAuthorReadReachedCap(
  result: FetchEventsFanoutResult
): boolean {
  return eventMarketReadReachedLimit(result, EVENT_MARKET_MAX_AUTHOR_EVENTS)
}

interface EventMarketCollectionDiscoveryResult {
  live: ReturnType<typeof rawSignedEvents>
  relays: FetchEventsFanoutResult["relays"]
  capped: boolean
}

async function fetchEventMarketCollectionDiscovery(input: {
  organizerPubkey: string
  relayUrls: string[]
  signal?: AbortSignal
}): Promise<EventMarketCollectionDiscoveryResult> {
  if (input.relayUrls.length === 0) {
    return {
      live: { events: [], sourceRelayUrlsById: new Map() },
      relays: [],
      capped: false,
    }
  }
  const fetch =
    eventMarketTestOverrides.fetchEventsFanoutDetailed ??
    fetchEventsFanoutDetailed
  const result = await fetch(
    {
      kinds: [EVENT_KINDS.PRODUCT_COLLECTION as never],
      authors: [input.organizerPubkey],
      limit: EVENT_MARKET_COLLECTION_DISCOVERY_READ_LIMIT,
    },
    {
      relayUrls: input.relayUrls,
      signal: input.signal,
      reuseRelayConnections: true,
    }
  )
  const capped = eventMarketReadReachedLimit(
    result,
    EVENT_MARKET_COLLECTION_DISCOVERY_READ_LIMIT
  )
  const verified = result.eventsVerified === true
  return {
    live: verified
      ? rawSignedEvents(result)
      : { events: [], sourceRelayUrlsById: new Map() },
    relays: result.relays.map((relay) => ({
      ...relay,
      status:
        relay.status === "success" && (capped || !verified)
          ? "partial"
          : relay.status,
    })),
    capped,
  }
}

async function fetchEventMarketProductRequests(input: {
  collectionCoordinates: readonly string[]
  relayUrls: string[]
  signal?: AbortSignal
}): Promise<FetchEventsFanoutResult> {
  if (input.collectionCoordinates.length === 0) {
    return { events: [], relays: [], eventsVerified: true }
  }
  const fetch =
    eventMarketTestOverrides.fetchEventsFanoutDetailed ??
    fetchEventsFanoutDetailed
  const filter = {
    kinds: [EVENT_KINDS.PRODUCT],
    "#a": [...input.collectionCoordinates],
    limit: EVENT_MARKET_MAX_AUTHOR_EVENTS,
  } as NDKFilter
  return fetch(filter, {
    relayUrls: input.relayUrls,
    signal: input.signal,
    reuseRelayConnections: true,
  })
}

function chunkValues<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}

interface EventMarketFrontierFilterResult extends FetchEventsFanoutResult {
  remainingRelayUrls: string[]
  remainingRelayUrlsByAuthor: Map<string, string[]>
}

async function fetchEventMarketFrontierFilters(input: {
  filters: readonly NDKFilter[]
  relayUrls: string[]
  relayUrlsByAuthor?: ReadonlyMap<string, readonly string[]>
  signal?: AbortSignal
}): Promise<EventMarketFrontierFilterResult> {
  const filterAuthor = (filter: NDKFilter): string | null => {
    const authors = filter.authors ?? []
    return authors.length === 1 ? normalizePubkey(authors[0]) : null
  }
  const remainingRelayUrlsByAuthor = new Map<string, string[]>()
  for (const filter of input.filters) {
    const author = filterAuthor(filter)
    if (!author || remainingRelayUrlsByAuthor.has(author)) continue
    remainingRelayUrlsByAuthor.set(
      author,
      input.relayUrlsByAuthor?.has(author)
        ? mergeRelayUrls(input.relayUrlsByAuthor.get(author) ?? [])
        : [...input.relayUrls]
    )
  }
  if (input.filters.length === 0) {
    return {
      events: [],
      relays: [],
      eventsVerified: true,
      remainingRelayUrls: [...input.relayUrls],
      remainingRelayUrlsByAuthor,
    }
  }
  const fetch =
    eventMarketTestOverrides.fetchEventsFanoutDetailed ??
    fetchEventsFanoutDetailed
  const results: FetchEventsFanoutResult[] = []
  let remainingRelayUrls = [...input.relayUrls]
  for (
    let index = 0;
    index < input.filters.length;
    index += EVENT_MARKET_FRONTIER_QUERY_CONCURRENCY
  ) {
    const batch = input.filters.slice(
      index,
      index + EVENT_MARKET_FRONTIER_QUERY_CONCURRENCY
    )
    const batchPlans = batch.flatMap((filter) => {
      const author = filterAuthor(filter)
      const relayUrls = author
        ? (remainingRelayUrlsByAuthor.get(author) ?? [])
        : remainingRelayUrls
      return relayUrls.length > 0 ? [{ filter, author, relayUrls }] : []
    })
    if (batchPlans.length === 0) continue
    const batchResults = await Promise.all(
      batchPlans.map(({ filter, relayUrls }) =>
        fetch(filter, {
          relayUrls,
          signal: input.signal,
          reuseRelayConnections: true,
        })
      )
    )
    results.push(...batchResults)
    // Keep any verified events returned by an incomplete relay in this wave,
    // but do not pay another timeout for that relay in a later exact query.
    // A partial response is useful evidence, not proof that the next filter
    // will ever receive EOSE.
    const incompleteRelayUrls = new Set<string>()
    for (
      let resultIndex = 0;
      resultIndex < batchResults.length;
      resultIndex++
    ) {
      const result = batchResults[resultIndex]!
      for (const relay of result.relays) {
        if (relay.status !== "success") {
          incompleteRelayUrls.add(relay.relayUrl.toLowerCase())
        }
      }
    }
    for (const [author, relayUrls] of remainingRelayUrlsByAuthor) {
      remainingRelayUrlsByAuthor.set(
        author,
        relayUrls.filter(
          (relayUrl) => !incompleteRelayUrls.has(relayUrl.toLowerCase())
        )
      )
    }
    remainingRelayUrls = remainingRelayUrls.filter(
      (relayUrl) => !incompleteRelayUrls.has(relayUrl.toLowerCase())
    )
  }

  const eventsById = new Map<string, NDKEvent>()
  for (const result of results) {
    for (const event of result.events) {
      eventsById.set(event.id.toLowerCase(), event)
    }
  }
  return {
    events: Array.from(eventsById.values()),
    relays: mergeRelayReadStatuses(...results.map((result) => result.relays)),
    eventsVerified: results.every((result) => result.eventsVerified === true),
    remainingRelayUrls,
    remainingRelayUrlsByAuthor,
  }
}

async function fetchEventMarketOrganizerRecordFrontiers(input: {
  coordinates: readonly AddressableEventCoordinate[]
  relayUrls: string[]
  signal?: AbortSignal
}): Promise<FetchEventsFanoutResult> {
  if (input.coordinates.length === 0) {
    return { events: [], relays: [], eventsVerified: true }
  }
  const allowedCoordinates = new Set(
    input.coordinates.map((coordinate) => coordinate.coordinate)
  )
  const recordResult = await fetchEventMarketFrontierFilters({
    filters: input.coordinates.map((coordinate): NDKFilter => ({
      kinds: [coordinate.kind as never],
      authors: [coordinate.authorPubkey],
      "#d": [coordinate.dTag],
      limit: EVENT_MARKET_PARTICIPATION_REVISIONS_PER_TARGET_LIMIT,
    })),
    relayUrls: input.relayUrls,
    signal: input.signal,
  })
  const recordFrontiersByCoordinate = new Map<
    string,
    SignedPublicNostrEvent[]
  >()
  for (const event of rawSignedEvents(recordResult).events) {
    if (!isValidSignedPublicNostrEvent(event)) continue
    const coordinate = eventCoordinate(event, [event.kind])
    if (!coordinate || !allowedCoordinates.has(coordinate.coordinate)) continue
    const revisions =
      recordFrontiersByCoordinate.get(coordinate.coordinate) ?? []
    revisions.push(event)
    recordFrontiersByCoordinate.set(coordinate.coordinate, revisions)
  }
  const recordFrontiers = Array.from(
    recordFrontiersByCoordinate.values()
  ).flatMap((revisions) =>
    revisions
      .sort(compareAddressableEvents)
      .slice(0, EVENT_MARKET_PARTICIPATION_REVISIONS_PER_TARGET_LIMIT)
  )
  const frontierIds = new Set(
    recordFrontiers.map((event) => event.id.toLowerCase())
  )
  const boundedEvents = recordResult.events.filter((event) =>
    frontierIds.has(event.id.toLowerCase())
  )
  const deletionResult = await fetchEventMarketFrontierFilters({
    filters: [
      ...input.coordinates.map((coordinate): NDKFilter => ({
        kinds: [EVENT_KINDS.DELETION],
        authors: [coordinate.authorPubkey],
        "#a": [coordinate.coordinate],
        limit: EVENT_MARKET_MAX_AUTHOR_EVENTS,
      })),
      ...recordFrontiers.map((event): NDKFilter => ({
        kinds: [EVENT_KINDS.DELETION],
        authors: [event.pubkey],
        "#e": [event.id],
        limit: EVENT_MARKET_MAX_AUTHOR_EVENTS,
      })),
    ],
    relayUrls: recordResult.remainingRelayUrls,
    relayUrlsByAuthor: recordResult.remainingRelayUrlsByAuthor,
    signal: input.signal,
  })
  const eventsById = new Map<string, NDKEvent>()
  for (const event of [...boundedEvents, ...deletionResult.events]) {
    eventsById.set(event.id.toLowerCase(), event)
  }
  return {
    events: Array.from(eventsById.values()),
    relays: mergeRelayReadStatuses(recordResult.relays, deletionResult.relays),
    eventsVerified:
      recordResult.eventsVerified === true &&
      deletionResult.eventsVerified === true,
  }
}

function candidateProductCoordinates(input: {
  candidateEvents: readonly SignedPublicNostrEvent[]
  candidateCoordinates: readonly string[]
}): AddressableEventCoordinate[] {
  const coordinates = new Map<string, AddressableEventCoordinate>()
  for (const value of input.candidateCoordinates) {
    const coordinate = parseAddressableCoordinate(value, [EVENT_KINDS.PRODUCT])
    if (coordinate) coordinates.set(coordinate.coordinate, coordinate)
  }
  for (const event of input.candidateEvents) {
    if (
      event.kind !== EVENT_KINDS.PRODUCT ||
      !isValidSignedPublicNostrEvent(event)
    ) {
      continue
    }
    const coordinate = eventCoordinate(event, [EVENT_KINDS.PRODUCT])
    if (coordinate) coordinates.set(coordinate.coordinate, coordinate)
  }
  return Array.from(coordinates.values()).sort((left, right) =>
    left.coordinate.localeCompare(right.coordinate)
  )
}

async function eventMarketParticipantRelayPlans(input: {
  coordinates: readonly AddressableEventCoordinate[]
  candidateEvents: readonly SignedPublicNostrEvent[]
  sourceRelayUrlsById: ReadonlyMap<string, readonly string[]>
  fallbackRelayUrls: readonly string[]
  authenticatedPubkey?: string | null
  signal?: AbortSignal
}): Promise<Map<string, string[]>> {
  const authors = Array.from(
    new Set(input.coordinates.map((coordinate) => coordinate.authorPubkey))
  ).sort()
  const lookup = eventMarketTestOverrides.getRelayLists ?? getRelayLists
  const relayLists = await lookup(authors, {
    signal: input.signal,
    allowInsecureRelayUrlsForPubkey: input.authenticatedPubkey,
  })
  const observedRelaysByAuthor = new Map<string, string[]>()
  for (const event of input.candidateEvents) {
    const author = normalizePubkey(event.pubkey)
    if (!author || !authors.includes(author)) continue
    observedRelaysByAuthor.set(
      author,
      mergeRelayUrls(
        observedRelaysByAuthor.get(author) ?? [],
        input.sourceRelayUrlsById.get(event.id.toLowerCase()) ?? []
      )
    )
  }

  return new Map(
    authors.map((author) => {
      const plan = planRelayReads({
        intent: "author_products",
        authors: [author],
        relayLists,
        authenticatedPubkey: input.authenticatedPubkey,
        maxRelays: EVENT_MARKET_MAX_RELAY_HINTS,
      })
      return [
        author,
        mergeRelayUrls(
          plan.hintRelayUrls,
          observedRelaysByAuthor.get(author) ?? [],
          input.fallbackRelayUrls,
          plan.relayUrls
        ),
      ]
    })
  )
}

function productFrontierFilters(
  coordinates: readonly AddressableEventCoordinate[]
): NDKFilter[] {
  const dTagsByAuthor = new Map<string, Set<string>>()
  for (const coordinate of coordinates) {
    const dTags =
      dTagsByAuthor.get(coordinate.authorPubkey) ?? new Set<string>()
    dTags.add(coordinate.dTag)
    dTagsByAuthor.set(coordinate.authorPubkey, dTags)
  }
  return Array.from(dTagsByAuthor.entries()).flatMap(([author, dTags]) =>
    chunkValues(
      Array.from(dTags).sort(),
      EVENT_MARKET_FRONTIER_FILTER_BATCH_SIZE
    ).map((batch): NDKFilter => ({
      kinds: [EVENT_KINDS.PRODUCT],
      authors: [author],
      "#d": batch,
      limit: Math.min(EVENT_MARKET_MAX_AUTHOR_EVENTS, batch.length * 4),
    }))
  )
}

function boundedProductFrontierEvents(
  events: readonly SignedPublicNostrEvent[],
  coordinates: readonly AddressableEventCoordinate[]
): SignedPublicNostrEvent[] {
  const allowedCoordinates = new Set(
    coordinates.map((coordinate) => coordinate.coordinate)
  )
  const eventsByCoordinate = new Map<string, SignedPublicNostrEvent[]>()
  for (const event of events) {
    if (
      event.kind !== EVENT_KINDS.PRODUCT ||
      !isValidSignedPublicNostrEvent(event)
    ) {
      continue
    }
    const coordinate = eventCoordinate(event, [EVENT_KINDS.PRODUCT])
    if (!coordinate || !allowedCoordinates.has(coordinate.coordinate)) continue
    const revisions = eventsByCoordinate.get(coordinate.coordinate) ?? []
    revisions.push(event)
    eventsByCoordinate.set(coordinate.coordinate, revisions)
  }
  return Array.from(eventsByCoordinate.values()).flatMap((revisions) =>
    revisions
      .sort(compareAddressableEvents)
      .slice(0, EVENT_MARKET_PARTICIPATION_REVISIONS_PER_TARGET_LIMIT)
  )
}

function deletionFrontierFilters(input: {
  coordinates: readonly AddressableEventCoordinate[]
  frontierEvents: readonly SignedPublicNostrEvent[]
}): NDKFilter[] {
  const coordinatesByAuthor = new Map<string, Set<string>>()
  const eventIdsByAuthor = new Map<string, Set<string>>()
  for (const coordinate of input.coordinates) {
    const values =
      coordinatesByAuthor.get(coordinate.authorPubkey) ?? new Set<string>()
    values.add(coordinate.coordinate)
    coordinatesByAuthor.set(coordinate.authorPubkey, values)
  }
  for (const event of input.frontierEvents) {
    if (
      event.kind !== EVENT_KINDS.PRODUCT ||
      !isValidSignedPublicNostrEvent(event)
    ) {
      continue
    }
    const coordinate = eventCoordinate(event, [EVENT_KINDS.PRODUCT])
    if (!coordinate) continue
    const values = eventIdsByAuthor.get(coordinate.authorPubkey) ?? new Set()
    values.add(event.id.toLowerCase())
    eventIdsByAuthor.set(coordinate.authorPubkey, values)
  }

  const filters: NDKFilter[] = []
  for (const [author, values] of coordinatesByAuthor) {
    for (const coordinate of Array.from(values).sort()) {
      filters.push({
        kinds: [EVENT_KINDS.DELETION],
        authors: [author],
        "#a": [coordinate],
        limit: EVENT_MARKET_MAX_AUTHOR_EVENTS,
      } as NDKFilter)
    }
  }
  for (const [author, values] of eventIdsByAuthor) {
    for (const eventId of Array.from(values).sort()) {
      filters.push({
        kinds: [EVENT_KINDS.DELETION],
        authors: [author],
        "#e": [eventId],
        limit: EVENT_MARKET_MAX_AUTHOR_EVENTS,
      } as NDKFilter)
    }
  }
  return filters
}

interface EventMarketProductRequestFrontierResult extends FetchEventsFanoutResult {
  participationBudget: EventMarketParticipationBudget
}

interface EventMarketPickupFrontierResult extends FetchEventsFanoutResult {
  pickupBudget: EventMarketParticipationBudget
}

function collectionCalendarCoordinatesFromEvidence(input: {
  events: readonly SignedPublicNostrEvent[]
  collectionCoordinates: readonly string[]
}): AddressableEventCoordinate[] {
  const deletions = validDeletionEvents(input.events)
  const coordinates = new Map<string, AddressableEventCoordinate>()
  for (const reference of input.collectionCoordinates) {
    const collectionCoordinate = decodeEventMarketReference(reference, [
      EVENT_KINDS.PRODUCT_COLLECTION,
    ])
    if (!collectionCoordinate) continue
    const collection = resolveAddressableRecord({
      coordinate: collectionCoordinate,
      events: input.events,
      deletions,
      parse: parseEventMarketCollectionEvent,
    })
    if (collection.state !== "current") continue
    for (const value of collection.value.eventCoordinates) {
      const coordinate = parseAddressableCoordinate(value, [
        EVENT_KINDS.CALENDAR_DATE,
        EVENT_KINDS.CALENDAR_TIME,
      ])
      if (coordinate) coordinates.set(coordinate.coordinate, coordinate)
    }
  }
  return Array.from(coordinates.values()).sort((left, right) =>
    left.coordinate.localeCompare(right.coordinate)
  )
}

function collectionPickupCoordinatesFromEvidence(input: {
  events: readonly SignedPublicNostrEvent[]
  collectionCoordinates: readonly string[]
}): AddressableEventCoordinate[] {
  const deletions = validDeletionEvents(input.events)
  const coordinates = new Map<string, AddressableEventCoordinate>()
  for (const reference of input.collectionCoordinates) {
    const collectionCoordinate = decodeEventMarketReference(reference, [
      EVENT_KINDS.PRODUCT_COLLECTION,
    ])
    if (!collectionCoordinate) continue
    const collection = resolveAddressableRecord({
      coordinate: collectionCoordinate,
      events: input.events,
      deletions,
      parse: parseEventMarketCollectionEvent,
    })
    if (collection.state !== "current") continue
    for (const value of collection.value.pickupCoordinates) {
      const coordinate = parseAddressableCoordinate(value, [
        EVENT_KINDS.SHIPPING_OPTION,
      ])
      if (coordinate) coordinates.set(coordinate.coordinate, coordinate)
    }
  }
  return Array.from(coordinates.values()).sort((left, right) =>
    left.coordinate.localeCompare(right.coordinate)
  )
}

function pickupFrontierFilters(
  coordinates: readonly AddressableEventCoordinate[]
): NDKFilter[] {
  const dTagsByAuthor = new Map<string, Set<string>>()
  for (const coordinate of coordinates) {
    const dTags =
      dTagsByAuthor.get(coordinate.authorPubkey) ?? new Set<string>()
    dTags.add(coordinate.dTag)
    dTagsByAuthor.set(coordinate.authorPubkey, dTags)
  }
  return Array.from(dTagsByAuthor.entries()).flatMap(([author, dTags]) =>
    chunkValues(
      Array.from(dTags).sort(),
      EVENT_MARKET_FRONTIER_FILTER_BATCH_SIZE
    ).map((batch): NDKFilter => ({
      kinds: [EVENT_KINDS.SHIPPING_OPTION as never],
      authors: [author],
      "#d": batch,
      limit: Math.min(EVENT_MARKET_MAX_AUTHOR_EVENTS, batch.length * 4),
    }))
  )
}

function boundedPickupFrontierEvents(
  events: readonly SignedPublicNostrEvent[],
  coordinates: readonly AddressableEventCoordinate[]
): SignedPublicNostrEvent[] {
  const allowed = new Set(
    coordinates.map((coordinate) => coordinate.coordinate)
  )
  const byCoordinate = new Map<string, SignedPublicNostrEvent[]>()
  for (const event of events) {
    if (
      event.kind !== EVENT_KINDS.SHIPPING_OPTION ||
      !isValidSignedPublicNostrEvent(event)
    ) {
      continue
    }
    const coordinate = eventCoordinate(event, [EVENT_KINDS.SHIPPING_OPTION])
    if (!coordinate || !allowed.has(coordinate.coordinate)) continue
    const revisions = byCoordinate.get(coordinate.coordinate) ?? []
    revisions.push(event)
    byCoordinate.set(coordinate.coordinate, revisions)
  }
  return Array.from(byCoordinate.values()).flatMap((revisions) =>
    revisions
      .sort(compareAddressableEvents)
      .slice(0, EVENT_MARKET_PARTICIPATION_REVISIONS_PER_TARGET_LIMIT)
  )
}

function pickupDeletionFrontierFilters(input: {
  coordinates: readonly AddressableEventCoordinate[]
  frontierEvents: readonly SignedPublicNostrEvent[]
}): NDKFilter[] {
  const filters: NDKFilter[] = []
  for (const coordinate of input.coordinates) {
    filters.push({
      kinds: [EVENT_KINDS.DELETION],
      authors: [coordinate.authorPubkey],
      "#a": [coordinate.coordinate],
      limit: EVENT_MARKET_MAX_AUTHOR_EVENTS,
    } as NDKFilter)
  }
  for (const event of input.frontierEvents) {
    filters.push({
      kinds: [EVENT_KINDS.DELETION],
      authors: [event.pubkey],
      "#e": [event.id],
      limit: EVENT_MARKET_MAX_AUTHOR_EVENTS,
    } as NDKFilter)
  }
  return filters
}

async function fetchEventMarketPickupFrontiers(input: {
  coordinates: readonly AddressableEventCoordinate[]
  candidateEvents: readonly SignedPublicNostrEvent[]
  candidateSourceRelayUrlsById: ReadonlyMap<string, readonly string[]>
  relayUrls: string[]
  authenticatedPubkey?: string | null
  signal?: AbortSignal
}): Promise<EventMarketPickupFrontierResult> {
  const pickupBudget: EventMarketParticipationBudget = {
    state:
      input.coordinates.length >
      EVENT_MARKET_PARTICIPATION_FRONTIER_TARGET_LIMIT
        ? "exceeded"
        : "within_budget",
    targetCount: input.coordinates.length,
    targetLimit: EVENT_MARKET_PARTICIPATION_FRONTIER_TARGET_LIMIT,
  }
  if (pickupBudget.state === "exceeded" || input.coordinates.length === 0) {
    return { events: [], relays: [], eventsVerified: true, pickupBudget }
  }
  const relayUrlsByAuthor = await eventMarketParticipantRelayPlans({
    coordinates: input.coordinates,
    candidateEvents: input.candidateEvents,
    sourceRelayUrlsById: input.candidateSourceRelayUrlsById,
    fallbackRelayUrls: input.relayUrls,
    authenticatedPubkey: input.authenticatedPubkey,
    signal: input.signal,
  })
  const pickupResult = await fetchEventMarketFrontierFilters({
    filters: pickupFrontierFilters(input.coordinates),
    relayUrls: input.relayUrls,
    relayUrlsByAuthor,
    signal: input.signal,
  })
  const pickupFrontiers = boundedPickupFrontierEvents(
    rawSignedEvents(pickupResult).events,
    input.coordinates
  )
  const frontierIds = new Set(
    pickupFrontiers.map((event) => event.id.toLowerCase())
  )
  const boundedEvents = pickupResult.events.filter((event) =>
    frontierIds.has(event.id.toLowerCase())
  )
  const deletionResult = await fetchEventMarketFrontierFilters({
    filters: pickupDeletionFrontierFilters({
      coordinates: input.coordinates,
      frontierEvents: pickupFrontiers,
    }),
    relayUrls: pickupResult.remainingRelayUrls,
    relayUrlsByAuthor: pickupResult.remainingRelayUrlsByAuthor,
    signal: input.signal,
  })
  const eventsById = new Map<string, NDKEvent>()
  for (const event of [...boundedEvents, ...deletionResult.events]) {
    eventsById.set(event.id.toLowerCase(), event)
  }
  return {
    events: Array.from(eventsById.values()),
    relays: mergeRelayReadStatuses(pickupResult.relays, deletionResult.relays),
    eventsVerified:
      pickupResult.eventsVerified === true &&
      deletionResult.eventsVerified === true,
    pickupBudget,
  }
}

async function fetchEventMarketProductRequestFrontiers(input: {
  candidateEvents: readonly SignedPublicNostrEvent[]
  candidateCoordinates: readonly string[]
  candidateSourceRelayUrlsById: ReadonlyMap<string, readonly string[]>
  relayUrls: string[]
  authenticatedPubkey?: string | null
  signal?: AbortSignal
}): Promise<EventMarketProductRequestFrontierResult> {
  const coordinates = candidateProductCoordinates(input)
  const participationBudget: EventMarketParticipationBudget = {
    state:
      coordinates.length > EVENT_MARKET_PARTICIPATION_FRONTIER_TARGET_LIMIT
        ? "exceeded"
        : "within_budget",
    targetCount: coordinates.length,
    targetLimit: EVENT_MARKET_PARTICIPATION_FRONTIER_TARGET_LIMIT,
  }
  if (participationBudget.state === "exceeded") {
    return {
      events: [],
      relays: [],
      eventsVerified: true,
      participationBudget,
    }
  }
  if (coordinates.length === 0) {
    return {
      events: [],
      relays: [],
      eventsVerified: true,
      participationBudget,
    }
  }
  const relayUrlsByAuthor = await eventMarketParticipantRelayPlans({
    coordinates,
    candidateEvents: input.candidateEvents,
    sourceRelayUrlsById: input.candidateSourceRelayUrlsById,
    fallbackRelayUrls: input.relayUrls,
    authenticatedPubkey: input.authenticatedPubkey,
    signal: input.signal,
  })
  const productResult = await fetchEventMarketFrontierFilters({
    filters: productFrontierFilters(coordinates),
    relayUrls: input.relayUrls,
    relayUrlsByAuthor,
    signal: input.signal,
  })
  const productFrontiers = boundedProductFrontierEvents(
    rawSignedEvents(productResult).events,
    coordinates
  )
  const productFrontierIds = new Set(
    productFrontiers.map((event) => event.id.toLowerCase())
  )
  const boundedProductEvents = productResult.events.filter((event) =>
    productFrontierIds.has(event.id.toLowerCase())
  )
  const deletionResult = await fetchEventMarketFrontierFilters({
    filters: deletionFrontierFilters({
      coordinates,
      frontierEvents: productFrontiers,
    }),
    relayUrls: productResult.remainingRelayUrls,
    relayUrlsByAuthor: productResult.remainingRelayUrlsByAuthor,
    signal: input.signal,
  })
  const eventsById = new Map<string, NDKEvent>()
  for (const event of [...boundedProductEvents, ...deletionResult.events]) {
    eventsById.set(event.id.toLowerCase(), event)
  }
  return {
    events: Array.from(eventsById.values()),
    relays: mergeRelayReadStatuses(productResult.relays, deletionResult.relays),
    eventsVerified:
      productResult.eventsVerified === true &&
      deletionResult.eventsVerified === true,
    participationBudget,
  }
}

function rawSignedEvents(result: FetchEventsFanoutResult): {
  events: SignedPublicNostrEvent[]
  sourceRelayUrlsById: Map<string, string[]>
} {
  const events: SignedPublicNostrEvent[] = []
  const sourceRelayUrlsById = new Map<string, string[]>()
  for (const event of result.events) {
    const raw = event.rawEvent() as SignedPublicNostrEvent
    events.push(raw)
    sourceRelayUrlsById.set(
      raw.id.toLowerCase(),
      getEventSourceRelayUrls(event)
    )
  }
  return { events, sourceRelayUrlsById }
}

function mergeRawSignedEventGroups(
  ...groups: ReadonlyArray<ReturnType<typeof rawSignedEvents>>
): ReturnType<typeof rawSignedEvents> {
  const events = new Map<string, SignedPublicNostrEvent>()
  const sourceRelayUrlsById = new Map<string, string[]>()
  for (const group of groups) {
    for (const event of group.events) {
      const id = event.id.toLowerCase()
      events.set(id, event)
      sourceRelayUrlsById.set(
        id,
        mergeRelayUrls(
          sourceRelayUrlsById.get(id) ?? [],
          group.sourceRelayUrlsById.get(id) ?? []
        )
      )
    }
  }
  return { events: Array.from(events.values()), sourceRelayUrlsById }
}

function cacheableEventMarketAddressId(
  event: SignedPublicNostrEvent
): string | undefined {
  if (!EVENT_MARKET_ADDRESSABLE_KINDS.includes(event.kind as never)) {
    return undefined
  }
  return eventCoordinate(event, [event.kind])?.coordinate
}

function deletionTargetsParticipantEvidence(input: {
  deletion: SignedPublicNostrEvent
  participantCoordinates: ReadonlySet<string>
  participantEventIds: ReadonlySet<string>
}): boolean {
  const author = input.deletion.pubkey.toLowerCase()
  return input.deletion.tags.some((tag) => {
    if (tag[0] === "a" && tag[1]) {
      const coordinate = parseAddressableCoordinate(tag[1], [
        EVENT_KINDS.PRODUCT,
      ])
      return (
        coordinate?.authorPubkey === author &&
        input.participantCoordinates.has(coordinate.coordinate)
      )
    }
    return (
      tag[0] === "e" &&
      typeof tag[1] === "string" &&
      input.participantEventIds.has(`${author}:${tag[1].toLowerCase()}`)
    )
  })
}

function deletionTargetsScopedEventMarketEvidence(input: {
  deletion: SignedPublicNostrEvent
  participantCoordinates: ReadonlySet<string>
  participantEventIds: ReadonlySet<string>
}): boolean {
  const author = input.deletion.pubkey.toLowerCase()
  return input.deletion.tags.some((tag) => {
    if (tag[0] === "a" && tag[1]) {
      const coordinate = parseAddressableCoordinate(tag[1], [
        EVENT_KINDS.PRODUCT,
        EVENT_KINDS.SHIPPING_OPTION,
      ])
      return (
        coordinate?.authorPubkey === author &&
        input.participantCoordinates.has(coordinate.coordinate)
      )
    }
    return (
      tag[0] === "e" &&
      typeof tag[1] === "string" &&
      input.participantEventIds.has(`${author}:${tag[1].toLowerCase()}`)
    )
  })
}

function scopedCacheableEventMarketEvents(input: {
  organizerPubkey: string
  events: readonly SignedPublicNostrEvent[]
  participantCoordinates?: readonly string[]
  participantPickupCoordinates?: readonly string[]
}): SignedPublicNostrEvent[] {
  const participantCoordinates = new Set(
    (input.participantCoordinates ?? []).flatMap((value) => {
      const parsed = parseAddressableCoordinate(value, [EVENT_KINDS.PRODUCT])
      return parsed ? [parsed.coordinate] : []
    })
  )
  const participantPickupCoordinates = new Set(
    (input.participantPickupCoordinates ?? []).flatMap((value) => {
      const parsed = parseAddressableCoordinate(value, [
        EVENT_KINDS.SHIPPING_OPTION,
      ])
      return parsed ? [parsed.coordinate] : []
    })
  )
  const scopedParticipantCoordinates = new Set([
    ...participantCoordinates,
    ...participantPickupCoordinates,
  ])
  const participantEventIds = new Set(
    input.events.flatMap((event) => {
      const coordinate = eventCoordinate(event, [
        EVENT_KINDS.PRODUCT,
        EVENT_KINDS.SHIPPING_OPTION,
      ])
      return coordinate &&
        scopedParticipantCoordinates.has(coordinate.coordinate)
        ? [`${coordinate.authorPubkey}:${event.id.toLowerCase()}`]
        : []
    })
  )

  return input.events.filter((event) => {
    if (!isValidSignedPublicNostrEvent(event)) return false
    const author = event.pubkey.toLowerCase()
    if (author === input.organizerPubkey) {
      if (event.kind === EVENT_KINDS.PRODUCT) {
        const coordinate = eventCoordinate(event, [EVENT_KINDS.PRODUCT])
        return Boolean(
          coordinate && participantCoordinates.has(coordinate.coordinate)
        )
      }
      return (
        event.kind === EVENT_KINDS.DELETION ||
        EVENT_MARKET_ADDRESSABLE_KINDS.includes(event.kind as never)
      )
    }
    if (event.kind === EVENT_KINDS.PRODUCT) {
      const coordinate = eventCoordinate(event, [EVENT_KINDS.PRODUCT])
      return Boolean(
        coordinate && participantCoordinates.has(coordinate.coordinate)
      )
    }
    if (event.kind === EVENT_KINDS.SHIPPING_OPTION) {
      const coordinate = eventCoordinate(event, [EVENT_KINDS.SHIPPING_OPTION])
      return Boolean(
        coordinate && participantPickupCoordinates.has(coordinate.coordinate)
      )
    }
    return (
      event.kind === EVENT_KINDS.DELETION &&
      deletionTargetsScopedEventMarketEvidence({
        deletion: event,
        participantCoordinates: scopedParticipantCoordinates,
        participantEventIds,
      })
    )
  })
}

async function loadCachedEventMarketEvidence(
  organizerPubkey: string
): Promise<CachedEventMarketEvidence[]> {
  if (eventMarketTestOverrides.loadCachedEvidence) {
    return eventMarketTestOverrides.loadCachedEvidence(organizerPubkey)
  }
  try {
    const rows = await db.eventMarketEvidence
      .where("organizerPubkey")
      .equals(organizerPubkey)
      .toArray()
    return rows.filter((row) => {
      const event = row.signedEvent
      if (
        row.organizerPubkey !== organizerPubkey ||
        row.kind !== event.kind ||
        !isValidSignedPublicNostrEvent(event)
      ) {
        return false
      }
      const author = event.pubkey.toLowerCase()
      return author === organizerPubkey
        ? event.kind === EVENT_KINDS.DELETION ||
            EVENT_MARKET_ADDRESSABLE_KINDS.includes(event.kind as never)
        : event.kind === EVENT_KINDS.PRODUCT ||
            event.kind === EVENT_KINDS.SHIPPING_OPTION ||
            event.kind === EVENT_KINDS.DELETION
    })
  } catch {
    return []
  }
}

async function persistEventMarketEvidence(input: {
  organizerPubkey: string
  events: readonly SignedPublicNostrEvent[]
  sourceRelayUrlsById: ReadonlyMap<string, string[]>
  participantCoordinates?: readonly string[]
  participantPickupCoordinates?: readonly string[]
  cachedAt?: number
}): Promise<void> {
  const scopedEvents = scopedCacheableEventMarketEvents(input)
  if (eventMarketTestOverrides.persistCachedEvidence) {
    await eventMarketTestOverrides.persistCachedEvidence({
      ...input,
      events: scopedEvents,
    })
    return
  }
  const cachedAt = input.cachedAt ?? Date.now()
  const rows = scopedEvents.flatMap((event): CachedEventMarketEvidence[] => {
    const participant = event.pubkey.toLowerCase() !== input.organizerPubkey
    return [
      {
        id: participant
          ? `${input.organizerPubkey}:${event.id.toLowerCase()}`
          : event.id.toLowerCase(),
        organizerPubkey: input.organizerPubkey,
        kind: event.kind,
        addressId: cacheableEventMarketAddressId(event),
        signedEvent: {
          ...event,
          tags: event.tags.map((tag) => [...tag]),
        },
        sourceRelayUrls:
          input.sourceRelayUrlsById.get(event.id.toLowerCase()) ?? [],
        cachedAt,
      },
    ]
  })
  if (rows.length === 0) return
  try {
    await db.transaction("rw", db.eventMarketEvidence, async () => {
      const existing = await db.eventMarketEvidence.bulkGet(
        rows.map((row) => row.id)
      )
      await db.eventMarketEvidence.bulkPut(
        rows.map((row, index) => ({
          ...row,
          sourceRelayUrls: mergeRelayUrls(
            existing[index]?.sourceRelayUrls ?? [],
            row.sourceRelayUrls
          ),
        }))
      )
      const organizerRows = await db.eventMarketEvidence
        .where("organizerPubkey")
        .equals(input.organizerPubkey)
        .toArray()
      if (
        organizerRows.length <= EVENT_MARKET_MAX_CACHED_EVIDENCE_PER_ORGANIZER
      ) {
        return
      }
      const keep = new Set(
        organizerRows
          .sort((left, right) => {
            const leftDeletion = left.kind === EVENT_KINDS.DELETION ? 1 : 0
            const rightDeletion = right.kind === EVENT_KINDS.DELETION ? 1 : 0
            if (leftDeletion !== rightDeletion) {
              return rightDeletion - leftDeletion
            }
            return right.cachedAt - left.cachedAt
          })
          .slice(0, EVENT_MARKET_MAX_CACHED_EVIDENCE_PER_ORGANIZER)
          .map((row) => row.id)
      )
      await db.eventMarketEvidence.bulkDelete(
        organizerRows.filter((row) => !keep.has(row.id)).map((row) => row.id)
      )
    })
  } catch {
    // Cache persistence is best-effort; live signed evidence remains usable.
  }
}

function mergeCachedAndLiveEvidence(input: {
  cached: readonly CachedEventMarketEvidence[]
  live: ReturnType<typeof rawSignedEvents>
}): {
  events: SignedPublicNostrEvent[]
  sourceRelayUrlsById: Map<string, string[]>
  cachedObservedAt?: number
  liveEventIds: Set<string>
} {
  const eventsById = new Map<string, SignedPublicNostrEvent>()
  const sourceRelayUrlsById = new Map<string, string[]>()
  let cachedObservedAt: number | undefined
  for (const row of input.cached) {
    const id = row.signedEvent.id.toLowerCase()
    eventsById.set(id, row.signedEvent)
    sourceRelayUrlsById.set(id, [...row.sourceRelayUrls])
    cachedObservedAt = Math.max(cachedObservedAt ?? 0, row.cachedAt)
  }
  const liveEventIds = new Set<string>()
  for (const event of input.live.events) {
    const id = event.id.toLowerCase()
    liveEventIds.add(id)
    eventsById.set(id, event)
    sourceRelayUrlsById.set(
      id,
      mergeRelayUrls(
        sourceRelayUrlsById.get(id) ?? [],
        input.live.sourceRelayUrlsById.get(id) ?? []
      )
    )
  }
  return {
    events: Array.from(eventsById.values()),
    sourceRelayUrlsById,
    cachedObservedAt,
    liveEventIds,
  }
}

function participationEvidenceForCollection(input: {
  reference: string
  candidateCoordinates: readonly string[]
  cached: readonly CachedEventMarketEvidence[]
  live: readonly SignedPublicNostrEvent[]
}): SignedPublicNostrEvent[] {
  const participantCoordinates = new Set(
    input.candidateCoordinates.flatMap((value) => {
      const parsed = parseAddressableCoordinate(value, [EVENT_KINDS.PRODUCT])
      return parsed ? [parsed.coordinate] : []
    })
  )
  const cachedProducts = input.cached.flatMap((row) => {
    const event = row.signedEvent
    const coordinate = eventCoordinate(event, [EVENT_KINDS.PRODUCT])
    return coordinate && participantCoordinates.has(coordinate.coordinate)
      ? [event]
      : []
  })
  const participantEventIds = new Set(
    [...cachedProducts, ...input.live].flatMap((event) => {
      const coordinate = eventCoordinate(event, [EVENT_KINDS.PRODUCT])
      return coordinate && participantCoordinates.has(coordinate.coordinate)
        ? [`${coordinate.authorPubkey}:${event.id.toLowerCase()}`]
        : []
    })
  )
  const retainedNegativeEvidence = input.cached.flatMap((row) => {
    const event = row.signedEvent
    if (event.kind === EVENT_KINDS.PRODUCT) {
      const coordinate = eventCoordinate(event, [EVENT_KINDS.PRODUCT])
      if (
        !coordinate ||
        !participantCoordinates.has(coordinate.coordinate) ||
        event.tags.some((tag) => tag[0] === "a" && tag[1] === input.reference)
      ) {
        return []
      }
      // A retained newer revision that no longer requests this collection is
      // negative evidence. A cached positive request is never authorization.
      return [event]
    }
    return event.kind === EVENT_KINDS.DELETION &&
      deletionTargetsParticipantEvidence({
        deletion: event,
        participantCoordinates,
        participantEventIds,
      })
      ? [event]
      : []
  })
  const eventsById = new Map<string, SignedPublicNostrEvent>()
  for (const event of [...retainedNegativeEvidence, ...input.live]) {
    eventsById.set(event.id.toLowerCase(), event)
  }
  return Array.from(eventsById.values())
}

function downgradeCachedOnlyResolution(
  resolution: EventMarketResolution,
  liveEventIds: ReadonlySet<string>
): EventMarketResolution {
  if (
    resolution.state !== "active" &&
    resolution.state !== "ended" &&
    resolution.state !== "partial"
  ) {
    return resolution
  }
  const requiredIds = [
    resolution.collection?.eventId,
    resolution.calendar?.eventId,
    ...resolution.pickups.map((pickup) => pickup.eventId),
  ].filter((value): value is string => Boolean(value))
  const allRequiredEvidenceIsLive =
    requiredIds.length === 2 + resolution.pickups.length &&
    requiredIds.every((eventId) => liveEventIds.has(eventId.toLowerCase()))
  return allRequiredEvidenceIsLive
    ? resolution
    : { ...resolution, state: "stale" }
}

function addResolutionSources(
  resolution: EventMarketResolution,
  sourceRelayUrlsById: ReadonlyMap<string, string[]>
): EventMarketResolution {
  return {
    ...resolution,
    ...(resolution.collection
      ? {
          collection: parsedWithSources(
            resolution.collection,
            sourceRelayUrlsById
          ),
        }
      : {}),
    ...(resolution.calendar
      ? {
          calendar: parsedWithSources(resolution.calendar, sourceRelayUrlsById),
        }
      : {}),
    ...(resolution.pickup
      ? {
          pickup: parsedWithSources(resolution.pickup, sourceRelayUrlsById),
        }
      : {}),
    pickups: resolution.pickups.map((pickup) =>
      parsedWithSources(pickup, sourceRelayUrlsById)
    ),
  }
}

function organizerProductCoordinatesFromEvidence(
  events: readonly SignedPublicNostrEvent[],
  collectionCoordinates: readonly string[]
): string[] {
  const deletions = validDeletionEvents(events)
  const products = new Set<string>()
  for (const reference of collectionCoordinates) {
    const coordinate = decodeEventMarketReference(reference, [
      EVENT_KINDS.PRODUCT_COLLECTION,
    ])
    if (!coordinate) continue
    const collection = resolveAddressableRecord({
      coordinate,
      events,
      deletions,
      parse: parseEventMarketCollectionEvent,
    })
    if (collection.state !== "current") continue
    for (const productCoordinate of collection.value.productCoordinates) {
      products.add(productCoordinate)
    }
  }
  return Array.from(products).sort()
}

export async function getEventMarket(
  input: GetEventMarketInput
): Promise<EventMarketResolution> {
  const decoded = decodeEventMarketReference(input.reference, [
    EVENT_KINDS.PRODUCT_COLLECTION,
  ])
  if (!decoded) return emptyResolution(input.reference, "malformed")
  const expectedOrganizer = input.expectedOrganizerPubkey
    ? normalizePubkey(input.expectedOrganizerPubkey)
    : null
  if (
    input.expectedOrganizerPubkey &&
    (!expectedOrganizer || expectedOrganizer !== decoded.authorPubkey)
  ) {
    return {
      ...emptyResolution(decoded.coordinate, "unsupported"),
      organizerPubkey: decoded.authorPubkey,
      collectionCoordinate: decoded.coordinate,
    }
  }

  const relayUrls = (
    await eventMarketReadPlanDetailed({
      organizerPubkey: decoded.authorPubkey,
      relayHints: decoded.relayHints,
      authenticatedPubkey: input.authenticatedPubkey,
      signal: input.signal,
    })
  ).relayUrls
  const observedAt = input.nowMs ?? Date.now()
  const [recordResult, cachedRecords] = await Promise.all([
    fetchEventMarketRecords({
      organizerPubkey: decoded.authorPubkey,
      relayUrls,
      signal: input.signal,
    }),
    loadCachedEventMarketEvidence(decoded.authorPubkey),
  ])
  const broadLiveRecords = rawSignedEvents(recordResult)
  const authorReadReachedCap = eventMarketAuthorReadReachedCap(recordResult)
  const collectionFrontierResult = authorReadReachedCap
    ? await fetchEventMarketOrganizerRecordFrontiers({
        coordinates: [decoded],
        relayUrls: relayUrlsWithoutObservedFailures(
          relayUrls,
          recordResult.relays
        ),
        signal: input.signal,
      })
    : { events: [], relays: [], eventsVerified: true }
  const rawCollectionFrontiers = rawSignedEvents(collectionFrontierResult)
  const preliminaryOrganizerRecords = mergeCachedAndLiveEvidence({
    cached: cachedRecords,
    live: mergeRawSignedEventGroups(broadLiveRecords, rawCollectionFrontiers),
  })
  const calendarCoordinates = collectionCalendarCoordinatesFromEvidence({
    events: preliminaryOrganizerRecords.events,
    collectionCoordinates: [decoded.coordinate],
  })
  const calendarFrontierResult = authorReadReachedCap
    ? await fetchEventMarketOrganizerRecordFrontiers({
        coordinates: calendarCoordinates,
        relayUrls: relayUrlsWithoutObservedFailures(
          relayUrls,
          recordResult.relays,
          collectionFrontierResult.relays
        ),
        signal: input.signal,
      })
    : { events: [], relays: [], eventsVerified: true }
  const rawCalendarFrontiers = rawSignedEvents(calendarFrontierResult)
  const liveRecords = mergeRawSignedEventGroups(
    broadLiveRecords,
    rawCollectionFrontiers,
    rawCalendarFrontiers
  )
  const organizerRecordRelays = mergeRelayReadStatuses(
    recordResult.relays,
    collectionFrontierResult.relays,
    calendarFrontierResult.relays
  )
  await persistEventMarketEvidence({
    organizerPubkey: decoded.authorPubkey,
    events: liveRecords.events,
    sourceRelayUrlsById: liveRecords.sourceRelayUrlsById,
    cachedAt: observedAt,
  })
  const organizerRecords = mergeCachedAndLiveEvidence({
    cached: cachedRecords,
    live: liveRecords,
  })
  const organizerPickupCoordinates = collectionPickupCoordinatesFromEvidence({
    events: organizerRecords.events,
    collectionCoordinates: [decoded.coordinate],
  })
  const [requestResult, organizerPickupResult] = await Promise.all([
    fetchEventMarketProductRequests({
      collectionCoordinates: [decoded.coordinate],
      relayUrls: relayUrlsWithoutObservedFailures(
        relayUrls,
        organizerRecordRelays
      ),
      signal: input.signal,
    }),
    fetchEventMarketPickupFrontiers({
      coordinates: organizerPickupCoordinates,
      candidateEvents: organizerRecords.events,
      candidateSourceRelayUrlsById: organizerRecords.sourceRelayUrlsById,
      relayUrls: relayUrlsWithoutObservedFailures(
        relayUrls,
        organizerRecordRelays
      ),
      authenticatedPubkey: input.authenticatedPubkey,
      signal: input.signal,
    }),
  ])
  const rawOrganizerPickupFrontiers = rawSignedEvents(organizerPickupResult)
  const rawRequestCandidates = rawSignedEvents(requestResult)
  const organizerProductCoordinates = organizerProductCoordinatesFromEvidence(
    organizerRecords.events,
    [decoded.coordinate]
  )
  const requestFrontierResult = await fetchEventMarketProductRequestFrontiers({
    candidateEvents: rawRequestCandidates.events,
    candidateCoordinates: organizerProductCoordinates,
    candidateSourceRelayUrlsById: rawRequestCandidates.sourceRelayUrlsById,
    relayUrls: relayUrlsWithoutObservedFailures(
      relayUrls,
      organizerRecordRelays,
      requestResult.relays
    ),
    authenticatedPubkey: input.authenticatedPubkey,
    signal: input.signal,
  })
  const rawRequestFrontiers = rawSignedEvents(requestFrontierResult)
  const participantCoordinates =
    requestFrontierResult.participationBudget.state === "within_budget"
      ? candidateProductCoordinates({
          candidateEvents: rawRequestCandidates.events,
          candidateCoordinates: organizerProductCoordinates,
        }).map((coordinate) => coordinate.coordinate)
      : []
  const productRequestEvents = participationEvidenceForCollection({
    reference: decoded.coordinate,
    candidateCoordinates: participantCoordinates,
    cached: cachedRecords,
    live: rawRequestFrontiers.events,
  })
  const directMerchantPickupCoordinates =
    requestFrontierResult.participationBudget.state === "within_budget"
      ? directMerchantPickupCoordinatesFromProductEvidence({
          events: productRequestEvents,
          collectionCoordinate: decoded.coordinate,
          organizerProducts: organizerProductCoordinates,
          organizerPubkey: decoded.authorPubkey,
        })
      : []
  const pickupCoordinatesByIdentity = new Map(
    [...organizerPickupCoordinates, ...directMerchantPickupCoordinates].map(
      (coordinate) => [coordinate.coordinate, coordinate]
    )
  )
  const pickupCoordinates = Array.from(pickupCoordinatesByIdentity.values())
  const pickupBudget: EventMarketParticipationBudget = {
    state:
      pickupCoordinates.length >
      EVENT_MARKET_PARTICIPATION_FRONTIER_TARGET_LIMIT
        ? "exceeded"
        : "within_budget",
    targetCount: pickupCoordinates.length,
    targetLimit: EVENT_MARKET_PARTICIPATION_FRONTIER_TARGET_LIMIT,
  }
  const requestEvidence = mergeRawSignedEventGroups(
    rawRequestCandidates,
    rawRequestFrontiers
  )
  const directPickupResult =
    pickupBudget.state === "exceeded"
      ? {
          events: [],
          relays: [],
          eventsVerified: true,
          pickupBudget,
        }
      : await fetchEventMarketPickupFrontiers({
          coordinates: directMerchantPickupCoordinates,
          candidateEvents: requestEvidence.events,
          candidateSourceRelayUrlsById: requestEvidence.sourceRelayUrlsById,
          relayUrls: relayUrlsWithoutObservedFailures(
            relayUrls,
            organizerRecordRelays,
            requestResult.relays,
            requestFrontierResult.relays
          ),
          authenticatedPubkey: input.authenticatedPubkey,
          signal: input.signal,
        })
  const rawDirectPickupFrontiers = rawSignedEvents(directPickupResult)
  const rawPickupFrontiers = mergeRawSignedEventGroups(
    rawOrganizerPickupFrontiers,
    rawDirectPickupFrontiers
  )
  const records = mergeCachedAndLiveEvidence({
    cached: cachedRecords,
    live: mergeRawSignedEventGroups(liveRecords, rawPickupFrontiers),
  })
  await persistEventMarketEvidence({
    organizerPubkey: decoded.authorPubkey,
    events: rawRequestFrontiers.events,
    sourceRelayUrlsById: rawRequestFrontiers.sourceRelayUrlsById,
    participantCoordinates,
    cachedAt: observedAt,
  })
  await persistEventMarketEvidence({
    organizerPubkey: decoded.authorPubkey,
    events: rawPickupFrontiers.events,
    sourceRelayUrlsById: rawPickupFrontiers.sourceRelayUrlsById,
    participantPickupCoordinates: pickupCoordinates.map(
      (coordinate) => coordinate.coordinate
    ),
    cachedAt: observedAt,
  })
  const resolution = resolveEventMarketEvidence({
    reference: decoded.coordinate,
    events: records.events,
    productRequestEvents,
    participationBudget: requestFrontierResult.participationBudget,
    coverage: coverageForNetworkRead(
      mergeRelayReadStatuses(
        organizerRecordRelays,
        organizerPickupResult.relays,
        requestResult.relays,
        requestFrontierResult.relays,
        directPickupResult.relays
      ),
      relayUrls.length
    ),
    pickupBudget,
    expectedOrganizerPubkey: expectedOrganizer ?? undefined,
    nowMs: input.nowMs,
    maxEvidenceAgeMs: input.maxEvidenceAgeMs,
    evidenceObservedAt:
      liveRecords.events.length > 0 || rawPickupFrontiers.events.length > 0
        ? observedAt
        : records.cachedObservedAt,
  })
  return downgradeCachedOnlyResolution(
    addResolutionSources(resolution, records.sourceRelayUrlsById),
    records.liveEventIds
  )
}

function collectionCoordinatesFromEvidence(
  events: readonly SignedPublicNostrEvent[],
  organizerPubkey: string
): string[] {
  const coordinates = new Set<string>()
  for (const event of events) {
    if (
      event.kind === EVENT_KINDS.PRODUCT_COLLECTION &&
      event.pubkey.toLowerCase() === organizerPubkey
    ) {
      for (const dTag of tagValues(event.tags, "d")) {
        const coordinate = parseAddressableCoordinate(
          `${EVENT_KINDS.PRODUCT_COLLECTION}:${organizerPubkey}:${dTag}`,
          [EVENT_KINDS.PRODUCT_COLLECTION]
        )
        if (coordinate) coordinates.add(coordinate.coordinate)
      }
    }
    if (
      event.kind === EVENT_KINDS.DELETION &&
      event.pubkey.toLowerCase() === organizerPubkey
    ) {
      for (const tag of event.tags) {
        const coordinate =
          tag[0] === "a"
            ? parseAddressableCoordinate(tag[1], [
                EVENT_KINDS.PRODUCT_COLLECTION,
              ])
            : null
        if (coordinate?.authorPubkey === organizerPubkey) {
          coordinates.add(coordinate.coordinate)
        }
      }
    }
  }
  return Array.from(coordinates).sort()
}

export async function getOrganizerEventMarketsDetailed(
  input: GetOrganizerEventMarketsInput
): Promise<OrganizerEventMarketsReadResult> {
  const organizerPubkey = normalizePubkey(input.organizerPubkey)
  if (!organizerPubkey) {
    const coverage = coverageForNetworkRead([], 0)
    return {
      markets: [],
      state: "unavailable",
      coverage,
      relayListState: "lookup-unavailable",
      relayHintTruncated: false,
    }
  }
  const readPlan = await eventMarketReadPlanDetailed({
    organizerPubkey,
    authenticatedPubkey: input.authenticatedPubkey,
    signal: input.signal,
  })
  const { relayUrls } = readPlan
  const observedAt = input.nowMs ?? Date.now()
  const [recordResult, cachedRecords] = await Promise.all([
    fetchEventMarketRecords({
      organizerPubkey,
      relayUrls,
      signal: input.signal,
    }),
    loadCachedEventMarketEvidence(organizerPubkey),
  ])
  const broadLiveRecords = rawSignedEvents(recordResult)
  const authorReadReachedCap = eventMarketAuthorReadReachedCap(recordResult)
  const collectionDiscoveryRelayUrls = authorReadReachedCap
    ? [...relayUrls]
    : []
  const collectionDiscoveryResult = authorReadReachedCap
    ? await fetchEventMarketCollectionDiscovery({
        organizerPubkey,
        relayUrls: collectionDiscoveryRelayUrls,
        signal: input.signal,
      })
    : {
        live: { events: [], sourceRelayUrlsById: new Map<string, string[]>() },
        relays: [],
        capped: false,
      }
  if (collectionDiscoveryResult.capped) {
    throw new EventMarketDiscoveryBoundError(
      "Organizer event-market discovery exceeded its bounded collection scan."
    )
  }
  const collectionDiscoveryStatusByRelay = new Map(
    collectionDiscoveryResult.relays.map((relay) => [
      relay.relayUrl.toLowerCase(),
      relay.status,
    ])
  )
  const collectionDiscoveryIsIncomplete = collectionDiscoveryRelayUrls.some(
    (relayUrl) =>
      collectionDiscoveryStatusByRelay.get(relayUrl.toLowerCase()) !== "success"
  )
  const preliminaryOrganizerRecords = mergeCachedAndLiveEvidence({
    cached: cachedRecords,
    live: mergeRawSignedEventGroups(
      broadLiveRecords,
      collectionDiscoveryResult.live
    ),
  })
  const preliminaryCollectionCoordinates = collectionCoordinatesFromEvidence(
    preliminaryOrganizerRecords.events,
    organizerPubkey
  )
  // Verified positive coordinates remain usable without EOSE. Only a complete
  // scan across the plan can certify an empty organizer collection result.
  if (
    authorReadReachedCap &&
    collectionDiscoveryIsIncomplete &&
    preliminaryCollectionCoordinates.length === 0
  ) {
    throw new EventMarketDiscoveryBoundError(
      "Organizer event-market collection discovery did not complete."
    )
  }
  if (
    authorReadReachedCap &&
    preliminaryCollectionCoordinates.length >
      EVENT_MARKET_COLLECTION_DISCOVERY_TARGET_LIMIT
  ) {
    throw new EventMarketDiscoveryBoundError(
      "Organizer event-market discovery exceeded its bounded collection frontier."
    )
  }
  const collectionFrontierResult = authorReadReachedCap
    ? await fetchEventMarketOrganizerRecordFrontiers({
        coordinates: preliminaryCollectionCoordinates.flatMap((reference) => {
          const coordinate = decodeEventMarketReference(reference, [
            EVENT_KINDS.PRODUCT_COLLECTION,
          ])
          return coordinate ? [coordinate] : []
        }),
        relayUrls: relayUrlsWithoutObservedFailures(
          relayUrls,
          collectionDiscoveryResult.relays
        ),
        signal: input.signal,
      })
    : { events: [], relays: [], eventsVerified: true }
  const rawCollectionFrontiers = rawSignedEvents(collectionFrontierResult)
  const recordsWithCollectionFrontiers = mergeCachedAndLiveEvidence({
    cached: cachedRecords,
    live: mergeRawSignedEventGroups(
      broadLiveRecords,
      collectionDiscoveryResult.live,
      rawCollectionFrontiers
    ),
  })
  const calendarCoordinates = collectionCalendarCoordinatesFromEvidence({
    events: recordsWithCollectionFrontiers.events,
    collectionCoordinates: preliminaryCollectionCoordinates,
  })
  if (
    authorReadReachedCap &&
    calendarCoordinates.length > EVENT_MARKET_COLLECTION_DISCOVERY_TARGET_LIMIT
  ) {
    throw new EventMarketDiscoveryBoundError(
      "Organizer event-market discovery exceeded its bounded calendar frontier."
    )
  }
  const calendarFrontierResult = authorReadReachedCap
    ? await fetchEventMarketOrganizerRecordFrontiers({
        coordinates: calendarCoordinates,
        relayUrls: relayUrlsWithoutObservedFailures(
          relayUrls,
          collectionDiscoveryResult.relays,
          collectionFrontierResult.relays
        ),
        signal: input.signal,
      })
    : { events: [], relays: [], eventsVerified: true }
  const rawCalendarFrontiers = rawSignedEvents(calendarFrontierResult)
  const liveRecords = mergeRawSignedEventGroups(
    broadLiveRecords,
    collectionDiscoveryResult.live,
    rawCollectionFrontiers,
    rawCalendarFrontiers
  )
  const organizerRecordRelays = mergeRelayReadStatuses(
    recordResult.relays,
    collectionDiscoveryResult.relays,
    collectionFrontierResult.relays,
    calendarFrontierResult.relays
  )
  await persistEventMarketEvidence({
    organizerPubkey,
    events: liveRecords.events,
    sourceRelayUrlsById: liveRecords.sourceRelayUrlsById,
    cachedAt: observedAt,
  })
  const organizerRecords = mergeCachedAndLiveEvidence({
    cached: cachedRecords,
    live: liveRecords,
  })
  const collectionCoordinates = collectionCoordinatesFromEvidence(
    organizerRecords.events,
    organizerPubkey
  )
  const organizerPickupCoordinates = collectionPickupCoordinatesFromEvidence({
    events: organizerRecords.events,
    collectionCoordinates,
  })
  const discoveryProjection = input.projection === "discovery"
  const [requestResult, organizerPickupResult] = await Promise.all([
    discoveryProjection
      ? Promise.resolve({
          events: [],
          relays: [],
          eventsVerified: true,
        } satisfies FetchEventsFanoutResult)
      : fetchEventMarketProductRequests({
          collectionCoordinates,
          relayUrls: relayUrlsWithoutObservedFailures(
            relayUrls,
            organizerRecordRelays
          ),
          signal: input.signal,
        }),
    fetchEventMarketPickupFrontiers({
      coordinates: organizerPickupCoordinates,
      candidateEvents: organizerRecords.events,
      candidateSourceRelayUrlsById: organizerRecords.sourceRelayUrlsById,
      relayUrls: relayUrlsWithoutObservedFailures(
        relayUrls,
        organizerRecordRelays
      ),
      authenticatedPubkey: input.authenticatedPubkey,
      signal: input.signal,
    }),
  ])
  const rawOrganizerPickupFrontiers = rawSignedEvents(organizerPickupResult)
  const rawRequestCandidates = rawSignedEvents(requestResult)
  const organizerProductCoordinates = discoveryProjection
    ? []
    : organizerProductCoordinatesFromEvidence(
        organizerRecords.events,
        collectionCoordinates
      )
  const requestFrontierResult = discoveryProjection
    ? {
        events: [],
        relays: [],
        eventsVerified: true,
        participationBudget: EMPTY_PARTICIPATION_BUDGET,
      }
    : await fetchEventMarketProductRequestFrontiers({
        candidateEvents: rawRequestCandidates.events,
        candidateCoordinates: organizerProductCoordinates,
        candidateSourceRelayUrlsById: rawRequestCandidates.sourceRelayUrlsById,
        relayUrls: relayUrlsWithoutObservedFailures(
          relayUrls,
          organizerRecordRelays,
          requestResult.relays
        ),
        authenticatedPubkey: input.authenticatedPubkey,
        signal: input.signal,
      })
  const rawRequestFrontiers = rawSignedEvents(requestFrontierResult)
  const participantCoordinates =
    requestFrontierResult.participationBudget.state === "within_budget"
      ? candidateProductCoordinates({
          candidateEvents: rawRequestCandidates.events,
          candidateCoordinates: organizerProductCoordinates,
        }).map((coordinate) => coordinate.coordinate)
      : []
  const productRequestEventsByCollection = new Map(
    collectionCoordinates.map((reference) => [
      reference,
      participationEvidenceForCollection({
        reference,
        candidateCoordinates: participantCoordinates,
        cached: cachedRecords,
        live: rawRequestFrontiers.events,
      }),
    ])
  )
  const directMerchantPickupCoordinatesByIdentity = new Map<
    string,
    AddressableEventCoordinate
  >()
  if (requestFrontierResult.participationBudget.state === "within_budget") {
    for (const reference of collectionCoordinates) {
      for (const coordinate of directMerchantPickupCoordinatesFromProductEvidence(
        {
          events: productRequestEventsByCollection.get(reference) ?? [],
          collectionCoordinate: reference,
          organizerProducts: organizerProductCoordinatesFromEvidence(
            organizerRecords.events,
            [reference]
          ),
          organizerPubkey,
        }
      )) {
        directMerchantPickupCoordinatesByIdentity.set(
          coordinate.coordinate,
          coordinate
        )
      }
    }
  }
  const directMerchantPickupCoordinates = Array.from(
    directMerchantPickupCoordinatesByIdentity.values()
  )
  const pickupCoordinatesByIdentity = new Map(
    [...organizerPickupCoordinates, ...directMerchantPickupCoordinates].map(
      (coordinate) => [coordinate.coordinate, coordinate]
    )
  )
  const pickupCoordinates = Array.from(pickupCoordinatesByIdentity.values())
  const pickupBudget: EventMarketParticipationBudget = {
    state:
      pickupCoordinates.length >
      EVENT_MARKET_PARTICIPATION_FRONTIER_TARGET_LIMIT
        ? "exceeded"
        : "within_budget",
    targetCount: pickupCoordinates.length,
    targetLimit: EVENT_MARKET_PARTICIPATION_FRONTIER_TARGET_LIMIT,
  }
  const requestEvidence = mergeRawSignedEventGroups(
    rawRequestCandidates,
    rawRequestFrontiers
  )
  const directPickupResult =
    pickupBudget.state === "exceeded"
      ? {
          events: [],
          relays: [],
          eventsVerified: true,
          pickupBudget,
        }
      : await fetchEventMarketPickupFrontiers({
          coordinates: directMerchantPickupCoordinates,
          candidateEvents: requestEvidence.events,
          candidateSourceRelayUrlsById: requestEvidence.sourceRelayUrlsById,
          relayUrls: relayUrlsWithoutObservedFailures(
            relayUrls,
            organizerRecordRelays,
            requestResult.relays,
            requestFrontierResult.relays
          ),
          authenticatedPubkey: input.authenticatedPubkey,
          signal: input.signal,
        })
  const rawDirectPickupFrontiers = rawSignedEvents(directPickupResult)
  const rawPickupFrontiers = mergeRawSignedEventGroups(
    rawOrganizerPickupFrontiers,
    rawDirectPickupFrontiers
  )
  const records = mergeCachedAndLiveEvidence({
    cached: cachedRecords,
    live: mergeRawSignedEventGroups(liveRecords, rawPickupFrontiers),
  })
  if (!discoveryProjection) {
    await persistEventMarketEvidence({
      organizerPubkey,
      events: rawRequestFrontiers.events,
      sourceRelayUrlsById: rawRequestFrontiers.sourceRelayUrlsById,
      participantCoordinates,
      cachedAt: observedAt,
    })
  }
  await persistEventMarketEvidence({
    organizerPubkey,
    events: rawPickupFrontiers.events,
    sourceRelayUrlsById: rawPickupFrontiers.sourceRelayUrlsById,
    participantPickupCoordinates: pickupCoordinates.map(
      (coordinate) => coordinate.coordinate
    ),
    cachedAt: observedAt,
  })
  const coverage = coverageForNetworkRead(
    mergeRelayReadStatuses(
      organizerRecordRelays,
      organizerPickupResult.relays,
      requestResult.relays,
      requestFrontierResult.relays,
      directPickupResult.relays
    ),
    relayUrls.length
  )
  const markets = collectionCoordinates.map((reference) => {
    const productRequestEvents =
      productRequestEventsByCollection.get(reference) ?? []
    return downgradeCachedOnlyResolution(
      addResolutionSources(
        resolveEventMarketEvidence({
          reference,
          events: records.events,
          productRequestEvents,
          participationBudget: requestFrontierResult.participationBudget,
          pickupBudget,
          coverage,
          expectedOrganizerPubkey: organizerPubkey,
          nowMs: input.nowMs,
          maxEvidenceAgeMs: input.maxEvidenceAgeMs,
          evidenceObservedAt:
            liveRecords.events.length > 0 ||
            rawPickupFrontiers.events.length > 0
              ? observedAt
              : records.cachedObservedAt,
          includeParticipation: !discoveryProjection,
        }),
        records.sourceRelayUrlsById
      ),
      records.liveEventIds
    )
  })
  return {
    markets,
    state: organizerMarketsReadState(coverage, readPlan),
    coverage,
    relayListState: readPlan.relayListState,
    relayHintTruncated: readPlan.relayHintTruncated,
  }
}

export async function getOrganizerEventMarkets(
  input: GetOrganizerEventMarketsInput
): Promise<EventMarketResolution[]> {
  return (await getOrganizerEventMarketsDetailed(input)).markets
}

export type OrganizerEventMarketRecord = "calendar" | "pickup" | "collection"

export interface OrganizerEventMarketRecordDelivery {
  attemptedRelayUrls: string[]
  successfulRelayUrls: string[]
  failedRelayUrls: string[]
  acknowledgedRelayUrls: string[]
  rejectedRelayUrls: string[]
  timedOutRelayUrls: string[]
}

export interface OrganizerEventMarketSignedRecord {
  record: OrganizerEventMarketRecord
  signedEvent: SignedPublicNostrEvent
  delivery: OrganizerEventMarketRecordDelivery
}

export type OrganizerEventMarketSignedEvent = Pick<
  OrganizerEventMarketSignedRecord,
  "record" | "signedEvent"
>

export interface OrganizerEventMarketPublishResult {
  calendar: OrganizerEventMarketSignedRecord
  pickup?: OrganizerEventMarketSignedRecord
  collection: OrganizerEventMarketSignedRecord
}

export interface OrganizerEventMarketCalendarPublishInput {
  kind: typeof EVENT_KINDS.CALENDAR_DATE | typeof EVENT_KINDS.CALENDAR_TIME
  dTag: string
  title: string
  content?: string
  summary?: string
  image?: string
  imageUrl?: string
  location?: string
  locations?: string[]
  geohash?: string
  start: string | number
  end?: string | number
  timezone?: string
  startTzid?: string
  endTzid?: string
  clientAppId?: ConduitAppId
}

export interface OrganizerEventMarketPickupPublishInput {
  dTag: string
  title: string
  price: string | number
  currency: string
  country?: string
  countries?: string[]
  countryCodes?: string[]
  location?: string
  geohash?: string
  content?: string
  clientAppId?: ConduitAppId
}

export interface OrganizerEventMarketCollectionPublishInput {
  dTag: string
  title: string
  eventCoordinate?: string
  calendarCoordinate?: string
  /** Organizer-owned event pickup; omitted when merchants handle pickup. */
  pickupCoordinate?: string
  /** Compatibility projection; at most one organizer-owned coordinate. */
  pickupCoordinates?: string[]
  productCoordinates?: string[]
  content?: string
  summary?: string
  image?: string
  imageUrl?: string
  location?: string
  geohash?: string
  clientAppId?: ConduitAppId
}

export interface PublishOrganizerEventMarketInput {
  organizerPubkey: string
  calendar: OrganizerEventMarketCalendarPublishInput
  pickup?: OrganizerEventMarketPickupPublishInput
  collection: OrganizerEventMarketCollectionPublishInput
  previousCreatedAt?: number
  previousCreatedAtByRecord?: Partial<
    Record<OrganizerEventMarketRecord, number>
  >
  onSignedEvent?: (
    record: OrganizerEventMarketSignedEvent
  ) => void | Promise<void>
  onSignedRecord?: (record: OrganizerEventMarketSignedRecord) => void
  waitForSignerVisibility?: () => Promise<void>
  now?: () => number
}

export interface PublishOrganizerCollectionUpdateInput {
  organizerPubkey: string
  collection: OrganizerEventMarketCollectionPublishInput
  previousCreatedAt?: number
  onSignedEvent?: (
    record: OrganizerEventMarketSignedEvent
  ) => void | Promise<void>
  onSignedRecord?: (record: OrganizerEventMarketSignedRecord) => void
  now?: () => number
}

export interface PublishEventMarketPickupOptionInput {
  authorPubkey: string
  pickup: OrganizerEventMarketPickupPublishInput
  previousCreatedAt?: number
  /** Durable exact-retry seam. Resolves before any relay publish begins. */
  onSignedEvent: (
    record: OrganizerEventMarketSignedEvent
  ) => void | Promise<void>
  onSignedRecord?: (record: OrganizerEventMarketSignedRecord) => void
  waitForSignerVisibility?: () => Promise<void>
  now?: () => number
}

function normalizePreviousCreatedAt(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0
  return Math.floor(value! > 10_000_000_000 ? value! / 1_000 : value!)
}

function nextReplaceableCreatedAt(
  previousCreatedAt: number | undefined,
  now: () => number
): number {
  return Math.max(
    Math.floor(now() / 1_000),
    normalizePreviousCreatedAt(previousCreatedAt) + 1
  )
}

function expectedOrganizerCoordinate(
  kind: number,
  organizerPubkey: string,
  dTag: string,
  label: string
): string {
  const coordinate = parseAddressableCoordinate(
    `${kind}:${organizerPubkey}:${dTag}`,
    [kind]
  )
  if (!coordinate) throw new Error(`${label} coordinate is invalid.`)
  return coordinate.coordinate
}

function requireOrganizerCollectionGraph(input: {
  organizerPubkey: string
  collection: OrganizerEventMarketCollectionPublishInput
  expectedCalendarCoordinate?: string
  expectedPickupCoordinate?: string
}): void {
  const rawCalendarCoordinate =
    input.collection.eventCoordinate ?? input.collection.calendarCoordinate
  const calendar = rawCalendarCoordinate
    ? parseAddressableCoordinate(
        rawCalendarCoordinate,
        EVENT_MARKET_CALENDAR_KINDS
      )
    : null
  const pickups = [
    ...(input.collection.pickupCoordinates ?? []),
    ...(input.collection.pickupCoordinate
      ? [input.collection.pickupCoordinate]
      : []),
  ].map((coordinate) =>
    parseAddressableCoordinate(coordinate, [EVENT_KINDS.SHIPPING_OPTION])
  )
  if (
    !calendar ||
    calendar.authorPubkey !== input.organizerPubkey ||
    (input.expectedCalendarCoordinate !== undefined &&
      calendar.coordinate !== input.expectedCalendarCoordinate)
  ) {
    throw new Error(
      "Collection calendar must match the organizer calendar being published."
    )
  }
  if (
    pickups.some((pickup) => !pickup) ||
    (input.expectedPickupCoordinate !== undefined &&
      !pickups.some(
        (pickup) => pickup?.coordinate === input.expectedPickupCoordinate
      ))
  ) {
    throw new Error(
      "Collection pickups must be valid and include the organizer pickup being published."
    )
  }
}

function calendarPublishDraft(
  input: OrganizerEventMarketCalendarPublishInput
): EventMarketEventDraft {
  const common = {
    dTag: input.dTag,
    title: input.title,
    content: input.content,
    summary: input.summary,
    image: input.image ?? input.imageUrl,
    locations:
      input.locations ?? (input.location?.trim() ? [input.location] : []),
    geohash: input.geohash,
    clientAppId: input.clientAppId ?? ("merchant" as const),
  }
  if (input.kind === EVENT_KINDS.CALENDAR_DATE) {
    if (typeof input.start !== "string") {
      throw new Error("Date calendar start must be an ISO date.")
    }
    return buildEventMarketCalendarDraft({
      ...common,
      kind: EVENT_KINDS.CALENDAR_DATE,
      start: input.start,
      ...(typeof input.end === "string" ? { end: input.end } : {}),
    })
  }
  if (typeof input.start !== "number") {
    throw new Error("Timed calendar start must be epoch seconds.")
  }
  return buildEventMarketCalendarDraft({
    ...common,
    kind: EVENT_KINDS.CALENDAR_TIME,
    start: input.start,
    ...(typeof input.end === "number" ? { end: input.end } : {}),
    startTzid: input.startTzid ?? input.timezone,
    endTzid: input.endTzid ?? input.timezone,
  })
}

function pickupPublishDraft(
  input: OrganizerEventMarketPickupPublishInput
): EventMarketEventDraft {
  const price =
    typeof input.price === "number"
      ? input.price
      : parseNonNegativeDecimal(input.price.trim())
  if (price === null) throw new Error("Pickup price is invalid.")
  return buildEventMarketPickupDraft({
    dTag: input.dTag,
    title: input.title,
    price,
    currency: input.currency,
    countries:
      input.countries ??
      input.countryCodes ??
      (input.country ? [input.country] : []),
    location: input.location,
    geohash: input.geohash,
    content: input.content,
    clientAppId: input.clientAppId ?? "merchant",
  })
}

function collectionPublishDraft(
  input: OrganizerEventMarketCollectionPublishInput
): EventMarketEventDraft {
  const eventCoordinate = input.eventCoordinate ?? input.calendarCoordinate
  if (!eventCoordinate) throw new Error("Collection requires a calendar event.")
  return buildEventMarketCollectionDraft({
    dTag: input.dTag,
    title: input.title,
    eventCoordinate,
    pickupCoordinate: input.pickupCoordinate,
    pickupCoordinates: input.pickupCoordinates,
    productCoordinates: input.productCoordinates,
    content: input.content,
    summary: input.summary,
    image: input.image ?? input.imageUrl,
    location: input.location,
    geohash: input.geohash,
    clientAppId: input.clientAppId ?? "merchant",
  })
}

async function signEventMarketDraft(input: {
  draft: EventMarketEventDraft
  createdAt: number
  organizerPubkey: string
}): Promise<SignedPublicNostrEvent> {
  const override = eventMarketTestOverrides.signDraft
  if (override) {
    const signed = await override(input)
    if (
      !isValidSignedPublicNostrEvent(signed) ||
      signed.pubkey.toLowerCase() !== input.organizerPubkey ||
      signed.kind !== input.draft.kind ||
      signed.created_at !== input.createdAt
    ) {
      throw new Error("Signer returned invalid organizer event evidence.")
    }
    return signed
  }

  const ndk = await (eventMarketTestOverrides.getNdk ?? getNdk)()
  if (!ndk.signer) throw new Error("Signer not connected")
  const signerPubkey = normalizePubkey((await ndk.signer.user()).pubkey)
  if (signerPubkey !== input.organizerPubkey) {
    throw new Error("Active signer does not match this organizer.")
  }
  const event = new NDKEvent(ndk)
  event.kind = input.draft.kind
  event.created_at = input.createdAt
  event.content = input.draft.content
  event.tags = input.draft.tags
  await event.sign(ndk.signer)
  const signed = event.rawEvent() as SignedPublicNostrEvent
  if (
    !isValidSignedPublicNostrEvent(signed) ||
    signed.pubkey.toLowerCase() !== input.organizerPubkey
  ) {
    throw new Error("Signer returned invalid organizer event evidence.")
  }
  return signed
}

function classifyRecordDelivery(
  result: PublishWithPlannerResult
): OrganizerEventMarketRecordDelivery {
  const rejectedRelayUrls: string[] = []
  const timedOutRelayUrls: string[] = []
  for (const relayUrl of result.failedRelayUrls) {
    const failure = result.relayFailureMessages[relayUrl]?.toLowerCase() ?? ""
    if (failure.includes("timeout") || failure.includes("timed out")) {
      timedOutRelayUrls.push(relayUrl)
    } else {
      rejectedRelayUrls.push(relayUrl)
    }
  }
  return {
    attemptedRelayUrls: [...result.attemptedRelayUrls],
    successfulRelayUrls: [...result.successfulRelayUrls],
    failedRelayUrls: [...result.failedRelayUrls],
    acknowledgedRelayUrls: [...result.successfulRelayUrls],
    rejectedRelayUrls,
    timedOutRelayUrls,
  }
}

function diagnosticsFromPublishError(
  error: unknown
): PublishWithPlannerResult | null {
  if (!error || typeof error !== "object") return null
  const diagnostics = (error as { diagnostics?: unknown }).diagnostics
  if (!diagnostics || typeof diagnostics !== "object") return null
  const candidate = diagnostics as PublishWithPlannerResult
  return Array.isArray(candidate.successfulRelayUrls) &&
    Array.isArray(candidate.failedRelayUrls) &&
    Array.isArray(candidate.attemptedRelayUrls)
    ? candidate
    : null
}

async function publishSignedEventMarketRecord(input: {
  record: OrganizerEventMarketRecord
  organizerPubkey: string
  signedEvent: SignedPublicNostrEvent
}): Promise<OrganizerEventMarketSignedRecord> {
  if (
    !isValidSignedPublicNostrEvent(input.signedEvent) ||
    input.signedEvent.pubkey.toLowerCase() !== input.organizerPubkey
  ) {
    throw new Error("Refusing to publish invalid organizer event evidence.")
  }
  const ndk = await (eventMarketTestOverrides.getNdk ?? getNdk)()
  const event = new NDKEvent(ndk, input.signedEvent)
  const publish =
    eventMarketTestOverrides.publishWithPlanner ?? publishWithPlanner
  let result: PublishWithPlannerResult
  try {
    result = await publish(event, {
      intent: "author_event",
      authorPubkey: input.organizerPubkey,
      authenticatedPubkey: input.organizerPubkey,
      deliveryMode: "critical",
    })
  } catch (error) {
    const diagnostics = diagnosticsFromPublishError(error)
    if (!diagnostics) throw error
    result = diagnostics
  }
  return {
    record: input.record,
    signedEvent: input.signedEvent,
    delivery: classifyRecordDelivery(result),
  }
}

function requireAcknowledged(record: OrganizerEventMarketSignedRecord): void {
  if (record.delivery.acknowledgedRelayUrls.length === 0) {
    throw new Error(
      `No relay acknowledged the signed ${record.record} event record.`
    )
  }
}

function organizerRecordForKind(
  kind: number
): OrganizerEventMarketRecord | null {
  if (EVENT_MARKET_CALENDAR_KINDS.includes(kind as never)) return "calendar"
  if (kind === EVENT_KINDS.SHIPPING_OPTION) return "pickup"
  if (kind === EVENT_KINDS.PRODUCT_COLLECTION) return "collection"
  return null
}

export async function publishOrganizerEventMarket(
  input: PublishOrganizerEventMarketInput
): Promise<OrganizerEventMarketPublishResult> {
  const organizerPubkey = normalizePubkey(input.organizerPubkey)
  if (!organizerPubkey) throw new Error("Organizer pubkey is invalid.")
  const expectedCalendarCoordinate = expectedOrganizerCoordinate(
    input.calendar.kind,
    organizerPubkey,
    input.calendar.dTag,
    "Calendar"
  )
  const expectedPickupCoordinate = input.pickup
    ? expectedOrganizerCoordinate(
        EVENT_KINDS.SHIPPING_OPTION,
        organizerPubkey,
        input.pickup.dTag,
        "Pickup"
      )
    : undefined
  requireOrganizerCollectionGraph({
    organizerPubkey,
    collection: input.collection,
    expectedCalendarCoordinate,
    expectedPickupCoordinate,
  })
  // Validate the complete graph before asking the signer for any durable
  // intent. A malformed later record must not leave an orphaned signed record
  // in the exact-retry outbox.
  const calendarDraft = calendarPublishDraft(input.calendar)
  const pickupDraft = input.pickup ? pickupPublishDraft(input.pickup) : null
  const collectionDraft = collectionPublishDraft(input.collection)
  const now = input.now ?? Date.now
  const calendarCreatedAt = nextReplaceableCreatedAt(
    input.previousCreatedAtByRecord?.calendar ?? input.previousCreatedAt,
    now
  )
  const pickupCreatedAt = nextReplaceableCreatedAt(
    input.previousCreatedAtByRecord?.pickup ?? input.previousCreatedAt,
    now
  )
  const collectionCreatedAt = nextReplaceableCreatedAt(
    input.previousCreatedAtByRecord?.collection ?? input.previousCreatedAt,
    now
  )
  const waitForSignerVisibility =
    input.waitForSignerVisibility ?? waitForVisibleDocument
  await waitForSignerVisibility()
  const calendarSigned = await signEventMarketDraft({
    draft: calendarDraft,
    createdAt: calendarCreatedAt,
    organizerPubkey,
  })
  await input.onSignedEvent?.({
    record: "calendar",
    signedEvent: calendarSigned,
  })
  let pickupSigned: SignedPublicNostrEvent | null = null
  if (pickupDraft) {
    await waitForSignerVisibility()
    pickupSigned = await signEventMarketDraft({
      draft: pickupDraft,
      createdAt: pickupCreatedAt,
      organizerPubkey,
    })
  }
  if (pickupSigned) {
    await input.onSignedEvent?.({ record: "pickup", signedEvent: pickupSigned })
  }
  await waitForSignerVisibility()
  const collectionSigned = await signEventMarketDraft({
    draft: collectionDraft,
    createdAt: collectionCreatedAt,
    organizerPubkey,
  })
  await input.onSignedEvent?.({
    record: "collection",
    signedEvent: collectionSigned,
  })

  const calendar = await publishSignedEventMarketRecord({
    record: "calendar",
    organizerPubkey,
    signedEvent: calendarSigned,
  })
  input.onSignedRecord?.(calendar)
  requireAcknowledged(calendar)

  const pickup = pickupSigned
    ? await publishSignedEventMarketRecord({
        record: "pickup",
        organizerPubkey,
        signedEvent: pickupSigned,
      })
    : undefined
  if (pickup) {
    input.onSignedRecord?.(pickup)
    requireAcknowledged(pickup)
  }

  const collection = await publishSignedEventMarketRecord({
    record: "collection",
    organizerPubkey,
    signedEvent: collectionSigned,
  })
  input.onSignedRecord?.(collection)
  requireAcknowledged(collection)
  return { calendar, ...(pickup ? { pickup } : {}), collection }
}

export async function publishOrganizerCollectionUpdate(
  input: PublishOrganizerCollectionUpdateInput
): Promise<OrganizerEventMarketSignedRecord> {
  const organizerPubkey = normalizePubkey(input.organizerPubkey)
  if (!organizerPubkey) throw new Error("Organizer pubkey is invalid.")
  requireOrganizerCollectionGraph({
    organizerPubkey,
    collection: input.collection,
  })
  const signedEvent = await signEventMarketDraft({
    draft: collectionPublishDraft(input.collection),
    createdAt: nextReplaceableCreatedAt(
      input.previousCreatedAt,
      input.now ?? Date.now
    ),
    organizerPubkey,
  })
  await input.onSignedEvent?.({ record: "collection", signedEvent })
  const record = await publishSignedEventMarketRecord({
    record: "collection",
    organizerPubkey,
    signedEvent,
  })
  input.onSignedRecord?.(record)
  requireAcknowledged(record)
  return record
}

/** Publish one author-owned pickup option for an event booth. */
export async function publishEventMarketPickupOption(
  input: PublishEventMarketPickupOptionInput
): Promise<OrganizerEventMarketSignedRecord> {
  const authorPubkey = normalizePubkey(input.authorPubkey)
  if (!authorPubkey) throw new Error("Pickup author pubkey is invalid.")
  await (input.waitForSignerVisibility ?? waitForVisibleDocument)()
  const signedEvent = await signEventMarketDraft({
    draft: pickupPublishDraft(input.pickup),
    createdAt: nextReplaceableCreatedAt(
      input.previousCreatedAt,
      input.now ?? Date.now
    ),
    organizerPubkey: authorPubkey,
  })
  await input.onSignedEvent({ record: "pickup", signedEvent })
  const record = await publishSignedEventMarketRecord({
    record: "pickup",
    organizerPubkey: authorPubkey,
    signedEvent,
  })
  input.onSignedRecord?.(record)
  requireAcknowledged(record)
  return record
}

/** Retry the exact already-signed booth pickup without asking the signer again. */
export async function retryEventMarketPickupOption(input: {
  authorPubkey: string
  signedEvent: SignedPublicNostrEvent
}): Promise<OrganizerEventMarketSignedRecord> {
  if (input.signedEvent.kind !== EVENT_KINDS.SHIPPING_OPTION) {
    throw new Error("Pickup retry requires a kind-30406 signed event.")
  }
  return retryOrganizerEventMarketRecord({
    organizerPubkey: input.authorPubkey,
    signedEvent: input.signedEvent,
  })
}

export async function retryOrganizerEventMarketRecord(input: {
  organizerPubkey: string
  signedEvent: SignedPublicNostrEvent
}): Promise<OrganizerEventMarketSignedRecord> {
  const organizerPubkey = normalizePubkey(input.organizerPubkey)
  const record = organizerRecordForKind(input.signedEvent?.kind)
  if (!organizerPubkey || !record) {
    throw new Error("Organizer retry record is invalid.")
  }
  const result = await publishSignedEventMarketRecord({
    record,
    organizerPubkey,
    signedEvent: input.signedEvent,
  })
  requireAcknowledged(result)
  return result
}
