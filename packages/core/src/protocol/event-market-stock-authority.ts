import { getEventHash } from "nostr-tools"
import { parseAddressableCoordinate } from "./event-market"
import {
  assertPrivateMessageFitsTransport,
  createPrivateMessageRumor,
  type PrivateMessageEvent,
  type PrivateMessageRumor,
} from "./private-message-primitives"
import { isValidNostrPublicKey } from "./signed-event"
import {
  EVENT_MARKET_STOCK_AUTHORITY_MARKER,
  EVENT_MARKET_STOCK_AUTHORITY_SUBJECT,
} from "./event-market-stock-marker"

export {
  EVENT_MARKET_STOCK_AUTHORITY_SUBJECT,
  isEventMarketStockAuthorityRumor,
} from "./event-market-stock-marker"

/** Conduit-private stock delegation; not an Open Markets public event profile. */
const MARKER = EVENT_MARKET_STOCK_AUTHORITY_MARKER
const MAX_STOCK = 2_147_483_647
const HEX_64 = /^[0-9a-f]{64}$/
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MAX_PAYLOAD_BYTES = 16_384

interface EventMarketStockAuthorityParties {
  readonly version: 1
  readonly merchantPubkey: string
  readonly organizerPubkey: string
  /** Exclusive organizer device/writer incarnation, not a distributed lease. */
  readonly writerId: string
}

export interface EventMarketStockGrant extends EventMarketStockAuthorityParties {
  readonly type: "grant"
  readonly nonce: string
  readonly productCoordinate: string
  readonly assignmentCoordinate: string
  readonly marketCoordinate: string
  readonly occurrenceCoordinate: string
  readonly productEventId: string
  readonly assignmentEventId: string
  readonly marketEventId: string
  readonly occurrenceEventId: string
  /** The organizer's existing public merchant-admission transition. */
  readonly grantEventId: string
  readonly scheduleEventId?: string
  readonly quantity: number
  readonly expiresAtMs: number
}

export interface EventMarketStockAcceptance extends EventMarketStockAuthorityParties {
  readonly type: "accepted"
  /** The original Merchant-authored stock-grant rumor hash. */
  readonly poolId: string
  readonly sequence: number
  readonly previousId: string
  readonly orderId: string
  readonly identityBinding: string
  readonly termsBinding: string
  readonly claimRef: string
  readonly quantity: number
  readonly acceptedAtMs: number
}

export interface EventMarketStockClose extends EventMarketStockAuthorityParties {
  readonly type: "closed"
  readonly poolId: string
  /** Number of accepted records; zero is an unused pool. */
  readonly sequence: number
  readonly lastAcceptedId: string
  readonly acceptedQuantity: number
}

export interface EventMarketStockHandout extends EventMarketStockAuthorityParties {
  readonly type: "handed_out"
  readonly orderId: string
  readonly identityBinding: string
  readonly termsBinding: string
  readonly claimRef: string
  readonly entries: readonly {
    readonly poolId: string
    readonly acceptedId: string
    readonly quantity: number
  }[]
  readonly handedOutAtMs: number
}

export type EventMarketStockAuthorityPayload =
  | EventMarketStockGrant
  | EventMarketStockAcceptance
  | EventMarketStockClose
  | EventMarketStockHandout

function invalid(): never {
  throw new Error("Event Market stock authority is invalid.")
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[]
): void {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (
    actual.length !== expected.length ||
    actual.some((key, i) => key !== expected[i])
  )
    invalid()
}

function count(value: unknown, positive = false): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= (positive ? 1 : 0) &&
    value <= MAX_STOCK
  )
}

