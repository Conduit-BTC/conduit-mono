import type { NDKEvent } from "@nostr-dev-kit/ndk"
import { z } from "zod"
import { isSatsLikeCurrency } from "../pricing"
import { EVENT_KINDS } from "./kinds"
import {
  hasSameShippingPolicyQuote,
  type ShippingPolicyQuote,
} from "./shipping-policy"
import {
  conversationMessageSchema,
  futureMarketReadyReceiptSchema,
  futureMarketRevocationSchema,
  futureMarketHandoffAckSchema,
  orderMessageTypeSchema,
  orderSchema,
  paymentProofActionSchema,
  paymentProofDeliveryStatusSchema,
  paymentProofMessageSchema,
  paymentProofSourceSchema,
  paymentRequestMessageSchema,
  receiptMessageSchema,
  shippingUpdateMessageSchema,
  statusUpdateMessageSchema,
  type ConversationMessageSchema,
  type FutureMarketReadyReceiptSchema,
  type FutureMarketRevocationSchema,
  type FutureMarketHandoffAckSchema,
  type OrderMessageTypeSchema,
  type OrderSchema,
  type PaymentProofMessageSchema,
  type PaymentProofActionSchema,
  type PaymentProofDeliveryStatusSchema,
  type PaymentProofSourceSchema,
  type PaymentRequestMessageSchema,
  type ReceiptMessageSchema,
  type ShippingUpdateMessageSchema,
  type StatusUpdateMessageSchema,
} from "../schemas"

/**
 * Parse a Conduit MVP order rumor event (kind 16) from its JSON content.
 */
export function parseOrderRumorEvent(
  event: Pick<NDKEvent, "content">
): OrderSchema {
  const parsed = JSON.parse(event.content || "{}") as unknown
  return orderSchema.parse(expandOrderShippingPolicyQuotes(parsed))
}

/**
 * Keep one exact quote per shipping group on the wire. Runtime orders retain
 * the full quote on every line for pricing, recovery, and Merchant review.
 * This is the versioned Conduit order-payload extension, not a NIP-44 format.
 */
export function serializeOrderRumorContent(order: OrderSchema): string {
  orderSchema.parse(order)
  if (!order.items.some((item) => item.shippingPolicyQuote))
    return JSON.stringify(order)
  const groups: ShippingPolicyQuote[] = []
  const items = order.items.map((item) => {
    const { shippingPolicyQuote, ...line } = item
    if (!shippingPolicyQuote) return line
    let groupIndex = groups.findIndex((quote) =>
      hasSameShippingPolicyQuote(quote, shippingPolicyQuote)
    )
    if (groupIndex === -1) {
      groupIndex = groups.length
      groups.push(shippingPolicyQuote)
    }
    return { ...line, shippingPolicyQuoteRef: groupIndex }
  })
  return JSON.stringify({
    ...order,
    items,
    shippingPolicyQuotes: { version: 1, groups },
  })
}

function expandOrderShippingPolicyQuotes(input: unknown): unknown {
  const order = parseObject(input)
  if (!order) return input
  const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(value, key)
  const items = order.items
  if (!hasOwn(order, "shippingPolicyQuotes")) {
    if (
      Array.isArray(items) &&
      items.some((item) => {
        const line = parseObject(item)
        return line && hasOwn(line, "shippingPolicyQuoteRef")
      })
    )
      throw new Error("Shipping quote reference is missing its group document.")
    return input
  }
  const document = parseObject(order.shippingPolicyQuotes)
  if (
    !document ||
    document.version !== 1 ||
    !Array.isArray(document.groups) ||
    !Array.isArray(items) ||
    document.groups.length < 1 ||
    document.groups.length > items.length
  )
    throw new Error("Invalid shipping quote group document.")
  const groups = document.groups
  const usedGroups = new Set<number>()
  const expanded = items.map((value) => {
    const line = parseObject(value)
    if (!line) throw new Error("Invalid order item in shipping quote document.")
    if (hasOwn(line, "shippingPolicyQuote"))
      throw new Error(
        "Shipping quote groups cannot mix inline quote snapshots."
      )
    if (!hasOwn(line, "shippingPolicyQuoteRef")) return line
    const reference = line.shippingPolicyQuoteRef
    if (
      typeof reference !== "number" ||
      !Number.isSafeInteger(reference) ||
      reference < 0 ||
      reference >= groups.length
    )
      throw new Error("Invalid shipping quote group reference.")
    const item = { ...line }
    delete item.shippingPolicyQuoteRef
    usedGroups.add(reference)
    return { ...item, shippingPolicyQuote: groups[reference] }
  })
  if (usedGroups.size !== groups.length)
    throw new Error("Shipping quote document contains an unused group.")
  const payload = { ...order }
  delete payload.shippingPolicyQuotes
  return { ...payload, items: expanded }
}

