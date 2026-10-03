import {
  parseAddressableCoordinate,
  type EventMarketEventDraft,
} from "./event-market"
import { EVENT_KINDS } from "./kinds"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

const HEX_64 = /^[0-9a-f]{64}$/
const MAX_SEQUENCE = 2_147_483_647
const PROFILE = "event-market-auth"
const ALT = "Open Markets event merchant authorization"

export type EventMarketAuthorizationState = "active" | "revoked"
export interface EventMarketAuthorizationRepair {
  deletionId: string
  targetId: string
}

export interface ParsedEventMarketAuthorization {
  eventId: string
  signedEvent: SignedPublicNostrEvent
  marketCoordinate: string
  organizerPubkey: string
  merchantPubkey: string
  state: EventMarketAuthorizationState
  sequence: number
  parentIds: string[]
  repairs: EventMarketAuthorizationRepair[]
}

export interface EventMarketAuthorizationDraftInput {
  marketCoordinate: string
  merchantPubkey: string
  state: EventMarketAuthorizationState
  sequence: number
  parentIds: readonly string[]
  repairs?: readonly EventMarketAuthorizationRepair[]
}

export function buildEventMarketAuthorizationDraft(
  input: EventMarketAuthorizationDraftInput
): EventMarketEventDraft {
  const market = parseAddressableCoordinate(input.marketCoordinate, [
    EVENT_KINDS.EVENT_MARKET,
  ])
  const repairs = input.repairs ?? []
  if (
    !market ||
    !HEX_64.test(input.merchantPubkey) ||
    (input.state !== "active" && input.state !== "revoked") ||
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 0 ||
    input.sequence > MAX_SEQUENCE ||
    input.parentIds.length > 8 ||
    new Set(input.parentIds).size !== input.parentIds.length ||
    input.parentIds.some((id) => !HEX_64.test(id)) ||
    (input.parentIds.length === 0) !== (input.sequence === 0) ||
    repairs.some(
      (repair) =>
        !HEX_64.test(repair.deletionId) || !HEX_64.test(repair.targetId)
    ) ||
    new Set(repairs.map((repair) => `${repair.deletionId}:${repair.targetId}`))
      .size !== repairs.length
  ) {
    throw new Error("Event Market authorization is invalid.")
  }
  return {
    kind: EVENT_KINDS.EVENT_MARKET_AUTH,
    content: "",
    tags: [
      ["openmarkets", PROFILE, "1"],
      ["a", market.coordinate],
      ["p", input.merchantPubkey],
      ["state", input.state],
      ["seq", String(input.sequence)],
      ...input.parentIds.map((id) => ["auth_parent", id]),
      ...repairs.map((repair) => [
        "repair",
        repair.deletionId,
        repair.targetId,
      ]),
      ["alt", ALT],
    ],
  }
}

export function parseEventMarketAuthorizationEvent(
  event: SignedPublicNostrEvent
): ParsedEventMarketAuthorization | null {
  if (
    event.kind !== EVENT_KINDS.EVENT_MARKET_AUTH ||
    event.content !== "" ||
    !isValidSignedPublicNostrEvent(event) ||
    new TextEncoder().encode(JSON.stringify(event)).length > 65_536
  )
    return null
  const one = (name: string, length: number): string[] | null => {
    const tags = event.tags.filter((tag) => tag[0] === name)
    return tags.length === 1 && tags[0]?.length === length ? tags[0] : null
  }
  const marker = one("openmarkets", 3)
  const address = one("a", 2)
  const merchant = one("p", 2)
  const state = one("state", 2)
  const seq = one("seq", 2)
  const alt = one("alt", 2)
  const market = parseAddressableCoordinate(address?.[1], [
    EVENT_KINDS.EVENT_MARKET,
  ])
  const parentTags = event.tags.filter((tag) => tag[0] === "auth_parent")
  const parentIds = parentTags.map((tag) => tag[1] ?? "")
  const repairTags = event.tags.filter((tag) => tag[0] === "repair")
  const repairs = repairTags.map((tag) => ({
    deletionId: tag[1] ?? "",
    targetId: tag[2] ?? "",
  }))
  const sequence =
    seq?.[1] && /^(0|[1-9]\d*)$/.test(seq[1]) ? Number(seq[1]) : NaN
  if (
    marker?.[1] !== PROFILE ||
    marker?.[2] !== "1" ||
    !market ||
    market.authorPubkey !== event.pubkey ||
    !HEX_64.test(merchant?.[1] ?? "") ||
    (state?.[1] !== "active" && state?.[1] !== "revoked") ||
    !Number.isSafeInteger(sequence) ||
    sequence > MAX_SEQUENCE ||
    alt?.[1] !== ALT ||
    parentIds.length > 8 ||
    parentTags.some((tag) => tag.length !== 2) ||
    parentIds.some((id) => !HEX_64.test(id) || id === event.id) ||
    new Set(parentIds).size !== parentIds.length ||
    (parentIds.length === 0) !== (sequence === 0) ||
    repairTags.some(
      (tag) =>
        tag.length !== 3 ||
        !HEX_64.test(tag[1] ?? "") ||
        !HEX_64.test(tag[2] ?? "")
    ) ||
    new Set(repairs.map((repair) => `${repair.deletionId}:${repair.targetId}`))
      .size !== repairs.length
  )
    return null
  return {
    eventId: event.id,
    signedEvent: event,
    marketCoordinate: market.coordinate,
    organizerPubkey: event.pubkey,
    merchantPubkey: merchant![1]!,
    state: state![1] as EventMarketAuthorizationState,
    sequence,
    parentIds,
    repairs,
  }
}