function time(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function hash(value: unknown): value is string {
  return typeof value === "string" && HEX_64.test(value)
}

function coordinate(
  value: unknown,
  kind: readonly number[],
  author: string
): string {
  if (typeof value !== "string") return invalid()
  const parsed = parseAddressableCoordinate(value, kind)
  if (!parsed || parsed.coordinate !== value || parsed.authorPubkey !== author)
    return invalid()
  return value
}

function parsePayload(value: unknown): EventMarketStockAuthorityPayload {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid()
  const input = value as Record<string, unknown>
  const { merchantPubkey, organizerPubkey, writerId } = input
  if (
    input.version !== 1 ||
    typeof merchantPubkey !== "string" ||
    !isValidNostrPublicKey(merchantPubkey) ||
    !HEX_64.test(merchantPubkey) ||
    typeof organizerPubkey !== "string" ||
    !isValidNostrPublicKey(organizerPubkey) ||
    !HEX_64.test(organizerPubkey) ||
    merchantPubkey === organizerPubkey ||
    typeof writerId !== "string" ||
    !UUID_V4.test(writerId)
  )
    return invalid()
  const common = {
    version: 1 as const,
    merchantPubkey,
    organizerPubkey,
    writerId,
  }
  const commonKeys = [
    "type",
    "version",
    "merchantPubkey",
    "organizerPubkey",
    "writerId",
  ]
  if (input.type === "grant") {
    exactKeys(input, [
      ...commonKeys,
      "nonce",
      "productCoordinate",
      "assignmentCoordinate",
      "marketCoordinate",
      "occurrenceCoordinate",
      "productEventId",
      "assignmentEventId",
      "marketEventId",
      "occurrenceEventId",
      "grantEventId",
      ...(Object.hasOwn(input, "scheduleEventId") ? ["scheduleEventId"] : []),
      "quantity",
      "expiresAtMs",
    ])
    if (
      typeof input.nonce !== "string" ||
      !UUID_V4.test(input.nonce) ||
      ![
        input.productEventId,
        input.assignmentEventId,
        input.marketEventId,
        input.occurrenceEventId,
        input.grantEventId,
      ].every(hash) ||
      (Object.hasOwn(input, "scheduleEventId") &&
        !hash(input.scheduleEventId)) ||
      !count(input.quantity, true) ||
      !time(input.expiresAtMs)
    )
      return invalid()
    return Object.freeze({
      ...common,
      type: "grant",
      nonce: input.nonce,
      productCoordinate: coordinate(
        input.productCoordinate,
        [30_402],
        merchantPubkey
      ),
      assignmentCoordinate: coordinate(
        input.assignmentCoordinate,
        [30_410],
        merchantPubkey
      ),
      marketCoordinate: coordinate(
        input.marketCoordinate,
        [30_409],
        organizerPubkey
      ),
      occurrenceCoordinate: coordinate(
        input.occurrenceCoordinate,
        [31_922, 31_923],
        organizerPubkey
      ),
      productEventId: input.productEventId as string,
      assignmentEventId: input.assignmentEventId as string,
      marketEventId: input.marketEventId as string,
      occurrenceEventId: input.occurrenceEventId as string,
      grantEventId: input.grantEventId as string,
      ...(typeof input.scheduleEventId === "string"
        ? { scheduleEventId: input.scheduleEventId }
        : {}),
      quantity: input.quantity,
      expiresAtMs: input.expiresAtMs,
    })
  }
  if (input.type === "accepted") {
    exactKeys(input, [
      ...commonKeys,
      "poolId",
      "sequence",
      "previousId",
      "orderId",
      "identityBinding",
      "termsBinding",
      "claimRef",
      "quantity",
      "acceptedAtMs",
    ])
    if (
      ![
        input.poolId,
        input.previousId,
        input.identityBinding,
        input.termsBinding,
        input.claimRef,
      ].every(hash) ||
      !count(input.sequence, true) ||
      !count(input.quantity, true) ||
      !time(input.acceptedAtMs) ||
      typeof input.orderId !== "string" ||
      input.orderId.length === 0 ||
      input.orderId.length > 512 ||
      input.orderId.trim() !== input.orderId ||
      /\p{Cc}/u.test(input.orderId) ||
      (input.sequence === 1
        ? input.previousId !== input.poolId
        : input.previousId === input.poolId)
    )
      return invalid()
    return Object.freeze({
      ...common,
      type: "accepted",
      poolId: input.poolId as string,
      sequence: input.sequence,
      previousId: input.previousId as string,
      orderId: input.orderId,
      identityBinding: input.identityBinding as string,
      termsBinding: input.termsBinding as string,
      claimRef: input.claimRef as string,
      quantity: input.quantity,
      acceptedAtMs: input.acceptedAtMs,
    })
  }
  if (input.type === "handed_out") {
    exactKeys(input, [
      ...commonKeys,
      "orderId",
      "identityBinding",
      "termsBinding",
      "claimRef",
      "entries",
      "handedOutAtMs",
    ])
    if (
      typeof input.orderId !== "string" ||
      !input.orderId ||
      input.orderId.length > 512 ||
      input.orderId.trim() !== input.orderId ||
      /\p{Cc}/u.test(input.orderId) ||
      ![input.identityBinding, input.termsBinding, input.claimRef].every(
        hash
      ) ||
      !time(input.handedOutAtMs) ||
      !Array.isArray(input.entries) ||
      input.entries.length < 1 ||
      input.entries.length > 128
    )
      return invalid()
    const entries = input.entries.map((entry: unknown) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        return invalid()
      const item = entry as Record<string, unknown>
      exactKeys(item, ["poolId", "acceptedId", "quantity"])
      if (
        !hash(item.poolId) ||
        !hash(item.acceptedId) ||
        !count(item.quantity, true)
      )
        return invalid()
      return Object.freeze({
        poolId: item.poolId,
        acceptedId: item.acceptedId,
        quantity: item.quantity,
      })
    })
    if (
      new Set(entries.map((entry) => entry.acceptedId)).size !==
        entries.length ||
      entries.some(
        (entry, index) =>
          index > 0 && entries[index - 1]!.poolId >= entry.poolId
      )
    )
      return invalid()
    return Object.freeze({
      ...common,
      type: "handed_out",
      orderId: input.orderId,
      identityBinding: input.identityBinding as string,
      termsBinding: input.termsBinding as string,
      claimRef: input.claimRef as string,
      entries: Object.freeze(entries),
      handedOutAtMs: input.handedOutAtMs,
    })
  }
  if (input.type === "closed") {
    exactKeys(input, [
      ...commonKeys,
      "poolId",
      "sequence",
      "lastAcceptedId",
      "acceptedQuantity",
    ])
    if (
      !hash(input.poolId) ||
      !hash(input.lastAcceptedId) ||
      !count(input.sequence) ||
      !count(input.acceptedQuantity) ||
      (input.sequence === 0
        ? input.lastAcceptedId !== input.poolId || input.acceptedQuantity !== 0
        : input.lastAcceptedId === input.poolId ||
          input.acceptedQuantity < input.sequence)
    )
      return invalid()
    return Object.freeze({
      ...common,
      type: "closed",
      poolId: input.poolId,
      sequence: input.sequence,
      lastAcceptedId: input.lastAcceptedId,
      acceptedQuantity: input.acceptedQuantity,
    })
  }
  return invalid()
}