type OrderRumorEvent = Pick<
  NDKEvent,
  "id" | "created_at" | "content" | "tags" | "pubkey"
> & { kind?: number }

/** Private kind-16 buyer order hint; never payment or fulfillment evidence. */
export const CHECKOUT_SPARK_ROUTER_ORDER_TAG = [
  "conduit_checkout_payment",
  "spark_router",
  "1",
] as const

export type CheckoutOrderPaymentRoute = "spark_router_v1"

type ParsedOrderMessageBase = {
  id: string
  orderId: string
  type: OrderMessageTypeSchema
  createdAt: number
  senderPubkey: string
  recipientPubkey: string
  rawContent: string
}

export type ParsedOrderMessage =
  | (ParsedOrderMessageBase & {
      type: "order"
      payload: OrderSchema
      checkoutPaymentRoute?: CheckoutOrderPaymentRoute
    })
  | (ParsedOrderMessageBase & {
      type: "payment_request"
      payload: PaymentRequestMessageSchema
    })
  | (ParsedOrderMessageBase & {
      type: "status_update"
      payload: StatusUpdateMessageSchema
    })
  | (ParsedOrderMessageBase & {
      type: "shipping_update"
      payload: ShippingUpdateMessageSchema
    })
  | (ParsedOrderMessageBase & {
      type: "receipt"
      payload: ReceiptMessageSchema
    })
  | (ParsedOrderMessageBase & {
      type: "message"
      payload: ConversationMessageSchema
    })
  | (ParsedOrderMessageBase & {
      type: "payment_proof"
      payload: PaymentProofMessageSchema
    })
  | (ParsedOrderMessageBase & {
      type: "future_market_ready"
      payload: FutureMarketReadyReceiptSchema
    })
  | (ParsedOrderMessageBase & {
      type: "future_market_revoked"
      payload: FutureMarketRevocationSchema
    })
  | (ParsedOrderMessageBase & {
      type: "future_market_handed_out"
      payload: FutureMarketHandoffAckSchema
    })

export type ParsedEventMarketPrivateMessage = Extract<
  ParsedOrderMessage,
  {
    type:
      | "future_market_ready"
      | "future_market_revoked"
      | "future_market_handed_out"
  }
>

const lightningPaymentProofInputSchema = z
  .object({
    orderId: z.string().min(1),
    action: paymentProofActionSchema,
    amount: z.number().int().min(0),
    amountMsats: z.number().int().min(0),
    currency: z.string().min(1),
    invoice: z.string().min(1),
    preimage: z.string().min(1),
    paymentHash: z.string().min(1).optional(),
    feeMsats: z.number().int().min(0).optional(),
    zapRequestId: z.string().min(1).optional(),
    zapReceiptId: z.string().min(1).optional(),
    source: paymentProofSourceSchema,
    proofDeliveryStatus: paymentProofDeliveryStatusSchema.optional(),
    note: z.string().max(2000).optional(),
  })
  .superRefine((input, ctx) => {
    if (input.action === "zap" && !input.zapRequestId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["zapRequestId"],
        message: "Public zap proofs must include the zap request id.",
      })
    }

    if (input.amountMsats !== input.amount * 1000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amountMsats"],
        message: "Proof amountMsats must match amount in sats.",
      })
    }
  })

export type BuildLightningPaymentProofMessageInput = z.input<
  typeof lightningPaymentProofInputSchema
>

function getTagValue(
  tags: string[][] | undefined,
  name: string
): string | null {
  for (const tag of tags ?? []) {
    if (tag[0] === name && typeof tag[1] === "string") return tag[1]
  }
  return null
}

function parseNumericTag(
  tags: string[][] | undefined,
  name: string
): number | undefined {
  const value = getTagValue(tags, name)
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseJsonObject(content: string): Record<string, unknown> | null {
  const trimmed = content.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function hasText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function getNumber(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined
  return Number.isFinite(value) ? value : undefined
}

function getStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = value.filter(
    (item): item is string => typeof item === "string"
  )
  return strings.length === value.length ? strings : undefined
}

function parseObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

function normalizePaymentProofVerification(
  value: unknown
): Record<string, unknown> | undefined {
  const object = parseObject(value)
  if (!object) return undefined

  const normalized: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(object)) {
    if (key === "state" || key === "checkedAt" || key === "checks") continue
    normalized[key] = item
  }

  const state = getString(object.state)
  if (state) normalized.state = state

  const checkedAt = getNumber(object.checkedAt)
  if (checkedAt !== undefined) normalized.checkedAt = checkedAt

  const checks = getStringArray(object.checks)
  if (checks) normalized.checks = checks

  return Object.keys(normalized).length > 0 ? normalized : undefined
}

