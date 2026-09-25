import {
  isEventMarketAddressableRevisionDeleted,
  parseAddressableCoordinate,
  parseEventMarketCalendarEvent,
  type EventMarketEventDraft,
  type ParsedEventMarketCalendar,
} from "./event-market"
import { EVENT_KINDS } from "./kinds"
import {
  compareReplaceableEventFrontiers,
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

const CONTROL_CHARACTER = /\p{Cc}/u
const MAX_MEMBERS = 256
const MAX_SIGNED_BYTES = 65_536

export interface ParsedEventMarketSeries {
  coordinate: string
  organizerPubkey: string
  eventId: string
  createdAt: number
  title: string
  memberCoordinates: string[]
  signedEvent: SignedPublicNostrEvent
}

export type EventMarketSeriesResolution =
  | { state: "missing" }
  | { state: "deleted" | "malformed"; eventId: string }
  | { state: "current"; series: ParsedEventMarketSeries }

export type EventMarketSchedule =
  | {
      kind: "single"
      coordinate: string
      occurrence: ParsedEventMarketCalendar
      occurrenceEvent: SignedPublicNostrEvent
    }
  | {
      kind: "series"
      coordinate: string
      series: ParsedEventMarketSeries
      occurrences: Array<{
        occurrence: ParsedEventMarketCalendar
        occurrenceEvent: SignedPublicNostrEvent
        coverage: "complete" | "partial" | "stale" | "unavailable"
      }>
      unresolvedCoordinates: string[]
    }

function validDTag(value: string): boolean {
  return (
    value.length > 0 &&
    new TextEncoder().encode(value).length <= 128 &&
    !CONTROL_CHARACTER.test(value)
  )
}

function validTitle(value: string): boolean {
  return (
    value.trim() === value &&
    value.length > 0 &&
    new TextEncoder().encode(value).length <= 200 &&
    !CONTROL_CHARACTER.test(value)
  )
}

function memberCoordinates(
  values: readonly string[],
  organizerPubkey: string
): string[] | null {
  if (values.length === 0 || values.length > MAX_MEMBERS) return null
  const parsed = values.map((value) =>
    parseAddressableCoordinate(value, [
      EVENT_KINDS.CALENDAR_DATE,
      EVENT_KINDS.CALENDAR_TIME,
    ])
  )
  if (
    parsed.some((value) => !value || value.authorPubkey !== organizerPubkey) ||
    new Set(values).size !== values.length
  )
    return null
  return parsed.map((value) => value!.coordinate)
}

/** A finite list of ordinary NIP-52 event coordinates; no recurrence rule is stored. */
export function buildEventMarketSeriesDraft(input: {
  dTag: string
  organizerPubkey: string
  title: string
  memberCoordinates: readonly string[]
}): EventMarketEventDraft {
  const members = memberCoordinates(
    input.memberCoordinates,
    input.organizerPubkey
  )
  if (!validDTag(input.dTag) || !validTitle(input.title) || !members)
    throw new Error("Event Market schedule is invalid.")
  const draft = {
    kind: EVENT_KINDS.CALENDAR,
    content: "",
    tags: [
      ["d", input.dTag],
      ["title", input.title],
      ...members.map((coordinate) => ["a", coordinate]),
    ],
  }
  if (
    new TextEncoder().encode(JSON.stringify(draft)).length >
    MAX_SIGNED_BYTES - 512
  )
    throw new Error("Event Market schedule exceeds the public size limit.")
  return draft
}

export function parseEventMarketSeriesEvent(
  event: SignedPublicNostrEvent
): ParsedEventMarketSeries | null {
  if (
    event.kind !== EVENT_KINDS.CALENDAR ||
    !isValidSignedPublicNostrEvent(event) ||
    new TextEncoder().encode(JSON.stringify(event)).length > MAX_SIGNED_BYTES
  )
    return null
  const d = event.tags.filter((tag) => tag[0] === "d")
  const title = event.tags.filter((tag) => tag[0] === "title")
  const refs = event.tags.filter((tag) => tag[0] === "a")
  if (
    d.length !== 1 ||
    d[0]?.length !== 2 ||
    !validDTag(d[0][1] ?? "") ||
    title.length !== 1 ||
    title[0]?.length !== 2 ||
    !validTitle(title[0][1] ?? "") ||
    refs.some((tag) => tag.length < 2 || tag.length > 3)
  )
    return null
  const members = memberCoordinates(
    refs.map((tag) => tag[1] ?? ""),
    event.pubkey
  )
  if (!members) return null
  return {
    coordinate: `${EVENT_KINDS.CALENDAR}:${event.pubkey}:${d[0][1]}`,
    organizerPubkey: event.pubkey,
    eventId: event.id,
    createdAt: event.created_at * 1_000,
    title: title[0][1]!,
    memberCoordinates: members,
    signedEvent: event,
  }
}

export function resolveEventMarketSeries(input: {
  coordinate: string
  organizerPubkey: string
  revisions: readonly SignedPublicNostrEvent[]
  deletions?: readonly SignedPublicNostrEvent[]
}): EventMarketSeriesResolution {
  const coordinate = parseAddressableCoordinate(input.coordinate, [
    EVENT_KINDS.CALENDAR,
  ])
  if (!coordinate || coordinate.authorPubkey !== input.organizerPubkey)
    return { state: "missing" }
  const winner = input.revisions
    .filter(
      (event) =>
        event.kind === EVENT_KINDS.CALENDAR &&
        event.pubkey === input.organizerPubkey &&
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
    )[0]
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
  )
    return { state: "deleted", eventId: winner.id }
  const series = parseEventMarketSeriesEvent(winner)
  return series && series.coordinate === coordinate.coordinate
    ? { state: "current", series }
    : { state: "malformed", eventId: winner.id }
}

export function resolveEventMarketOccurrence(input: {
  coordinate: string
  organizerPubkey: string
  revisions: readonly SignedPublicNostrEvent[]
  deletions?: readonly SignedPublicNostrEvent[]
}): {
  occurrence: ParsedEventMarketCalendar
  signedEvent: SignedPublicNostrEvent
} | null {
  const coordinate = parseAddressableCoordinate(input.coordinate, [
    EVENT_KINDS.CALENDAR_DATE,
    EVENT_KINDS.CALENDAR_TIME,
  ])
  if (!coordinate || coordinate.authorPubkey !== input.organizerPubkey)
    return null
  const winner = input.revisions
    .filter(
      (event) =>
        event.kind === coordinate.kind &&
        event.pubkey === input.organizerPubkey &&
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
    )[0]
  if (!winner) return null
  if (
    isEventMarketAddressableRevisionDeleted(
      {
        coordinate: coordinate.coordinate,
        eventId: winner.id,
        createdAt: winner.created_at * 1_000,
      },
      input.deletions ?? []
    )
  )
    return null
  const occurrence = parseEventMarketCalendarEvent(winner)
  return occurrence?.coordinate === coordinate.coordinate
    ? { occurrence, signedEvent: winner }
    : null
}