function parties(payload: EventMarketStockAuthorityPayload) {
  return payload.type === "grant"
    ? { sender: payload.merchantPubkey, recipient: payload.organizerPubkey }
    : { sender: payload.organizerPubkey, recipient: payload.merchantPubkey }
}

function assertTimeBinding(
  payload: EventMarketStockAuthorityPayload,
  createdAt: number
): void {
  if (!time(createdAt) || !Number.isSafeInteger(createdAt * 1_000)) invalid()
  if (payload.type === "grant" && payload.expiresAtMs <= createdAt * 1_000)
    invalid()
  if (
    payload.type === "accepted" &&
    Math.floor(payload.acceptedAtMs / 1_000) !== createdAt
  )
    invalid()
  if (
    payload.type === "handed_out" &&
    Math.floor(payload.handedOutAtMs / 1_000) !== createdAt
  )
    invalid()
}

/** Pure unsigned construction. Authenticated NIP-59 sealing and exact-wrap persistence are separate. */
export function createEventMarketStockAuthorityRumor(input: {
  readonly payload: EventMarketStockAuthorityPayload
  /** Unix seconds of the unsigned rumor, not the randomized seal time. */
  readonly createdAt: number
}): PrivateMessageRumor {
  const payload = parsePayload(input.payload)
  assertTimeBinding(payload, input.createdAt)
  const identity = parties(payload)
  const rumor = createPrivateMessageRumor({
    kind: 14,
    pubkey: identity.sender,
    created_at: input.createdAt,
    tags: [
      ["p", identity.recipient],
      ["subject", EVENT_MARKET_STOCK_AUTHORITY_SUBJECT],
      [...MARKER],
    ],
    content: JSON.stringify(payload),
  })
  if (new TextEncoder().encode(rumor.content).byteLength > MAX_PAYLOAD_BYTES)
    invalid()
  assertPrivateMessageFitsTransport(rumor)
  return rumor
}

/**
 * Strict structural decoder only: an unsigned rumor is NOT sender-authenticated.
 * Cold readers must first verify the recipient gift wrap, signed seal and
 * seal/rumor author match through the shared NIP-59 envelope boundary.
 * Grant/current authority, full journal ancestry, quota, replay and settlement
 * are independent validations; a well-formed message proves none of them.
 */
export function parseEventMarketStockAuthorityRumor(
  rumor: PrivateMessageEvent
): EventMarketStockAuthorityPayload {
  try {
    exactKeys(rumor as unknown as Record<string, unknown>, [
      "id",
      "kind",
      "pubkey",
      "created_at",
      "tags",
      "content",
    ])
    if (
      rumor.kind !== 14 ||
      !hash(rumor.id) ||
      typeof rumor.content !== "string" ||
      new TextEncoder().encode(rumor.content).byteLength > MAX_PAYLOAD_BYTES
    )
      invalid()
    const payload = parsePayload(JSON.parse(rumor.content))
    assertTimeBinding(payload, rumor.created_at!)
    const identity = parties(payload)
    const expectedTags = [
      ["p", identity.recipient],
      ["subject", EVENT_MARKET_STOCK_AUTHORITY_SUBJECT],
      [...MARKER],
    ]
    if (
      rumor.pubkey !== identity.sender ||
      JSON.stringify(rumor.tags) !== JSON.stringify(expectedTags) ||
      rumor.content !== JSON.stringify(payload) ||
      rumor.id !==
        getEventHash({
          kind: rumor.kind,
          pubkey: rumor.pubkey,
          created_at: rumor.created_at!,
          tags: rumor.tags,
          content: rumor.content,
        })
    )
      invalid()
    assertPrivateMessageFitsTransport({
      kind: rumor.kind,
      pubkey: rumor.pubkey,
      created_at: rumor.created_at!,
      tags: rumor.tags,
      content: rumor.content,
    })
    return payload
  } catch {
    return invalid()
  }
}