export function hasPaymentProofEvidence(
  payload: PaymentProofMessageSchema
): boolean {
  const verificationState = payload.verification?.state
  if (
    verificationState === "verification_failed" ||
    verificationState === "disputed"
  ) {
    return false
  }

  if (hasText(payload.invoice) && hasText(payload.preimage)) return true

  return hasText(payload.zapRequestId) && hasText(payload.zapReceiptId)
}

export function isPaymentProofEvidenceMessage(
  message: ParsedOrderMessage
): message is Extract<ParsedOrderMessage, { type: "payment_proof" }> {
  return (
    message.type === "payment_proof" && hasPaymentProofEvidence(message.payload)
  )
}

function messageBase<TType extends OrderMessageTypeSchema>(
  event: OrderRumorEvent,
  type: TType,
  orderId: string
): ParsedOrderMessageBase & { type: TType } {
  return {
    id: event.id,
    orderId,
    type,
    createdAt: (event.created_at ?? 0) * 1000,
    senderPubkey: event.pubkey,
    recipientPubkey: getTagValue(event.tags ?? [], "p") ?? "",
    rawContent: event.content ?? "",
  }
}

/** Shape admission only; signed product/fulfillment authority is checked separately. */
function hasCheckoutRouterFulfillmentShape(
  item: OrderSchema["items"][number],
  merchantPubkey: string
): boolean {
  if (item.format === "digital") {
    return (
      (item.fulfillment === undefined || item.fulfillment.type === "digital") &&
      (item.shippingCostSats ?? 0) === 0 &&
      item.shippingOptionId === undefined
    )
  }
  if (item.fulfillment?.type === "pickup") {
    // orderSchema already checks the product, option, cost and coherent graph.
    // A router marker additionally requires explicit SAT-only handoff terms.
    return (
      item.fulfillment.handoffMode !== undefined &&
      item.fulfillment.handlerPubkey !== undefined &&
      item.sourceShippingCost !== undefined &&
      item.sourceShippingCost.amount === item.shippingCostSats &&
      isSatsLikeCurrency(item.sourceShippingCost.currency) &&
      isSatsLikeCurrency(item.sourceShippingCost.normalizedCurrency) &&
      item.shippingCountries?.length === 0 &&
      item.shippingCountryRules?.length === 0
    )
  }
  return (
    item.fulfillment?.type === "shipping" &&
    item.shippingCostSats !== undefined &&
    Number.isSafeInteger(item.shippingCostSats) &&
    item.shippingCostSats >= 0 &&
    !!item.shippingOptionDTag &&
    item.shippingOptionId ===
      `30406:${merchantPubkey}:${item.shippingOptionDTag}` &&
    item.sourceShippingCost !== undefined &&
    item.sourceShippingCost.amount === item.shippingCostSats &&
    isSatsLikeCurrency(item.sourceShippingCost.currency) &&
    isSatsLikeCurrency(item.sourceShippingCost.normalizedCurrency)
  )
}

