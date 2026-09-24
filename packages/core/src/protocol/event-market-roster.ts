import type { ProductSchema } from "../schemas"
import type { EventMarketAuthorizationResolution } from "./event-market-authorization"
import {
  isEventMarketAddressableRevisionDeleted,
  parseAddressableCoordinate,
  parseEventMarketCalendarEvent,
  type EventMarketEventDraft,
  type ParsedEventMarketCalendar,
} from "./event-market"
import { EVENT_KINDS } from "./kinds"
import { parseProductEvent } from "./products"
import {
  compareReplaceableEventFrontiers,
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

const HEX_64 = /^[0-9a-f]{64}$/
const CONTROL_CHARACTER = /\p{Cc}/u
const MAX_MERCHANTS = 128
const MAX_ASSIGNMENT_BYTES = 120
const MAX_EVENT_BYTES = 65_536

export type EventMarketMerchantMode = "merchant_present" | "organizer_handoff"
export type EventMarketCommerceState = "open" | "closed"

export interface EventMarketMerchantRow {
  pubkey: string
  mode: EventMarketMerchantMode
  assignment: string
}

export interface ParsedEventMarketRoster {
  coordinate: string
  organizerPubkey: string
  calendarCoordinate: string
  eventId: string
  createdAt: number
  state: EventMarketCommerceState
  merchants: EventMarketMerchantRow[]
  previousEventId?: string
  signedEvent: SignedPublicNostrEvent
}

export interface EventMarketRosterDraftInput {
  dTag: string
  organizerPubkey: string
  calendarCoordinate: string
  state: EventMarketCommerceState
  merchants: readonly EventMarketMerchantRow[]
  previousEventId?: string
}

function validDTag(value: string): boolean {
  return (
    value.length > 0 &&
    new TextEncoder().encode(value).length <= 128 &&
    !CONTROL_CHARACTER.test(value)
  )
}

function validRow(row: EventMarketMerchantRow): boolean {
  return (
    HEX_64.test(row.pubkey) &&
    (row.mode === "merchant_present" || row.mode === "organizer_handoff") &&
    row.assignment.trim() === row.assignment &&
    row.assignment.length > 0 &&
    new TextEncoder().encode(row.assignment).length <= MAX_ASSIGNMENT_BYTES &&
    !CONTROL_CHARACTER.test(row.assignment)
  )
}

function validRows(rows: readonly EventMarketMerchantRow[]): boolean {
  return (
    rows.length <= MAX_MERCHANTS &&
    rows.every(validRow) &&
    new Set(rows.map((row) => row.pubkey)).size === rows.length
  )
}

export function buildEventMarketRosterDraft(
  input: EventMarketRosterDraftInput
): EventMarketEventDraft {
  const calendar = parseAddressableCoordinate(input.calendarCoordinate, [
    EVENT_KINDS.CALENDAR_DATE,
    EVENT_KINDS.CALENDAR_TIME,
  ])
  if (
    !HEX_64.test(input.organizerPubkey) ||
    !validDTag(input.dTag) ||
    !calendar ||
    calendar.authorPubkey !== input.organizerPubkey ||
    (input.state !== "open" && input.state !== "closed") ||
    !validRows(input.merchants) ||
    (input.previousEventId !== undefined && !HEX_64.test(input.previousEventId))
  ) {
    throw new Error("Event Market roster is invalid.")
  }
  const tags = [
    ["d", input.dTag],
    ["a", calendar.coordinate],
    ["event_market", "2", input.state],
    ...input.merchants.map((row) => [
      "merchant",
      row.pubkey,
      row.mode,
      row.assignment,
    ]),
    ...(input.previousEventId ? [["prev", input.previousEventId]] : []),
  ]
  const draft = { kind: EVENT_KINDS.EVENT_MARKET, tags, content: "" }
  // Reserve the signed envelope fields (pubkey, id, signature, timestamp).
  if (
    new TextEncoder().encode(JSON.stringify(draft)).length >
    MAX_EVENT_BYTES - 512
  ) {
    throw new Error("Event Market record exceeds the public size limit.")
  }
  return draft
}

export function parseEventMarketRosterEvent(
  event: SignedPublicNostrEvent
): ParsedEventMarketRoster | null {
  if (
    event.kind !== EVENT_KINDS.EVENT_MARKET ||
    !isValidSignedPublicNostrEvent(event) ||
    new TextEncoder().encode(JSON.stringify(event)).length > MAX_EVENT_BYTES
  ) {
    return null
  }
  const dTags = event.tags.filter((tag) => tag[0] === "d")
  const calendarTags = event.tags.filter((tag) => tag[0] === "a")
  const stateTags = event.tags.filter((tag) => tag[0] === "event_market")
  const previousTags = event.tags.filter((tag) => tag[0] === "prev")
  const merchantTags = event.tags.filter((tag) => tag[0] === "merchant")
  const dTag = dTags[0]?.[1]
  const calendar = parseAddressableCoordinate(calendarTags[0]?.[1], [
    EVENT_KINDS.CALENDAR_DATE,
    EVENT_KINDS.CALENDAR_TIME,
  ])
  const state = stateTags[0]?.[2]
  const previousEventId = previousTags[0]?.[1]
  if (
    dTags.length !== 1 ||
    dTags[0]?.length !== 2 ||
    !dTag ||
    !validDTag(dTag) ||
    calendarTags.length !== 1 ||
    calendarTags[0]?.length !== 2 ||
    !calendar ||
    calendar.authorPubkey !== event.pubkey ||
    stateTags.length !== 1 ||
    stateTags[0]?.length !== 3 ||
    stateTags[0][1] !== "2" ||
    (state !== "open" && state !== "closed") ||
    previousTags.length > 1 ||
    (previousTags.length === 1 &&
      (previousTags[0]?.length !== 2 ||
        !previousEventId ||
        !HEX_64.test(previousEventId) ||
        previousEventId === event.id)) ||
    merchantTags.some((tag) => tag.length !== 4) ||
    event.tags.some((tag) => tag[0] === "shipping_option")
  ) {
    return null
  }
  const merchants = merchantTags.map((tag) => ({
    pubkey: tag[1] ?? "",
    mode: tag[2] as EventMarketMerchantMode,
    assignment: tag[3] ?? "",
  }))
  if (!validRows(merchants)) return null
  return {
    coordinate: `${EVENT_KINDS.EVENT_MARKET}:${event.pubkey}:${dTag}`,
    organizerPubkey: event.pubkey,
    calendarCoordinate: calendar.coordinate,
    eventId: event.id,
    createdAt: event.created_at,
    state,
    merchants,
    ...(previousEventId ? { previousEventId } : {}),
    signedEvent: event,
  }
}

export type EventMarketRosterResolution =
  | { state: "invalid_reference" }
  | { state: "missing" }
  | { state: "malformed" | "deleted" | "conflicting"; eventId: string }
  | { state: "current"; market: ParsedEventMarketRoster }

/** Reduce signed revisions before parsing; a malformed newer revision never restores older admission. */
export function resolveEventMarketRoster(input: {
  coordinate: string
  revisions: readonly SignedPublicNostrEvent[]
  deletions?: readonly SignedPublicNostrEvent[]
}): EventMarketRosterResolution {
  const coordinate = parseAddressableCoordinate(input.coordinate, [
    EVENT_KINDS.EVENT_MARKET,
  ])
  if (!coordinate) return { state: "invalid_reference" }
  const revisions = input.revisions
    .filter(
      (event) =>
        event.kind === EVENT_KINDS.EVENT_MARKET &&
        event.pubkey === coordinate.authorPubkey &&
        event.tags.some(
          (tag) => tag[0] === "d" && tag[1] === coordinate.dTag
        ) &&
        isValidSignedPublicNostrEvent(event)
    )
    .sort(
      (left, right) =>
        -compareReplaceableEventFrontiers(
          { createdAt: left.created_at, eventId: left.id },
          { createdAt: right.created_at, eventId: right.id }
        )
    )
  const winner = revisions[0]
  if (!winner) return { state: "missing" }
  if (
    isEventMarketAddressableRevisionDeleted(
      {
        coordinate: coordinate.coordinate,
        eventId: winner.id,
        createdAt: winner.created_at * 1_000,
      },
      input.deletions ?? []
    )
  ) {
    return { state: "deleted", eventId: winner.id }
  }
  const market = parseEventMarketRosterEvent(winner)
  if (!market) return { state: "malformed", eventId: winner.id }
  const observedParents = new Set<string>()
  let observedRoots = 0
  for (const revision of revisions) {
    const parsed = parseEventMarketRosterEvent(revision)
    if (!parsed) continue
    if (!parsed.previousEventId) {
      observedRoots++
      continue
    }
    if (observedParents.has(parsed.previousEventId)) {
      return { state: "conflicting", eventId: winner.id }
    }
    observedParents.add(parsed.previousEventId)
  }
  if (observedRoots > 1) return { state: "conflicting", eventId: winner.id }
  // Missing intermediate revisions from a pruned relay do not establish a fork.
  const knownById = new Map(revisions.map((event) => [event.id, event]))
  let cursor: ParsedEventMarketRoster | null = market
  const ancestors = new Set<string>()
  while (cursor) {
    if (ancestors.has(cursor.eventId))
      return { state: "conflicting", eventId: winner.id }
    ancestors.add(cursor.eventId)
    if (!cursor.previousEventId) break
    const parent = knownById.get(cursor.previousEventId)
    if (!parent) break
    cursor = parseEventMarketRosterEvent(parent)
    if (!cursor) break
  }
  if (
    cursor &&
    !cursor.previousEventId &&
    revisions.some((event) => !ancestors.has(event.id))
  )
    return { state: "conflicting", eventId: winner.id }
  return { state: "current", market }
}

export function resolveEventMarketCalendar(input: {
  market: ParsedEventMarketRoster
  revisions: readonly SignedPublicNostrEvent[]
  deletions?: readonly SignedPublicNostrEvent[]
}): ParsedEventMarketCalendar | null {
  const candidates = input.revisions
    .filter(
      (event) =>
        (event.kind === EVENT_KINDS.CALENDAR_DATE ||
          event.kind === EVENT_KINDS.CALENDAR_TIME) &&
        event.pubkey === input.market.organizerPubkey &&
        event.tags.some(
          (tag) =>
            tag[0] === "d" &&
            `${event.kind}:${event.pubkey}:${tag[1]}` ===
              input.market.calendarCoordinate
        ) &&
        isValidSignedPublicNostrEvent(event)
    )
    .sort(
      (left, right) =>
        -compareReplaceableEventFrontiers(
          { createdAt: left.created_at, eventId: left.id },
          { createdAt: right.created_at, eventId: right.id }
        )
    )
  const winner = candidates[0]
  if (!winner) return null
  const calendar = parseEventMarketCalendarEvent(winner)
  if (
    !calendar ||
    isEventMarketAddressableRevisionDeleted(
      {
        coordinate: calendar.coordinate,
        eventId: winner.id,
        createdAt: winner.created_at * 1_000,
      },
      input.deletions ?? []
    )
  ) {
    return null
  }
  return calendar
}

export type EventMarketProductResolution =
  | {
      state:
        | "missing"
        | "unapproved"
        | "untagged"
        | "hidden"
        | "malformed"
        | "deleted"
        | "unauthorized"
    }
  | {
      state: "eligible"
      product: ProductSchema
      revision: SignedPublicNostrEvent
      merchant: EventMarketMerchantRow
    }

/** Author and #a relay filters produce candidates only; current signed terms decide eligibility. */
export function resolveEventMarketProduct(input: {
  market: ParsedEventMarketRoster
  productCoordinate: string
  revisions: readonly SignedPublicNostrEvent[]
  deletions?: readonly SignedPublicNostrEvent[]
  authorization?: EventMarketAuthorizationResolution
}): EventMarketProductResolution {
  const coordinate = parseAddressableCoordinate(input.productCoordinate, [
    EVENT_KINDS.PRODUCT,
  ])
  if (!coordinate) return { state: "malformed" }
  const merchant = input.market.merchants.find(
    (row) => row.pubkey === coordinate.authorPubkey
  )
  if (!merchant) return { state: "unapproved" }
  if (input.authorization?.state !== "active") return { state: "unauthorized" }
  const revisions = input.revisions
    .filter(
      (event) =>
        event.kind === EVENT_KINDS.PRODUCT &&
        event.pubkey === coordinate.authorPubkey &&
        event.tags.some(
          (tag) => tag[0] === "d" && tag[1] === coordinate.dTag
        ) &&
        isValidSignedPublicNostrEvent(event)
    )
    .sort(
      (left, right) =>
        -compareReplaceableEventFrontiers(
          { createdAt: left.created_at, eventId: left.id },
          { createdAt: right.created_at, eventId: right.id }
        )
    )
  const revision = revisions[0]
  if (!revision) return { state: "missing" }
  if (
    isEventMarketAddressableRevisionDeleted(
      {
        coordinate: coordinate.coordinate,
        eventId: revision.id,
        createdAt: revision.created_at * 1_000,
      },
      input.deletions ?? []
    )
  ) {
    return { state: "deleted" }
  }
  if (
    revision.tags.filter((tag) => tag[0] === "d").length !== 1 ||
    revision.tags.filter(
      (tag) => tag[0] === "a" && tag[1] === input.market.coordinate
    ).length !== 1 ||
    !revision.tags.some(
      (tag) => tag[0] === "a" && tag[1] === input.market.coordinate
    )
  ) {
    return { state: "untagged" }
  }
  try {
    const product = parseProductEvent(revision)
    if (product.visibility !== "public") return { state: "hidden" }
    if (product.priceEvidenceMalformed || product.format !== "physical") {
      return { state: "malformed" }
    }
    return { state: "eligible", product, revision, merchant }
  } catch {
    return { state: "malformed" }
  }
}

export function getEventMarketCandidateFilters(
  market: ParsedEventMarketRoster
): Array<{
  kinds: [typeof EVENT_KINDS.PRODUCT]
  authors: string[]
  "#a": [string]
}> {
  const authors = market.merchants.map((row) => row.pubkey)
  if (authors.length === 0) return []
  const result = []
  for (let index = 0; index < authors.length; index += 32) {
    result.push({
      kinds: [EVENT_KINDS.PRODUCT] as [typeof EVENT_KINDS.PRODUCT],
      authors: authors.slice(index, index + 32),
      "#a": [market.coordinate] as [string],
    })
  }
  return result
}
