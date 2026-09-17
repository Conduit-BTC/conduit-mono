import { NDKEvent } from "@nostr-dev-kit/ndk"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import {
  MAX_MERCHANT_PRESENT_SALE_AUTHORIZATION_TTL_SECONDS,
  merchantPresentSaleAuthorizationSchema,
  orderSchema,
  resolveOrderPickupHandoffAuthority,
  type MerchantPresentSaleAuthorizationSchema,
  type MerchantPresentOrderPurchaseContextSchema,
  type OrderPickupFulfillmentSchema,
  type OrderSchema,
  type PickupEvidenceCoordinateSchema,
} from "../schemas"
import { EVENT_KINDS } from "./kinds"
import { appendConduitClientTag } from "./nip89"

const HEX_64 = /^[0-9a-f]{64}$/i

function hashPrivateReference(domain: string, value: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(`${domain}\0${value}`)))
}

export interface MerchantPresentSaleReviewedCommerceInput {
  /** Canonical cart-line fingerprint from the exact selected purchase group. */
  cartCommerceFingerprint: string
  merchantPubkey: string
  /** Normalized payment destination reviewed immediately before order signing. */
  paymentDestination: string | null
  totalSats: number
}

export interface MerchantPresentSaleReviewedCommerce {
  version: 1
  merchantPubkey: string
  paymentDestination: string | null
  totalSats: number
  cartCommerceFingerprint: string
}

function parseReviewedCommerceRecord(
  value: unknown
): MerchantPresentSaleReviewedCommerce {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Merchant-present review is invalid.")
  }
  const candidate = value as Record<string, unknown>
  const merchantPubkey =
    typeof candidate.merchantPubkey === "string"
      ? candidate.merchantPubkey.trim().toLowerCase()
      : ""
  const cartCommerceFingerprint =
    typeof candidate.cartCommerceFingerprint === "string"
      ? candidate.cartCommerceFingerprint.trim()
      : ""
  const totalSats = candidate.totalSats
  const rawPaymentDestination = candidate.paymentDestination
  const paymentDestination =
    typeof rawPaymentDestination === "string" &&
    rawPaymentDestination.trim().length > 0
      ? rawPaymentDestination.trim().toLowerCase()
      : null

  if (candidate.version !== 1 || !HEX_64.test(merchantPubkey)) {
    throw new Error("Merchant-present review requires a valid merchant.")
  }
  if (!cartCommerceFingerprint) {
    throw new Error("Merchant-present review requires exact cart terms.")
  }
  if (!Number.isSafeInteger(totalSats) || Number(totalSats) < 0) {
    throw new Error("Merchant-present review requires a valid sats total.")
  }
  if (Number(totalSats) > 0 && !paymentDestination) {
    throw new Error(
      "Merchant-present review requires a confirmed payment destination."
    )
  }

  return {
    version: 1,
    merchantPubkey,
    paymentDestination: Number(totalSats) === 0 ? null : paymentDestination,
    totalSats: Number(totalSats),
    cartCommerceFingerprint,
  }
}

/** Parse the private buyer-retained review binding without trusting storage. */
export function parseMerchantPresentSaleReviewedCommerceFingerprint(
  reviewedCommerceFingerprint: string
): MerchantPresentSaleReviewedCommerce {
  let value: unknown
  try {
    value = JSON.parse(reviewedCommerceFingerprint)
  } catch {
    throw new Error("Merchant-present review is invalid.")
  }
  return parseReviewedCommerceRecord(value)
}

/**
 * Build the private buyer-retained review binding for a booth sale. The order
 * publishes only its opaque hash; the raw price and destination binding stays
 * on the buyer's device and is required again immediately before payment.
 */
export function buildMerchantPresentSaleReviewedCommerceFingerprint(
  input: MerchantPresentSaleReviewedCommerceInput
): string {
  return JSON.stringify(
    parseReviewedCommerceRecord({
      version: 1,
      merchantPubkey: input.merchantPubkey,
      paymentDestination: input.paymentDestination,
      totalSats: input.totalSats,
      cartCommerceFingerprint: input.cartCommerceFingerprint,
    })
  )
}

