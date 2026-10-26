import { z } from "zod"
import { getEventHash } from "nostr-tools"
import { hasExactMachineRumorBindings } from "./machine-rumor-binding"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { orderSchema, type OrderSchema } from "../schemas"
import {
  freezeCheckoutSparkCommerceQuote,
  type CheckoutSparkCommerceQuote,
} from "./checkout-spark-reconciliation"
import {
  freezeCheckoutSparkEventMarketBinding,
  matchesCheckoutSparkOrderEventMarketSnapshot,
  type CheckoutSparkEventMarketBinding,
} from "./checkout-spark-event-market"
import {
  assertCheckoutSparkSignedEventMarketSources,
  getCheckoutSparkEventMarketSourceReferences,
} from "./checkout-spark-event-market-sources"
import {
  assertCheckoutSparkCommerceProductPrice,
  matchesCheckoutSparkCommerceOrderLine,
} from "./checkout-spark-commerce-pricing"
import { parseCheckoutSparkSignedProductFields } from "./checkout-spark-product-fields"
import { getOrganizerStockOrderBindings } from "./merchant-order-acceptance-bindings"
import { appendConduitClientTag } from "./nip89"
import {
  assertPrivateMessageFitsTransport,
  type PrivateMessageEvent,
  type PrivateMessageRumor,
} from "./private-message-primitives"
import {
  isValidNostrPublicKey,
  type SignedPublicNostrEvent,
} from "./signed-event"
import { EVENT_MARKET_FREE_PURCHASE_TYPE } from "./event-market-free-purchase-marker"

export {
  EVENT_MARKET_FREE_PURCHASE_TYPE,
  isEventMarketFreePurchaseRumor,
} from "./event-market-free-purchase-marker"
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/)
const timestamp = z.number().int().safe().nonnegative()
const schema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.literal(EVENT_MARKET_FREE_PURCHASE_TYPE),
    handoffId: hashSchema,
    orderId: z.string().min(1).max(512),
    senderPubkey: hashSchema,
    merchantPubkey: hashSchema,
    organizerPubkey: hashSchema,
    createdAt: timestamp,
    orderBinding: z
      .object({
        identityHash: hashSchema,
        termsHash: hashSchema,
        createdAt: timestamp,
      })
      .strict(),
    commerceQuote: z.unknown(),
    eventMarket: z.unknown(),
    sourceEvents: z.array(z.unknown()).min(1).max(512),
  })
  .strict()
export interface EventMarketFreePurchasePayload extends Omit<
  z.infer<typeof schema>,
  "commerceQuote" | "eventMarket" | "sourceEvents"
> {
  commerceQuote: CheckoutSparkCommerceQuote
  eventMarket: CheckoutSparkEventMarketBinding
  sourceEvents: readonly SignedPublicNostrEvent[]
}
/** Content-free discovery references; the authenticated original ciphertext is reopened before action. */
export interface EventMarketFreePurchaseDescriptor {
  id: string
  senderPubkey: string
  createdAt: number
  wrapId: string
  orderId: string
  merchantPubkey: string
  organizerPubkey: string
  marketCoordinate: string
  handoffId: string
}
const hash = (value: unknown) =>
  bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(value))))
function invalid(): never {
  throw new Error("Exact free event purchase authority is unavailable.")
}
function digest(input: Omit<EventMarketFreePurchasePayload, "handoffId">) {
  return hash(["conduit:event-market-free-purchase:v1", input])
}