function parseCheckoutOrderPaymentRoute(
  event: OrderRumorEvent,
  payload: OrderSchema
): CheckoutOrderPaymentRoute | undefined {
  const tags = event.tags ?? []
  const markers = tags.filter(
    (tag) => tag[0] === CHECKOUT_SPARK_ROUTER_ORDER_TAG[0]
  )
  if (markers.length === 0) return undefined

  const exactlyOne = (name: string, value: string) => {
    const matches = tags.filter((tag) => tag[0] === name)
    return matches.length === 1 && matches[0]?.[1] === value
  }
  const buyer = event.pubkey.trim().toLowerCase()
  const merchant = payload.merchantPubkey.trim().toLowerCase()
  const itemTotal = payload.items.reduce(
    (sum, item) => sum + item.priceAtPurchase * item.quantity,
    0
  )
  const shippingTotal = payload.items.reduce(
    (sum, item) => sum + (item.shippingCostSats ?? 0) * item.quantity,
    0
  )
  const hasPhysical = payload.items.some((item) => item.format === "physical")
  const hasShipping = payload.items.some(
    (item) => item.fulfillment?.type === "shipping"
  )
  const itemTags = tags.filter((tag) => tag[0] === "item")
  const shippingTags = tags.filter((tag) => tag[0] === "shipping")
  const shippingItems = payload.items.filter(
    (item) => item.format === "physical"
  )
  if (
    markers.length !== 1 ||
    markers[0]?.length !== CHECKOUT_SPARK_ROUTER_ORDER_TAG.length ||
    markers[0]?.some(
      (value, index) => value !== CHECKOUT_SPARK_ROUTER_ORDER_TAG[index]
    ) ||
    event.kind !== EVENT_KINDS.ORDER ||
    !/^[0-9a-f]{64}$/.test(event.id) ||
    !/^[0-9a-f]{64}$/.test(buyer) ||
    !/^[0-9a-f]{64}$/.test(merchant) ||
    (payload.buyerIdentityKind !== "signed_in" &&
      payload.buyerIdentityKind !== "guest_ephemeral") ||
    payload.buyerPubkey.trim().toLowerCase() !== buyer ||
    !exactlyOne("p", merchant) ||
    !exactlyOne("type", "order") ||
    !exactlyOne("order", payload.id) ||
    !exactlyOne("amount", String(payload.subtotal)) ||
    !exactlyOne("currency", "SATS") ||
    payload.currency !== "SATS" ||
    !Number.isSafeInteger(payload.subtotal) ||
    payload.subtotal <= 0 ||
    !Number.isSafeInteger(itemTotal) ||
    !Number.isSafeInteger(shippingTotal) ||
    itemTotal + shippingTotal !== payload.subtotal ||
    (payload.shippingCostSats ?? 0) !== shippingTotal ||
    payload.shippingCostStatus !==
      (hasPhysical
        ? shippingTotal > 0
          ? "priced"
          : "included"
        : "not_required") ||
    (payload.shippingAddress !== undefined) !== hasShipping ||
    (payload.buyerIdentityKind !== "guest_ephemeral" &&
      payload.guestContact !== undefined) ||
    payload.items.some(
      (item, index) =>
        !hasCheckoutRouterFulfillmentShape(item, merchant) ||
        item.familyProductId !== undefined ||
        item.selectedSpecifications !== undefined ||
        (item.sourcePrice !== undefined &&
          (item.sourcePrice.amount !== item.priceAtPurchase ||
            !isSatsLikeCurrency(item.sourcePrice.currency) ||
            !isSatsLikeCurrency(item.sourcePrice.normalizedCurrency))) ||
        item.currency !== "SATS" ||
        !Number.isSafeInteger(item.quantity) ||
        !Number.isSafeInteger(item.priceAtPurchase) ||
        item.priceAtPurchase < 0 ||
        itemTags[index]?.length !== 3 ||
        itemTags[index]?.[1] !== item.productId ||
        itemTags[index]?.[2] !== String(item.quantity)
    ) ||
    itemTags.length !== payload.items.length ||
    shippingTags.length !== shippingItems.length ||
    shippingItems.some(
      (item, index) =>
        shippingTags[index]?.length !== 2 ||
        shippingTags[index]?.[1] !== item.shippingOptionId
    )
  ) {
    throw new Error("Invalid private checkout payment marker")
  }
  return "spark_router_v1"
}

/**
 * Parse an unwrapped kind-16 rumor into a typed order-conversation message.
 *
 * This parser is intentionally permissive for non-`order` message types so
 * MVP clients can handle mixed sender implementations while remaining
 * conservative in what we emit.
 */