/**
 * Re-check the payment-sensitive portion of a booth review immediately before
 * invoice access. Listing and handoff freshness remain caller responsibilities.
 */
export function assertMerchantPresentSalePaymentReview(input: {
  reviewedCommerceFingerprint: string
  merchantPubkey: string
  totalSats: number
  currentPaymentDestination: string | null
}): MerchantPresentSaleReviewedCommerce {
  const review = parseMerchantPresentSaleReviewedCommerceFingerprint(
    input.reviewedCommerceFingerprint
  )
  const merchantPubkey = input.merchantPubkey.trim().toLowerCase()
  if (review.merchantPubkey !== merchantPubkey) {
    throw new Error(
      "The merchant identity no longer matches the reviewed booth sale."
    )
  }
  if (review.totalSats !== input.totalSats) {
    throw new Error(
      "The booth total no longer matches the buyer's reviewed order."
    )
  }
  if (review.totalSats === 0) return review

  const currentPaymentDestination =
    input.currentPaymentDestination?.trim().toLowerCase() ?? null
  if (
    !currentPaymentDestination ||
    review.paymentDestination !== currentPaymentDestination
  ) {
    throw new Error(
      "The merchant payment destination changed after this booth order was reviewed. Do not pay; ask the merchant to restart the sale."
    )
  }
  return review
}

/** Opaque binding for the exact commerce terms reviewed by the buyer. */
export function getMerchantPresentSaleCommerceFingerprintRef(
  reviewedCommerceFingerprint: string
): string {
  if (reviewedCommerceFingerprint.length === 0) {
    throw new Error(
      "Merchant-present authorization requires reviewed commerce terms."
    )
  }
  return hashPrivateReference(
    "merchant-present-sale-commerce-v1",
    reviewedCommerceFingerprint
  )
}

export type MerchantPresentSaleRandomBytes = (length: number) => Uint8Array

function secureRandomBytes(length: number): Uint8Array {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Secure randomness is unavailable for booth authorization.")
  }
  return globalThis.crypto.getRandomValues(new Uint8Array(length))
}

/** Generate a 256-bit single-use nonce without coupling callers to a runtime. */
export function createMerchantPresentSaleAuthorizationNonce(
  randomBytes: MerchantPresentSaleRandomBytes = secureRandomBytes
): string {
  const bytes = randomBytes(32)
  if (bytes.length !== 32) {
    throw new Error("Merchant-present authorization nonce must be 32 bytes.")
  }
  return bytesToHex(bytes)
}

function coordinateIdentity(value: string): string | null {
  const first = value.indexOf(":")
  const second = value.indexOf(":", first + 1)
  if (first < 1 || second <= first + 1) return null
  const kind = Number(value.slice(0, first))
  const author = value.slice(first + 1, second)
  const dTag = value.slice(second + 1)
  if (!Number.isSafeInteger(kind) || !HEX_64.test(author) || !dTag) return null
  return `${kind}:${author.toLowerCase()}:${dTag}`
}

function sameEvidenceRevision(
  left: PickupEvidenceCoordinateSchema,
  right: PickupEvidenceCoordinateSchema
): boolean {
  return (
    coordinateIdentity(left.coordinate) ===
      coordinateIdentity(right.coordinate) &&
    left.eventId.toLowerCase() === right.eventId.toLowerCase() &&
    left.createdAt === right.createdAt
  )
}

function sameMerchantPickupGraph(
  authorization: Pick<
    MerchantPresentSaleAuthorizationSchema,
    "organizerPubkey" | "calendar" | "collection" | "option"
  >,
  fulfillment: OrderPickupFulfillmentSchema
): boolean {
  return (
    authorization.organizerPubkey.toLowerCase() ===
      fulfillment.organizerPubkey.toLowerCase() &&
    sameEvidenceRevision(authorization.calendar, fulfillment.calendar) &&
    sameEvidenceRevision(authorization.collection, fulfillment.collection) &&
    sameEvidenceRevision(authorization.option, fulfillment.option)
  )
}

function assertMerchantOwnedPickupOrder(
  order: OrderSchema
): Array<
  OrderSchema["items"][number] & { fulfillment: OrderPickupFulfillmentSchema }