/** Original signed zero prices only; rounded-down positive prices never become free authority. */
export function restoreEventMarketFreePurchase(
  value: unknown
): EventMarketFreePurchasePayload {
  const result = schema.safeParse(value)
  if (!result.success) invalid()
  const raw = result.data as EventMarketFreePurchasePayload
  if (
    !isValidNostrPublicKey(raw.senderPubkey) ||
    !isValidNostrPublicKey(raw.merchantPubkey) ||
    !isValidNostrPublicKey(raw.organizerPubkey) ||
    raw.merchantPubkey === raw.organizerPubkey ||
    raw.orderId.trim() !== raw.orderId ||
    /\p{Cc}/u.test(raw.orderId) ||
    raw.createdAt !== raw.orderBinding.createdAt ||
    raw.orderBinding.identityHash !==
      hash([raw.orderId, raw.senderPubkey, raw.merchantPubkey])
  )
    invalid()
  const commerceQuote = freezeCheckoutSparkCommerceQuote(
    raw.commerceQuote,
    raw.merchantPubkey,
    { allowZeroTotal: true }
  )
  const eventMarket = freezeCheckoutSparkEventMarketBinding(raw.eventMarket, {
    merchantPubkey: raw.merchantPubkey,
    commerceQuote,
    acceptedAtMs: raw.createdAt,
  })
  if (
    commerceQuote.commerceTotalSats !== 0 ||
    eventMarket.organizerFeeSats !== 0 ||
    eventMarket.mode !== "organizer_handoff" ||
    eventMarket.organizerPubkey !== raw.organizerPubkey ||
    JSON.stringify(raw.commerceQuote) !== JSON.stringify(commerceQuote) ||
    JSON.stringify(raw.eventMarket) !== JSON.stringify(eventMarket)
  )
    invalid()
  const references = getCheckoutSparkEventMarketSourceReferences(
    eventMarket,
    raw.merchantPubkey
  )
  const requiredIds = new Set([
    ...references.map((reference) => reference.eventId),
    ...commerceQuote.lines.map((line) => line.productEventId),
  ])
  const sources = raw.sourceEvents
    .map((event) => structuredClone(event))
    .sort((a, b) => a.id.localeCompare(b.id))
  if (
    sources.length !== requiredIds.size ||
    new Set(sources.map((event) => event.id)).size !== sources.length ||
    sources.some((event) => !requiredIds.has(event.id))
  )
    invalid()
  assertCheckoutSparkSignedEventMarketSources({
    eventMarket,
    commerceQuote,
    merchantPubkey: raw.merchantPubkey,
    sourceEvents: sources,
    acceptedAtMs: raw.createdAt,
  })
  for (const line of commerceQuote.lines) {
    const event = sources.find(
      (candidate) => candidate.id === line.productEventId
    )
    if (!event) invalid()
    const product = parseCheckoutSparkSignedProductFields(event)
    if (
      line.unitMerchandiseSats !== 0 ||
      line.unitShippingSats !== 0 ||
      product.priceEvidenceMalformed ||
      product.price !== 0 ||
      (product.sourcePrice !== undefined && product.sourcePrice.amount !== 0)
    )
      invalid()
    assertCheckoutSparkCommerceProductPrice({
      product,
      line,
      pricing: commerceQuote.pricing,
      acceptedAtMs: raw.createdAt,
      allowZero: true,
    })
  }
  const base: Omit<EventMarketFreePurchasePayload, "handoffId"> = {
    schemaVersion: 1 as const,
    type: EVENT_MARKET_FREE_PURCHASE_TYPE,
    orderId: raw.orderId,
    senderPubkey: raw.senderPubkey,
    merchantPubkey: raw.merchantPubkey,
    organizerPubkey: raw.organizerPubkey,
    createdAt: raw.createdAt,
    orderBinding: Object.freeze({ ...raw.orderBinding }),
    commerceQuote,
    eventMarket,
    sourceEvents: Object.freeze(sources),
  }
  if (raw.handoffId !== digest(base)) invalid()
  const payload = Object.freeze({
    schemaVersion: 1 as const,
    type: EVENT_MARKET_FREE_PURCHASE_TYPE,
    handoffId: raw.handoffId,
    orderId: base.orderId,
    senderPubkey: base.senderPubkey,
    merchantPubkey: base.merchantPubkey,
    organizerPubkey: base.organizerPubkey,
    createdAt: base.createdAt,
    orderBinding: base.orderBinding,
    commerceQuote,
    eventMarket,
    sourceEvents: base.sourceEvents,
  })
  if (new TextEncoder().encode(JSON.stringify(payload)).length > 30 * 1024)
    invalid()
  return payload
}