export function parseOrderMessageRumorEvent(
  event: OrderRumorEvent
): ParsedOrderMessage {
  const type = orderMessageTypeSchema.parse(
    getTagValue(event.tags ?? [], "type") ?? "order"
  )
  const json = parseJsonObject(event.content ?? "")

  if (type === "order") {
    const payload = parseOrderRumorEvent(event)
    const orderId = getTagValue(event.tags ?? [], "order") ?? payload.id
    const checkoutPaymentRoute = parseCheckoutOrderPaymentRoute(event, payload)
    return {
      ...messageBase(event, type, orderId),
      payload,
      ...(checkoutPaymentRoute ? { checkoutPaymentRoute } : {}),
    }
  }

  const orderId =
    getTagValue(event.tags ?? [], "order") ??
    getString(json?.orderId) ??
    getString(json?.id) ??
    event.id

  if (type === "payment_request") {
    const payload = paymentRequestMessageSchema.parse({
      invoice: getString(json?.invoice) ?? event.content.trim(),
      amount:
        parseNumericTag(event.tags ?? [], "amount") ?? getNumber(json?.amount),
      currency:
        getTagValue(event.tags ?? [], "currency") ?? getString(json?.currency),
      note: getString(json?.note),
    })
    return { ...messageBase(event, type, orderId), payload }
  }

  if (type === "status_update") {
    const reopensTags: string[] = []
    for (const tag of event.tags ?? []) {
      if (tag[0] === "reopens" && typeof tag[1] === "string") {
        reopensTags.push(tag[1])
      }
    }
    const reopensTag = reopensTags[0]
    const reopensJson = getString(json?.reopens)
    if (
      new Set(reopensTags).size > 1 ||
      (reopensTag !== undefined &&
        reopensJson !== undefined &&
        reopensTag !== reopensJson)
    ) {
      throw new Error("Conflicting order status correction markers")
    }
    const payload = statusUpdateMessageSchema.parse({
      status:
        getTagValue(event.tags ?? [], "status") ?? getString(json?.status),
      note: getString(json?.note),
      reopens: reopensTag ?? reopensJson,
    })
    return { ...messageBase(event, type, orderId), payload }
  }

  if (type === "shipping_update") {
    const payload = shippingUpdateMessageSchema.parse({
      carrier:
        getTagValue(event.tags ?? [], "carrier") ?? getString(json?.carrier),
      trackingNumber:
        getTagValue(event.tags ?? [], "tracking") ??
        getString(json?.trackingNumber),
      trackingUrl: getString(json?.trackingUrl),
      note: getString(json?.note),
    })
    return { ...messageBase(event, type, orderId), payload }
  }

  if (type === "receipt") {
    const payload = receiptMessageSchema.parse({
      note:
        getString(json?.note) ??
        (json ? undefined : event.content.trim() || undefined),
    })
    return { ...messageBase(event, type, orderId), payload }
  }

  if (type === "message") {
    const payload = conversationMessageSchema.parse({
      note: getString(json?.note) ?? event.content.trim(),
    })
    return { ...messageBase(event, type, orderId), payload }
  }

  if (type === "payment_proof") {
    const payload = paymentProofMessageSchema.parse({
      ...(json ?? {}),
      version: getNumber(json?.version),
      orderId,
      rail: getTagValue(event.tags ?? [], "rail") ?? getString(json?.rail),
      action: getString(json?.action),
      amount:
        parseNumericTag(event.tags ?? [], "amount") ?? getNumber(json?.amount),
      amountMsats: getNumber(json?.amountMsats),
      currency:
        getTagValue(event.tags ?? [], "currency") ?? getString(json?.currency),
      invoice: getString(json?.invoice),
      preimage: getString(json?.preimage),
      paymentHash: getString(json?.paymentHash),
      feeMsats: getNumber(json?.feeMsats),
      zapRequestId: getString(json?.zapRequestId),
      zapReceiptId: getString(json?.zapReceiptId),
      source: getString(json?.source),
      proofDeliveryStatus: getString(json?.proofDeliveryStatus),
      verification: normalizePaymentProofVerification(json?.verification),
      note: getString(json?.note),
    })
    return { ...messageBase(event, type, orderId), payload }
  }

  if (type === "future_market_ready") {
    const payload = futureMarketReadyReceiptSchema.parse(json)
    return { ...messageBase(event, type, payload.claimRef), payload }
  }
  if (type === "future_market_revoked") {
    const payload = futureMarketRevocationSchema.parse(json)
    return { ...messageBase(event, type, payload.claimRef), payload }
  }
  if (type === "future_market_handed_out") {
    const payload = futureMarketHandoffAckSchema.parse(json)
    return { ...messageBase(event, type, payload.claimRef), payload }
  }

  return {
    ...messageBase(event, type, orderId),
    payload: json ?? { raw: event.content.trim() },
  }
}

export function buildLightningPaymentProofMessage(
  input: BuildLightningPaymentProofMessageInput
): PaymentProofMessageSchema & {
  version: 1
  rail: "lightning"
  action: PaymentProofActionSchema
  amount: number
  amountMsats: number
  currency: string
  invoice: string
  preimage: string
  source: PaymentProofSourceSchema
  proofDeliveryStatus?: PaymentProofDeliveryStatusSchema
} {
  const proof = lightningPaymentProofInputSchema.parse(input)
  return paymentProofMessageSchema.parse({
    version: 1,
    rail: "lightning",
    verification: {
      state: "buyer_evidence_received",
      checkedAt: Math.floor(Date.now() / 1000),
      checks: [],
    },
    ...proof,
  }) as PaymentProofMessageSchema & {
    version: 1
    rail: "lightning"
    action: PaymentProofActionSchema
    amount: number
    amountMsats: number
    currency: string
    invoice: string
    preimage: string
    source: PaymentProofSourceSchema
    proofDeliveryStatus?: PaymentProofDeliveryStatusSchema
  }
}