> {
  const pickupItems: Array<
    OrderSchema["items"][number] & {
      fulfillment: OrderPickupFulfillmentSchema
    }
  > = []
  for (const item of order.items) {
    if (item.format !== "physical" || item.fulfillment?.type !== "pickup") {
      throw new Error(
        "Merchant-present authorization requires only physical pickup items."
      )
    }
    const authority = resolveOrderPickupHandoffAuthority(item.fulfillment)
    if (
      item.fulfillment.handoffMode !== "merchant_handoff" ||
      !item.fulfillment.handlerPubkey ||
      authority.legacySafeDefault ||
      authority.mode !== "merchant_handoff" ||
      authority.handlerPubkey.toLowerCase() !==
        order.merchantPubkey.toLowerCase()
    ) {
      throw new Error(
        "Merchant-present authorization requires an explicit merchant-owned pickup snapshot."
      )
    }
    pickupItems.push({ ...item, fulfillment: item.fulfillment })
  }
  return pickupItems
}

function assertMerchantPresentPurchaseContext(
  order: OrderSchema
): MerchantPresentOrderPurchaseContextSchema {
  const purchaseContext = order.purchaseContext
  if (purchaseContext?.type !== "merchant_present") {
    throw new Error(
      "Merchant-present authorization requires the buyer's signed merchant-present purchase context. Remote pickup orders cannot be upgraded at authorization time."
    )
  }
  return purchaseContext
}

function evidence(
  value: PickupEvidenceCoordinateSchema
): PickupEvidenceCoordinateSchema {
  return {
    coordinate: value.coordinate,
    eventId: value.eventId,
    createdAt: value.createdAt,
  }
}

export interface ValidateMerchantPresentSaleAuthorizationInput {
  authorization: MerchantPresentSaleAuthorizationSchema
  order: OrderSchema
  reviewedCommerceFingerprint: string
  /** Unix seconds. Defaults to the current clock. */
  now?: number
}

/**
 * Validate a merchant availability capability against the buyer's exact order.
 * Payment, payment-target, settlement, and current-listing checks remain caller
 * responsibilities and cannot be bypassed by this capability.
 */
export function validateMerchantPresentSaleAuthorization(
  input: ValidateMerchantPresentSaleAuthorizationInput
): MerchantPresentSaleAuthorizationSchema {
  const authorization = merchantPresentSaleAuthorizationSchema.parse(
    input.authorization
  )
  const order = orderSchema.parse(input.order)
  const purchaseContext = assertMerchantPresentPurchaseContext(order)
  const now = input.now ?? Math.floor(Date.now() / 1_000)
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("Merchant-present authorization clock is invalid.")
  }
  if (now < authorization.issuedAt) {
    throw new Error(
      "Merchant-present authorization is not valid yet. Check device clocks and ask the merchant to confirm again."
    )
  }
  if (now >= authorization.expiresAt) {
    throw new Error(
      "Merchant-present authorization expired. Ask the merchant to confirm physical availability again."
    )
  }
  if (authorization.orderId !== order.id) {
    throw new Error(
      "Merchant-present authorization belongs to a different order."
    )
  }
  if (
    authorization.merchantPubkey.toLowerCase() !==
    order.merchantPubkey.toLowerCase()
  ) {
    throw new Error(
      "Merchant-present authorization was not issued by the order merchant."
    )
  }
  if (
    authorization.buyerPubkey.toLowerCase() !== order.buyerPubkey.toLowerCase()
  ) {
    throw new Error(
      "Merchant-present authorization belongs to a different buyer."
    )
  }
  const expectedFingerprintRef = getMerchantPresentSaleCommerceFingerprintRef(
    input.reviewedCommerceFingerprint
  )
  if (
    purchaseContext.reviewedCommerceFingerprintRef !== expectedFingerprintRef
  ) {
    throw new Error(
      "Current price, payment, or fulfillment terms no longer match the buyer's signed merchant-present order context. Review the sale again."
    )
  }
  if (
    authorization.reviewedCommerceFingerprintRef !==
    purchaseContext.reviewedCommerceFingerprintRef
  ) {
    throw new Error(
      "Merchant-present authorization does not match the buyer's reviewed order context. Ask the merchant to confirm again."
    )
  }

  const pickupItems = assertMerchantOwnedPickupOrder(order)
  const firstFulfillment = pickupItems[0]?.fulfillment
  if (
    !firstFulfillment ||
    !sameMerchantPickupGraph(authorization, firstFulfillment)
  ) {
    throw new Error(
      "Merchant-present authorization does not match the selected event pickup."
    )
  }

  const orderItems = new Map<string, (typeof pickupItems)[number]>()
  for (const item of pickupItems) {
    const key = coordinateIdentity(item.fulfillment.product.coordinate)
    if (!key || orderItems.has(key)) {
      throw new Error(
        "Merchant-present order contains ambiguous product lines."
      )
    }
    orderItems.set(key, item)
  }
  if (orderItems.size !== authorization.items.length) {
    throw new Error(
      "Merchant-present authorization does not cover every ordered product."
    )
  }
  for (const authorizedItem of authorization.items) {
    const orderItem = orderItems.get(
      coordinateIdentity(authorizedItem.product.coordinate) ?? ""
    )
    if (
      !orderItem ||
      orderItem.quantity !== authorizedItem.quantity ||
      !sameEvidenceRevision(
        authorizedItem.product,
        orderItem.fulfillment.product
      ) ||
      !sameMerchantPickupGraph(authorization, orderItem.fulfillment)
    ) {
      throw new Error(
        "Merchant-present authorization does not match exact product revisions and quantities."
      )
    }
  }
  return authorization
}

