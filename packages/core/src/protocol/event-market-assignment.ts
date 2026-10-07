import { sha256 } from "@noble/hashes/sha2.js"
import type { ProductSchema } from "../schemas"
import {
  parseAddressableCoordinate,
  type EventMarketEventDraft,
} from "./event-market"
import { EVENT_KINDS } from "./kinds"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

const ASSIGNMENT_KIND = 30_410
const HEX_64 = /^[0-9a-f]{64}$/
const MAX_ALLOCATION = 2_147_483_647
const MAX_EVENT_BYTES = 65_536
const PROFILE = "event-market-assignment"
const ALT = "Open Markets occurrence product assignment"

export type EventMarketAssignmentState = "active" | "removed"
export type EventMarketAssignmentFulfillment = "pickup" | "shipping" | "digital"
export type EventMarketAssignmentInventory =
  { mode: "tracked"; quantity: number } | { mode: "untracked" }

export interface EventMarketAssignmentTuple {
  marketCoordinate: string
  occurrenceCoordinate: string
  productCoordinate: string
}

export interface EventMarketAssignmentRelayHints {
  market?: string
  occurrence?: string
  product?: string
}

export interface EventMarketAssignmentDraftInput extends EventMarketAssignmentTuple {
  merchantPubkey: string
  state: EventMarketAssignmentState
  inventory: EventMarketAssignmentInventory
  fulfillmentMethods: readonly EventMarketAssignmentFulfillment[]
  previousEventId?: string
  relayHints?: EventMarketAssignmentRelayHints
}

export interface ParsedEventMarketAssignment extends EventMarketAssignmentTuple {
  coordinate: string
  dTag: string
  eventId: string
  createdAt: number
  organizerPubkey: string
  merchantPubkey: string
  state: EventMarketAssignmentState
  inventory: EventMarketAssignmentInventory
  fulfillmentMethods: EventMarketAssignmentFulfillment[]
  previousEventId?: string
  relayHints: EventMarketAssignmentRelayHints
  /** The signed record retains optional display and source tags. */
  signedEvent: SignedPublicNostrEvent
}

function parseCanonicalCoordinate(value: string, kinds: readonly number[]) {
  const parsed = parseAddressableCoordinate(value, kinds)
  return parsed?.coordinate === value ? parsed : null
}

function parseTuple(input: EventMarketAssignmentTuple) {
  const market = parseCanonicalCoordinate(input.marketCoordinate, [
    EVENT_KINDS.EVENT_MARKET,
  ])
  const occurrence = parseCanonicalCoordinate(input.occurrenceCoordinate, [
    EVENT_KINDS.CALENDAR_DATE,
    EVENT_KINDS.CALENDAR_TIME,
  ])
  const product = parseCanonicalCoordinate(input.productCoordinate, [
    EVENT_KINDS.PRODUCT,
  ])
  if (
    !market ||
    !occurrence ||
    !product ||
    market.authorPubkey !== occurrence.authorPubkey
  )
    return null
  return { market, occurrence, product }
}