/** The full original order is validated locally, but never forwarded to the organizer. */
export function createEventMarketFreePurchase(input: {
  order: OrderSchema
  commerceQuote: CheckoutSparkCommerceQuote
  eventMarket: CheckoutSparkEventMarketBinding
  sourceEvents: readonly SignedPublicNostrEvent[]
}): EventMarketFreePurchasePayload {
  const order = orderSchema.parse(input.order)
  const commerceQuote = freezeCheckoutSparkCommerceQuote(
    input.commerceQuote,
    order.merchantPubkey,
    { allowZeroTotal: true }
  )
  const eventMarket = freezeCheckoutSparkEventMarketBinding(input.eventMarket, {
    merchantPubkey: order.merchantPubkey,
    commerceQuote,
    acceptedAtMs: order.createdAt,
  })
  if (
    order.currency !== "SATS" ||
    order.subtotal !== 0 ||
    order.shippingCostSats !== 0 ||
    order.items.length !== commerceQuote.lines.length ||
    new Set(order.items.map((item) => item.productId)).size !==
      order.items.length
  )
    invalid()
  for (const item of order.items) {
    const line = commerceQuote.lines.find(
      (candidate) => candidate.productCoordinate === item.productId
    )
    if (
      !line ||
      !matchesCheckoutSparkCommerceOrderLine(item, line) ||
      !matchesCheckoutSparkOrderEventMarketSnapshot(
        item.fulfillment,
        eventMarket,
        item.productId
      )
    )
      invalid()
  }
  const bindings = getOrganizerStockOrderBindings(order)
  const requiredIds = new Set([
    ...getCheckoutSparkEventMarketSourceReferences(
      eventMarket,
      order.merchantPubkey
    ).map((reference) => reference.eventId),
    ...commerceQuote.lines.map((line) => line.productEventId),
  ])
  const sourceEvents = [
    ...new Map(
      input.sourceEvents
        .filter((event) => requiredIds.has(event.id))
        .map((event) => [event.id, structuredClone(event)])
    ).values(),
  ].sort((a, b) => a.id.localeCompare(b.id))
  const base: Omit<EventMarketFreePurchasePayload, "handoffId"> = {
    schemaVersion: 1 as const,
    type: EVENT_MARKET_FREE_PURCHASE_TYPE,
    orderId: order.id,
    senderPubkey: order.buyerPubkey,
    merchantPubkey: order.merchantPubkey,
    organizerPubkey: eventMarket.organizerPubkey,
    createdAt: order.createdAt,
    orderBinding: {
      identityHash: bindings.identityHash,
      termsHash: bindings.termsHash,
      createdAt: order.createdAt,
    },
    commerceQuote,
    eventMarket,
    sourceEvents,
  }
  return restoreEventMarketFreePurchase({ ...base, handoffId: digest(base) })
}

export function buildEventMarketFreePurchaseRumor(
  value: EventMarketFreePurchasePayload
): PrivateMessageRumor {
  const payload = restoreEventMarketFreePurchase(value)
  const rumor = {
    kind: 16,
    pubkey: payload.senderPubkey,
    created_at: Math.floor(payload.createdAt / 1000),
    tags: appendConduitClientTag(
      [
        ["p", payload.organizerPubkey],
        ["type", EVENT_MARKET_FREE_PURCHASE_TYPE],
        ["order", payload.orderId],
        ["handoff", payload.handoffId],
      ],
      "market"
    ),
    content: JSON.stringify(payload),
  }
  const result = { ...rumor, id: getEventHash(rumor) }
  assertPrivateMessageFitsTransport(result)
  return result
}

/** Structural validation only. NIP-59 author/seal authentication remains required. */
export function parseEventMarketFreePurchaseRumor(
  rumor: PrivateMessageEvent
): EventMarketFreePurchasePayload {
  try {
    const payload = restoreEventMarketFreePurchase(JSON.parse(rumor.content))
    const expected = buildEventMarketFreePurchaseRumor(payload)
    if (!hasExactMachineRumorBindings(rumor, expected)) invalid()
    return payload
  } catch {
    return invalid()
  }
}