export interface BuildMerchantPresentSaleAuthorizationInput {
  order: OrderSchema
  nonce: string
  /** Unix seconds. Defaults to the current clock. */
  issuedAt?: number
  /** Unix seconds. Defaults to five minutes after issuance. */
  expiresAt?: number
}

/** Build the minimal buyer-private availability payload from an order snapshot. */
export function buildMerchantPresentSaleAuthorization(
  input: BuildMerchantPresentSaleAuthorizationInput
): MerchantPresentSaleAuthorizationSchema {
  const order = orderSchema.parse(input.order)
  const purchaseContext = assertMerchantPresentPurchaseContext(order)
  const pickupItems = assertMerchantOwnedPickupOrder(order)
  const firstFulfillment = pickupItems[0]?.fulfillment
  if (!firstFulfillment) {
    throw new Error("Merchant-present authorization requires pickup items.")
  }
  const issuedAt = input.issuedAt ?? Math.floor(Date.now() / 1_000)
  const authorization = merchantPresentSaleAuthorizationSchema.parse({
    version: 1,
    type: "merchant_present_sale_authorization",
    scope: "physical_availability_only",
    orderId: order.id,
    merchantPubkey: order.merchantPubkey.toLowerCase(),
    buyerPubkey: order.buyerPubkey.toLowerCase(),
    organizerPubkey: firstFulfillment.organizerPubkey.toLowerCase(),
    calendar: evidence(firstFulfillment.calendar),
    collection: evidence(firstFulfillment.collection),
    option: evidence(firstFulfillment.option),
    items: pickupItems.map((item) => ({
      product: evidence(item.fulfillment.product),
      quantity: item.quantity,
    })),
    reviewedCommerceFingerprintRef:
      purchaseContext.reviewedCommerceFingerprintRef,
    nonce: input.nonce.toLowerCase(),
    issuedAt,
    expiresAt:
      input.expiresAt ??
      issuedAt + MAX_MERCHANT_PRESENT_SALE_AUTHORIZATION_TTL_SECONDS,
  })
  return authorization
}

type MerchantPresentSaleRumor = Pick<
  NDKEvent,
  "kind" | "id" | "pubkey" | "created_at" | "tags" | "content"
>

function singleTag(event: Pick<NDKEvent, "tags">, name: string): string | null {
  const values = (event.tags ?? [])
    .filter((tag) => tag[0] === name && typeof tag[1] === "string")
    .map((tag) => tag[1]!)
  return values.length === 1 ? values[0]! : null
}