export type EventMarketAuthorizationResolution =
  | { state: "invalid_reference" | "missing" | "malformed" | "missing_parent" }
  | {
      state: "deleted_unknown"
      missingTargetIds: string[]
      deletions: SignedPublicNostrEvent[]
    }
  | { state: "deleted"; tips: ParsedEventMarketAuthorization[] }
  | { state: "conflicting"; tips: ParsedEventMarketAuthorization[] }
  | {
      state: "active" | "revoked"
      tip: ParsedEventMarketAuthorization
      ancestry: ParsedEventMarketAuthorization[]
    }

/** Reduce retained signed observations; relay order and timestamps never resolve forks. */
export function resolveEventMarketAuthorization(input: {
  marketCoordinate: string
  merchantPubkey: string
  transitions: readonly SignedPublicNostrEvent[]
  deletions?: readonly SignedPublicNostrEvent[]
}): EventMarketAuthorizationResolution {
  const market = parseAddressableCoordinate(input.marketCoordinate, [
    EVENT_KINDS.EVENT_MARKET,
  ])
  if (!market || !HEX_64.test(input.merchantPubkey))
    return { state: "invalid_reference" }
  const scoped = input.transitions.filter(
    (event) =>
      event.kind === EVENT_KINDS.EVENT_MARKET_AUTH &&
      event.pubkey === market.authorPubkey &&
      event.tags.some(
        (tag) => tag[0] === "a" && tag[1] === market.coordinate
      ) &&
      event.tags.some(
        (tag) => tag[0] === "p" && tag[1] === input.merchantPubkey
      ) &&
      isValidSignedPublicNostrEvent(event)
  )
  const parsed = scoped.map(parseEventMarketAuthorizationEvent)
  if (parsed.some((event) => event === null)) return { state: "malformed" }
  const events = new Map(
    (parsed as ParsedEventMarketAuthorization[]).map((event) => [
      event.eventId,
      event,
    ])
  )
  const deletions = (input.deletions ?? []).filter(
    (event) =>
      event.kind === EVENT_KINDS.DELETION &&
      event.pubkey === market.authorPubkey &&
      isValidSignedPublicNostrEvent(event)
  )
  if (events.size === 0) {
    const scopedDeletions = deletions.filter(
      (deletion) =>
        deletion.tags.some(
          (tag) => tag[0] === "a" && tag[1] === market.coordinate
        ) &&
        deletion.tags.some(
          (tag) => tag[0] === "p" && tag[1] === input.merchantPubkey
        ) &&
        deletion.tags.some((tag) => tag[0] === "e" && HEX_64.test(tag[1] ?? ""))
    )
    if (scopedDeletions.length > 0)
      return {
        state: "deleted_unknown",
        deletions: scopedDeletions,
        missingTargetIds: [
          ...new Set(
            scopedDeletions.flatMap((event) =>
              event.tags
                .filter((tag) => tag[0] === "e" && HEX_64.test(tag[1] ?? ""))
                .map((tag) => tag[1]!)
            )
          ),
        ],
      }
    return { state: "missing" }
  }
  const children = new Set<string>()
  for (const event of events.values()) {
    if (event.parentIds.length === 0 && event.sequence !== 0)
      return { state: "malformed" }
    for (const parentId of event.parentIds) {
      const parent = events.get(parentId)
      if (!parent) return { state: "missing_parent" }
      children.add(parentId)
    }
    if (
      event.parentIds.length > 0 &&
      event.sequence !==
        1 + Math.max(...event.parentIds.map((id) => events.get(id)!.sequence))
    )
      return { state: "malformed" }
  }
  const tips = [...events.values()].filter(
    (event) => !children.has(event.eventId)
  )
  if (tips.length !== 1) return { state: "conflicting", tips }
  const tip = tips[0]!
  const seen = new Set<string>()
  const ancestry: ParsedEventMarketAuthorization[] = []
  const visit = (event: ParsedEventMarketAuthorization): void => {
    if (seen.has(event.eventId)) return
    seen.add(event.eventId)
    for (const parentId of event.parentIds) visit(events.get(parentId)!)
    ancestry.push(event)
  }
  visit(tip)
  if (ancestry.length !== events.size) return { state: "conflicting", tips }
  const descendsFrom = (
    transition: ParsedEventMarketAuthorization,
    targetId: string
  ): boolean =>
    transition.parentIds.some(
      (id) => id === targetId || descendsFrom(events.get(id)!, targetId)
    )
  for (const deletion of deletions) {
    const scopedDeletion =
      deletion.tags.some(
        (tag) => tag[0] === "a" && tag[1] === market.coordinate
      ) &&
      deletion.tags.some(
        (tag) => tag[0] === "p" && tag[1] === input.merchantPubkey
      )
    const targetIds = deletion.tags
      .filter((tag) => tag[0] === "e")
      .map((tag) => tag[1] ?? "")
    for (const targetId of targetIds) {
      if (!events.has(targetId) && !scopedDeletion) continue
      const repaired = ancestry.some(
        (transition) =>
          transition.repairs.some(
            (repair) =>
              repair.deletionId === deletion.id && repair.targetId === targetId
          ) &&
          transition.eventId !== targetId &&
          events.has(targetId) &&
          descendsFrom(transition, targetId)
      )
      if (!repaired) return { state: "deleted", tips }
    }
  }
  return { state: tip.state, tip, ancestry }
}
