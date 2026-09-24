import { parseAddressableCoordinate } from "./event-market"
import { EVENT_KINDS } from "./kinds"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

const HEX_64 = /^[0-9a-f]{64}$/
const MAX_SEQUENCE = 2_147_483_647
const MAX_PARENTS = 8
const MARKER = ["openmarkets", "event-market-auth", "1"]
const ALT = ["alt", "Open Markets event merchant authorization"]

export type EventMarketAuthorizationState = "active" | "revoked"

export interface EventMarketAuthorizationRepair {
  deletionId: string
  targetEventId: string
}

export interface ParsedEventMarketAuthorization {
  eventId: string
  marketCoordinate: string
  merchantPubkey: string
  state: EventMarketAuthorizationState
  sequence: number
  parentIds: string[]
  repairs: EventMarketAuthorizationRepair[]
  signedEvent: SignedPublicNostrEvent
}

export interface EventMarketAuthorizationDraftInput {
  marketCoordinate: string
  merchantPubkey: string
  state: EventMarketAuthorizationState
  parents?: readonly ParsedEventMarketAuthorization[]
  repairs?: readonly EventMarketAuthorizationRepair[]
}

function singleton(
  event: SignedPublicNostrEvent,
  name: string,
  length: number
): string[] | null {
  const tags = event.tags.filter((tag) => tag[0] === name)
  return tags.length === 1 && tags[0]?.length === length ? tags[0] : null
}

function marketScope(marketCoordinate: string, merchantPubkey: string) {
  const market = parseAddressableCoordinate(marketCoordinate, [
    EVENT_KINDS.EVENT_MARKET,
  ])
  return market && HEX_64.test(merchantPubkey) ? market : null
}

/** Produce canonical kind-3841 tags; sequence is derived from validated parents. */
export function buildEventMarketAuthorizationDraft(
  input: EventMarketAuthorizationDraftInput
): {
  kind: typeof EVENT_KINDS.EVENT_MARKET_AUTH
  tags: string[][]
  content: ""
} {
  const market = marketScope(input.marketCoordinate, input.merchantPubkey)
  const parents = input.parents ?? []
  const checkedParents = parents.map((parent) =>
    parseEventMarketAuthorizationEvent(parent.signedEvent)
  )
  const repairs = input.repairs ?? []
  if (
    !market ||
    !["active", "revoked"].includes(input.state) ||
    parents.length > MAX_PARENTS ||
    new Set(parents.map((parent) => parent.eventId)).size !== parents.length ||
    parents.some(
      (parent, index) =>
        !checkedParents[index] ||
        parent.eventId !== checkedParents[index]!.eventId ||
        parent.sequence !== checkedParents[index]!.sequence ||
        checkedParents[index]!.marketCoordinate !== market.coordinate ||
        checkedParents[index]!.merchantPubkey !== input.merchantPubkey
    ) ||
    repairs.some(
      (repair) =>
        !HEX_64.test(repair.deletionId) || !HEX_64.test(repair.targetEventId)
    ) ||
    new Set(
      repairs.map((repair) => `${repair.deletionId}:${repair.targetEventId}`)
    ).size !== repairs.length
  ) {
    throw new Error("Event Market authorization draft is invalid.")
  }
  const sequence =
    parents.length === 0
      ? 0
      : 1 + Math.max(...checkedParents.map((parent) => parent!.sequence))
  if (sequence > MAX_SEQUENCE)
    throw new Error("Event Market authorization sequence exceeds the limit.")
  return {
    kind: EVENT_KINDS.EVENT_MARKET_AUTH,
    tags: [
      [...MARKER],
      ["a", market.coordinate],
      ["p", input.merchantPubkey],
      ["state", input.state],
      ["seq", String(sequence)],
      ...parents.map((parent) => ["auth_parent", parent.eventId]),
      ...repairs.map((repair) => [
        "repair",
        repair.deletionId,
        repair.targetEventId,
      ]),
      [...ALT],
    ],
    content: "",
  }
}