function tupleHash(tuple: EventMarketAssignmentTuple): string {
  const serialized = JSON.stringify([
    tuple.marketCoordinate,
    tuple.occurrenceCoordinate,
    tuple.productCoordinate,
  ])
  return Array.from(sha256(new TextEncoder().encode(serialized)), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}

/** NIP-01 compact JSON bytes, with no Unicode normalization. */
export function computeEventMarketAssignmentDTag(
  tuple: EventMarketAssignmentTuple
): string {
  if (!parseTuple(tuple))
    throw new Error("Invalid occurrence assignment tuple.")
  return tupleHash(tuple)
}

function validRelayHint(value: string | undefined): boolean {
  if (value === undefined) return true
  if (!value || value.trim() !== value) return false
  try {
    const url = new URL(value)
    return (
      (url.protocol === "wss:" || url.protocol === "ws:") &&
      !!url.hostname &&
      !url.username &&
      !url.password &&
      !url.hash
    )
  } catch {
    return false
  }
}

function validInventory(inventory: EventMarketAssignmentInventory): boolean {
  return inventory.mode === "untracked"
    ? !("quantity" in inventory)
    : inventory.mode === "tracked" &&
        Number.isInteger(inventory.quantity) &&
        inventory.quantity >= 0 &&
        inventory.quantity <= MAX_ALLOCATION
}

function validFulfillment(
  methods: readonly string[],
  state: EventMarketAssignmentState,
  inventory: EventMarketAssignmentInventory
): boolean {
  if (
    methods.some(
      (method) =>
        method !== "pickup" && method !== "shipping" && method !== "digital"
    ) ||
    new Set(methods).size !== methods.length
  )
    return false
  if (state === "removed")
    return (
      methods.length === 0 &&
      (inventory.mode === "untracked" || inventory.quantity === 0)
    )
  return (
    methods.length > 0 &&
    (inventory.mode !== "tracked" ||
      inventory.quantity === 0 ||
      methods.includes("pickup"))
  )
}

export function buildEventMarketAssignmentDraft(
  input: EventMarketAssignmentDraftInput
): EventMarketEventDraft {
  const tuple = parseTuple(input)
  if (
    !tuple ||
    tuple.product.authorPubkey !== input.merchantPubkey ||
    (input.state !== "active" && input.state !== "removed") ||
    !validInventory(input.inventory) ||
    !validFulfillment(input.fulfillmentMethods, input.state, input.inventory) ||
    (input.previousEventId !== undefined &&
      !HEX_64.test(input.previousEventId)) ||
    !validRelayHint(input.relayHints?.market) ||
    !validRelayHint(input.relayHints?.occurrence) ||
    !validRelayHint(input.relayHints?.product)
  )
    throw new Error("Event Market occurrence assignment is invalid.")
  const reference = (coordinate: string, hint?: string) =>
    hint ? ["a", coordinate, hint] : ["a", coordinate]
  return {
    kind: ASSIGNMENT_KIND,
    content: "",
    tags: [
      ["d", tupleHash(input)],
      ["openmarkets", PROFILE, "1"],
      reference(input.marketCoordinate, input.relayHints?.market),
      reference(input.occurrenceCoordinate, input.relayHints?.occurrence),
      reference(input.productCoordinate, input.relayHints?.product),
      ["state", input.state],
      input.inventory.mode === "tracked"
        ? ["inventory", "tracked", String(input.inventory.quantity)]
        : ["inventory", "untracked"],
      ...input.fulfillmentMethods.map((method) => ["fulfillment", method]),
      ...(input.previousEventId ? [["prev", input.previousEventId]] : []),
      ["alt", ALT],
    ],
  }
}

export function parseEventMarketAssignmentEvent(
  event: SignedPublicNostrEvent
): ParsedEventMarketAssignment | null {
  if (
    event.kind !== ASSIGNMENT_KIND ||
    event.content !== "" ||
    !isValidSignedPublicNostrEvent(event) ||
    new TextEncoder().encode(JSON.stringify(event)).length > MAX_EVENT_BYTES
  )
    return null

  const one = (name: string, length: number): string[] | null => {
    const tags = event.tags.filter((tag) => tag[0] === name)
    return tags.length === 1 && tags[0]?.length === length ? tags[0] : null
  }
  const d = one("d", 2)
  const marker = one("openmarkets", 3)
  const stateTag = one("state", 2)
  const inventoryTags = event.tags.filter((tag) => tag[0] === "inventory")
  const alt = one("alt", 2)
  const prevTags = event.tags.filter((tag) => tag[0] === "prev")
  const addressTags = event.tags.filter((tag) => tag[0] === "a")
  const fulfillmentTags = event.tags.filter((tag) => tag[0] === "fulfillment")
  if (
    !HEX_64.test(d?.[1] ?? "") ||
    marker?.[1] !== PROFILE ||
    marker?.[2] !== "1" ||
    (stateTag?.[1] !== "active" && stateTag?.[1] !== "removed") ||
    inventoryTags.length !== 1 ||
    alt?.[1] !== ALT ||
    prevTags.length > 1 ||
    (prevTags.length === 1 &&
      (prevTags[0]?.length !== 2 ||
        !HEX_64.test(prevTags[0]?.[1] ?? "") ||
        prevTags[0]?.[1] === event.id)) ||
    addressTags.length !== 3 ||
    addressTags.some(
      (tag) => (tag.length !== 2 && tag.length !== 3) || !validRelayHint(tag[2])
    ) ||
    fulfillmentTags.some((tag) => tag.length !== 2)
  )
    return null

  const references = addressTags.map((tag) => ({
    coordinate: tag[1] ?? "",
    hint: tag[2],
  }))
  const market = references.filter((ref) => ref.coordinate.startsWith("30409:"))
  const occurrence = references.filter(
    (ref) =>
      ref.coordinate.startsWith("31922:") || ref.coordinate.startsWith("31923:")
  )
  const product = references.filter((ref) =>
    ref.coordinate.startsWith("30402:")
  )
  if (market.length !== 1 || occurrence.length !== 1 || product.length !== 1)
    return null
  const tuple = {
    marketCoordinate: market[0]!.coordinate,
    occurrenceCoordinate: occurrence[0]!.coordinate,
    productCoordinate: product[0]!.coordinate,
  }
  const coordinates = parseTuple(tuple)
  if (
    !coordinates ||
    coordinates.product.authorPubkey !== event.pubkey ||
    tupleHash(tuple) !== d![1]
  )
    return null

  const inventoryTag = inventoryTags[0]!
  const quantityText = inventoryTag[2]
  const inventory: EventMarketAssignmentInventory =
    inventoryTag[1] === "tracked" &&
    inventoryTag.length === 3 &&
    /^(0|[1-9][0-9]*)$/.test(quantityText ?? "") &&
    Number(quantityText) <= MAX_ALLOCATION
      ? { mode: "tracked", quantity: Number(quantityText) }
      : { mode: "untracked" }
  if (
    (inventoryTag[1] === "tracked" && inventory.mode !== "tracked") ||
    (inventoryTag[1] === "untracked" && inventoryTag.length !== 2) ||
    (inventoryTag[1] !== "tracked" && inventoryTag[1] !== "untracked")
  )
    return null
  const state = stateTag![1] as EventMarketAssignmentState
  const fulfillmentMethods = fulfillmentTags.map(
    (tag) => tag[1] ?? ""
  ) as EventMarketAssignmentFulfillment[]
  if (!validFulfillment(fulfillmentMethods, state, inventory)) return null
  return {
    ...tuple,
    coordinate: String(ASSIGNMENT_KIND) + ":" + event.pubkey + ":" + d![1],
    dTag: d![1]!,
    eventId: event.id,
    createdAt: event.created_at,
    organizerPubkey: coordinates.market.authorPubkey,
    merchantPubkey: event.pubkey,
    state,
    inventory,
    fulfillmentMethods,
    ...(prevTags[0] ? { previousEventId: prevTags[0][1] } : {}),
    relayHints: {
      ...(market[0]!.hint ? { market: market[0]!.hint } : {}),
      ...(occurrence[0]!.hint ? { occurrence: occurrence[0]!.hint } : {}),
      ...(product[0]!.hint ? { product: product[0]!.hint } : {}),
    },
    signedEvent: event,
  }
}

/** Product-local suitability; caller resolves current signed product and parent evidence. */
export function isEventMarketAssignmentProductSuitable(input: {
  assignment: ParsedEventMarketAssignment
  product: ProductSchema
  parentProduct?: ProductSchema
}): boolean {
  const { assignment, product, parentProduct } = input
  if (
    assignment.state !== "active" ||
    product.id !== assignment.productCoordinate ||
    product.pubkey !== assignment.merchantPubkey ||
    product.visibility !== "public" ||
    product.type === "variable" ||
    (assignment.inventory.mode === "tracked"
      ? product.stock === undefined ||
        !Number.isInteger(product.stock) ||
        product.stock < assignment.inventory.quantity
      : product.stock !== undefined)
  )
    return false
  if (product.type === "variation") {
    const parent = parseCanonicalCoordinate(product.parentProductId ?? "", [
      EVENT_KINDS.PRODUCT,
    ])
    if (
      !parent ||
      parent.authorPubkey !== assignment.merchantPubkey ||
      parentProduct?.id !== parent.coordinate ||
      parentProduct.pubkey !== assignment.merchantPubkey ||
      parentProduct.type !== "variable" ||
      parentProduct.visibility !== "public"
    )
      return false
  }
  return product.format === "digital"
    ? assignment.fulfillmentMethods.length === 1 &&
        assignment.fulfillmentMethods[0] === "digital"
    : !assignment.fulfillmentMethods.includes("digital")
}