/** Build the encrypted inner kind-16 rumor; callers use shared NIP-17 delivery. */
export function buildMerchantPresentSaleAuthorizationRumor(
  input: MerchantPresentSaleAuthorizationSchema
): NDKEvent {
  const authorization = merchantPresentSaleAuthorizationSchema.parse(input)
  const rumor = new NDKEvent()
  rumor.kind = EVENT_KINDS.ORDER
  rumor.pubkey = authorization.merchantPubkey.toLowerCase()
  rumor.created_at = authorization.issuedAt
  rumor.tags = appendConduitClientTag(
    [
      ["p", authorization.buyerPubkey.toLowerCase()],
      ["type", authorization.type],
      ["order", authorization.orderId],
    ],
    "merchant"
  )
  rumor.content = JSON.stringify(authorization)
  rumor.id = rumor.getEventHash()
  return rumor
}

/** Parse and authenticate the authority carried by an unwrapped kind-16 rumor. */
export function parseMerchantPresentSaleAuthorizationRumor(
  event: MerchantPresentSaleRumor
): MerchantPresentSaleAuthorizationSchema {
  if (event.kind !== EVENT_KINDS.ORDER) {
    throw new Error("Merchant-present authorization must use kind 16.")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(event.content)
  } catch {
    throw new Error("Merchant-present authorization content is malformed.")
  }
  const authorization = merchantPresentSaleAuthorizationSchema.parse(parsed)
  if (
    singleTag(event, "type") !== authorization.type ||
    singleTag(event, "order") !== authorization.orderId ||
    singleTag(event, "p")?.toLowerCase() !==
      authorization.buyerPubkey.toLowerCase() ||
    event.pubkey.toLowerCase() !== authorization.merchantPubkey.toLowerCase() ||
    event.created_at !== authorization.issuedAt
  ) {
    throw new Error(
      "Merchant-present authorization rumor authority is invalid."
    )
  }
  if (event.id) {
    const rumor = new NDKEvent(undefined, {
      kind: event.kind,
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      tags: event.tags,
      content: event.content,
      sig: "",
    })
    if (rumor.getEventHash().toLowerCase() !== event.id.toLowerCase()) {
      throw new Error("Merchant-present authorization rumor id is invalid.")
    }
  }
  return authorization
}

/** Content-safe key that a merchant store can consume atomically once. */
export function getMerchantPresentSaleAuthorizationUseRef(
  input: Pick<
    MerchantPresentSaleAuthorizationSchema,
    "merchantPubkey" | "buyerPubkey" | "orderId" | "nonce"
  >
): string {
  return hashPrivateReference(
    "merchant-present-sale-use-v1",
    `${input.merchantPubkey.toLowerCase()}\0${input.buyerPubkey.toLowerCase()}\0${input.orderId}\0${input.nonce.toLowerCase()}`
  )
}

export interface MerchantPresentSaleAuthorizationUse {
  /** Opaque, content-safe key; the consumer must create it atomically. */
  useRef: string
  expiresAt: number
}

export type ConsumeMerchantPresentSaleAuthorizationNonce = (
  use: MerchantPresentSaleAuthorizationUse
) => boolean | Promise<boolean>

export interface ConsumeMerchantPresentSaleAuthorizationInput extends ValidateMerchantPresentSaleAuthorizationInput {
  /** Return false when this useRef was already consumed. */
  consumeNonce: ConsumeMerchantPresentSaleAuthorizationNonce
}

/** Validate first, then atomically consume the one-use capability. */
export async function consumeMerchantPresentSaleAuthorization(
  input: ConsumeMerchantPresentSaleAuthorizationInput
): Promise<MerchantPresentSaleAuthorizationSchema> {
  const authorization = validateMerchantPresentSaleAuthorization(input)
  const consumed = await input.consumeNonce({
    useRef: getMerchantPresentSaleAuthorizationUseRef(authorization),
    expiresAt: authorization.expiresAt,
  })
  if (!consumed) {
    throw new Error(
      "Merchant-present authorization was already used. Ask the merchant to confirm this sale again."
    )
  }
  return authorization
}