/** Parsing validates the signed envelope and the local shape; the reducer checks parent payloads. */
export function parseEventMarketAuthorizationEvent(
  event: SignedPublicNostrEvent
): ParsedEventMarketAuthorization | null {
  if (
    event.kind !== EVENT_KINDS.EVENT_MARKET_AUTH ||
    event.content !== "" ||
    !isValidSignedPublicNostrEvent(event)
  )
    return null
  const marker = singleton(event, "openmarkets", 3)
  const marketTag = singleton(event, "a", 2)
  const merchantTag = singleton(event, "p", 2)
  const stateTag = singleton(event, "state", 2)
  const sequenceTag = singleton(event, "seq", 2)
  const alt = singleton(event, "alt", 2)
  const market =
    marketTag && marketScope(marketTag[1] ?? "", merchantTag?.[1] ?? "")
  const rawSequence = sequenceTag?.[1] ?? ""
  const sequence = Number(rawSequence)
  const parentTags = event.tags.filter((tag) => tag[0] === "auth_parent")
  const parentIds = parentTags.map((tag) => tag[1] ?? "")
  const repairTags = event.tags.filter((tag) => tag[0] === "repair")
  const repairs = repairTags.map((tag) => ({
    deletionId: tag[1] ?? "",
    targetEventId: tag[2] ?? "",
  }))
  if (
    !marker ||
    marker[1] !== MARKER[1] ||
    marker[2] !== MARKER[2] ||
    !market ||
    market.coordinate !== marketTag?.[1] ||
    market.authorPubkey !== event.pubkey ||
    !merchantTag ||
    !stateTag ||
    (stateTag[1] !== "active" && stateTag[1] !== "revoked") ||
    !sequenceTag ||
    !/^(0|[1-9][0-9]*)$/.test(rawSequence) ||
    !Number.isSafeInteger(sequence) ||
    sequence > MAX_SEQUENCE ||
    !alt ||
    alt[1] !== ALT[1] ||
    parentTags.length > MAX_PARENTS ||
    parentTags.some((tag) => tag.length !== 2) ||
    parentIds.some((id) => !HEX_64.test(id) || id === event.id) ||
    new Set(parentIds).size !== parentIds.length ||
    (parentIds.length === 0 && sequence !== 0) ||
    (parentIds.length > 0 && sequence === 0) ||
    repairTags.some((tag) => tag.length !== 3) ||
    repairs.some(
      (repair) =>
        !HEX_64.test(repair.deletionId) || !HEX_64.test(repair.targetEventId)
    ) ||
    new Set(
      repairs.map((repair) => `${repair.deletionId}:${repair.targetEventId}`)
    ).size !== repairs.length
  )
    return null
  return {
    eventId: event.id,
    marketCoordinate: market.coordinate,
    merchantPubkey: merchantTag[1],
    state: stateTag[1],
    sequence,
    parentIds,
    repairs,
    signedEvent: event,
  }
}

interface AuthorizationEvidence {
  tip: ParsedEventMarketAuthorization
  ancestry: SignedPublicNostrEvent[]
  deletions: SignedPublicNostrEvent[]
}

export type EventMarketAuthorizationResolution =
  | { state: "invalid_reference" | "missing" | "malformed" }
  | { state: "missing_parent"; missingParentIds: string[] }
  | { state: "conflicting"; tips: ParsedEventMarketAuthorization[] }
  | ({ state: "deleted" | "revoked" | "active" } & AuthorizationEvidence)

