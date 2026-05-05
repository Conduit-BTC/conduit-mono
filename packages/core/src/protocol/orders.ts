import type { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  conversationMessageSchema,
  orderMessageTypeSchema,
  orderSchema,
  paymentProofMessageSchema,
  paymentRequestMessageSchema,
  receiptMessageSchema,
  shippingUpdateMessageSchema,
  statusUpdateMessageSchema,
  type ConversationMessageSchema,
  type OrderMessageTypeSchema,
  type OrderSchema,
  type PaymentProofMessageSchema,
  type PaymentRequestMessageSchema,
  type ReceiptMessageSchema,
  type ShippingUpdateMessageSchema,
  type StatusUpdateMessageSchema,
} from "../schemas"

/**
 * Parse a Conduit MVP order rumor event (kind 16) from its JSON content.
 */
export function parseOrderRumorEvent(event: Pick<NDKEvent, "content">): OrderSchema {
  const parsed = JSON.parse(event.content || "{}") as unknown
  return orderSchema.parse(parsed)
}

type OrderRumorEvent = Pick<NDKEvent, "id" | "created_at" | "content" | "tags" | "pubkey">

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
  | (ParsedOrderMessageBase & { type: "order"; payload: OrderSchema })
  | (ParsedOrderMessageBase & { type: "payment_request"; payload: PaymentRequestMessageSchema })
  | (ParsedOrderMessageBase & { type: "status_update"; payload: StatusUpdateMessageSchema })
  | (ParsedOrderMessageBase & { type: "shipping_update"; payload: ShippingUpdateMessageSchema })
  | (ParsedOrderMessageBase & { type: "receipt"; payload: ReceiptMessageSchema })
  | (ParsedOrderMessageBase & { type: "message"; payload: ConversationMessageSchema })
  | (ParsedOrderMessageBase & { type: "payment_proof"; payload: PaymentProofMessageSchema })

function getTagValue(tags: string[][] | undefined, name: string): string | null {
  for (const tag of tags ?? []) {
    if (tag[0] === name && typeof tag[1] === "string") return tag[1]
  }
  return null
}

function parseNumericTag(tags: string[][] | undefined, name: string): number | undefined {
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

function getNumber(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined
  return Number.isFinite(value) ? value : undefined
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

/**
 * Parse an unwrapped kind-16 rumor into a typed order-conversation message.
 *
 * This parser is intentionally permissive for non-`order` message types so
 * MVP clients can handle mixed sender implementations while remaining
 * conservative in what we emit.
 */
export function parseOrderMessageRumorEvent(event: OrderRumorEvent): ParsedOrderMessage {
  const type = orderMessageTypeSchema.parse(getTagValue(event.tags ?? [], "type") ?? "order")
  const json = parseJsonObject(event.content ?? "")

  if (type === "order") {
    const payload = parseOrderRumorEvent(event)
    const orderId = getTagValue(event.tags ?? [], "order") ?? payload.id
    return { ...messageBase(event, type, orderId), payload }
  }

  const orderId =
    getTagValue(event.tags ?? [], "order") ?? getString(json?.orderId) ?? getString(json?.id) ?? event.id

  if (type === "payment_request") {
    const payload = paymentRequestMessageSchema.parse({
      invoice: getString(json?.invoice) ?? event.content.trim(),
      amount: parseNumericTag(event.tags ?? [], "amount") ?? getNumber(json?.amount),
      currency: getTagValue(event.tags ?? [], "currency") ?? getString(json?.currency),
      note: getString(json?.note),
    })
    return { ...messageBase(event, type, orderId), payload }
  }

  if (type === "status_update") {
    const payload = statusUpdateMessageSchema.parse({
      status: getTagValue(event.tags ?? [], "status") ?? getString(json?.status),
      note: getString(json?.note),
    })
    return { ...messageBase(event, type, orderId), payload }
  }

  if (type === "shipping_update") {
    const payload = shippingUpdateMessageSchema.parse({
      carrier: getTagValue(event.tags ?? [], "carrier") ?? getString(json?.carrier),
      trackingNumber: getTagValue(event.tags ?? [], "tracking") ?? getString(json?.trackingNumber),
      trackingUrl: getString(json?.trackingUrl),
      note: getString(json?.note),
    })
    return { ...messageBase(event, type, orderId), payload }
  }

  if (type === "receipt") {
    const payload = receiptMessageSchema.parse({
      note: getString(json?.note) ?? (json ? undefined : event.content.trim() || undefined),
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
      invoice: getString(json?.invoice),
      preimage: getString(json?.preimage),
      paymentHash: getString(json?.paymentHash),
      feeMsats: getNumber(json?.feeMsats),
      note: getString(json?.note),
    })
    return { ...messageBase(event, type, orderId), payload }
  }

  return {
    ...messageBase(event, type, orderId),
    payload: json ?? { raw: event.content.trim() },
  }
}