/** Resolve only observed, signed evidence; relay silence cannot remove a branch or deletion. */
export function resolveEventMarketAuthorization(input: {
  marketCoordinate: string
  merchantPubkey: string
  transitions: readonly SignedPublicNostrEvent[]
  deletions?: readonly SignedPublicNostrEvent[]
}): EventMarketAuthorizationResolution {
  const market = marketScope(input.marketCoordinate, input.merchantPubkey)
  if (!market || market.coordinate !== input.marketCoordinate)
    return { state: "invalid_reference" }
  const candidates = [
    ...new Map(
      input.transitions
        .filter(
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
        .map((event) => [event.id, event])
    ).values(),
  ]
  if (candidates.length === 0) return { state: "missing" }
  const parsed = candidates.map(parseEventMarketAuthorizationEvent)
  if (parsed.some((event) => !event)) return { state: "malformed" }
  const transitions = parsed as ParsedEventMarketAuthorization[]
  const byId = new Map(transitions.map((event) => [event.eventId, event]))
  const missingParentIds = [
    ...new Set(
      transitions.flatMap((event) =>
        event.parentIds.filter((id) => !byId.has(id))
      )
    ),
  ]
  if (missingParentIds.length > 0)
    return { state: "missing_parent", missingParentIds }
  for (const event of transitions) {
    const parents = event.parentIds.map((id) => byId.get(id)!)
    if (
      parents.some(
        (parent) =>
          parent.marketCoordinate !== market.coordinate ||
          parent.merchantPubkey !== input.merchantPubkey ||
          parent.sequence >= event.sequence
      ) ||
      event.sequence !==
        (parents.length === 0
          ? 0
          : 1 + Math.max(...parents.map((parent) => parent.sequence)))
    )
      return { state: "malformed" }
  }
  const parentIds = new Set(transitions.flatMap((event) => event.parentIds))
  const tips = transitions.filter((event) => !parentIds.has(event.eventId))
  if (tips.length !== 1) return { state: "conflicting", tips }
  const tip = tips[0]!
  const ancestryById = new Map<string, ParsedEventMarketAuthorization>()
  const visit = (event: ParsedEventMarketAuthorization) => {
    if (ancestryById.has(event.eventId)) return
    ancestryById.set(event.eventId, event)
    for (const id of event.parentIds) visit(byId.get(id)!)
  }
  visit(tip)
  // Disconnected roots or branches are observed competing tips, even if both say active.
  if (ancestryById.size !== transitions.length)
    return {
      state: "conflicting",
      tips: transitions
        .filter((event) => !ancestryById.has(event.eventId))
        .concat(tip),
    }
  const ancestry = [...ancestryById.values()].map((event) => event.signedEvent)
  const deletions = [
    ...new Map(
      (input.deletions ?? [])
        .filter(
          (event) =>
            event.kind === EVENT_KINDS.DELETION &&
            event.pubkey === market.authorPubkey &&
            isValidSignedPublicNostrEvent(event) &&
            event.tags.some(
              (tag) => tag[0] === "e" && HEX_64.test(tag[1] ?? "")
            ) &&
            (event.tags.some(
              (tag) => tag[0] === "e" && byId.has(tag[1] ?? "")
            ) ||
              (event.tags.some(
                (tag) => tag[0] === "a" && tag[1] === market.coordinate
              ) &&
                event.tags.some(
                  (tag) => tag[0] === "p" && tag[1] === input.merchantPubkey
                )))
        )
        .map((event) => [event.id, event])
    ).values(),
  ]
  const unresolvedDeletion = deletions.some((deletion) =>
    deletion.tags
      .filter(
        (tag) =>
          tag[0] === "e" &&
          (byId.has(tag[1] ?? "") ||
            (deletion.tags.some(
              (scope) => scope[0] === "a" && scope[1] === market.coordinate
            ) &&
              deletion.tags.some(
                (scope) => scope[0] === "p" && scope[1] === input.merchantPubkey
              )))
      )
      .some((tag) => {
        const targetId = tag[1] ?? ""
        if (!byId.has(targetId)) return true
        return ![...ancestryById.values()].some(
          (transition) =>
            transition.eventId !== targetId &&
            transition.repairs.some(
              (repair) =>
                repair.deletionId === deletion.id &&
                repair.targetEventId === targetId
            ) &&
            descendsFrom(transition, targetId, byId)
        )
      })
  )
  if (unresolvedDeletion) return { state: "deleted", tip, ancestry, deletions }
  return { state: tip.state, tip, ancestry, deletions }
}

function descendsFrom(
  event: ParsedEventMarketAuthorization,
  ancestorId: string,
  byId: ReadonlyMap<string, ParsedEventMarketAuthorization>
): boolean {
  return event.parentIds.some(
    (id) => id === ancestorId || descendsFrom(byId.get(id)!, ancestorId, byId)
  )
}
