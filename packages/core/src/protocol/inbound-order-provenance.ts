import type { NDKEvent } from "@nostr-dev-kit/ndk"
import type { CachedOrderMessage } from "../db"
import {
  parseCachedOrderMessage,
  parseOrderMessageRumorEvent,
  type ParsedOrderMessage,
} from "./orders"

type ParsedInboundOrder = Extract<ParsedOrderMessage, { type: "order" }>

export interface ValidatedInboundOrderLifecycleAnchor {
  readonly eventId: string
  readonly orderId: string
  readonly buyerPubkey: string
  readonly merchantPubkey: string
}

const anchorsByOrder = new WeakMap<
  ParsedInboundOrder,
  ValidatedInboundOrderLifecycleAnchor
>()
const validatedAnchors = new WeakSet<ValidatedInboundOrderLifecycleAnchor>()

function bindInboundOrderProvenance(
  order: ParsedInboundOrder
): ParsedInboundOrder {
  const orderId = order.orderId.trim()
  const buyerPubkey = order.senderPubkey.trim().toLowerCase()
  const merchantPubkey = order.recipientPubkey.trim().toLowerCase()
  if (
    !order.id ||
    !orderId ||
    !buyerPubkey ||
    !merchantPubkey ||
    buyerPubkey === merchantPubkey ||
    order.payload.id !== orderId ||
    order.payload.buyerPubkey.trim().toLowerCase() !== buyerPubkey ||
    order.payload.merchantPubkey.trim().toLowerCase() !== merchantPubkey
  ) {
    throw new Error("Inbound order provenance does not match its envelope.")
  }

  const anchor = Object.freeze({
    eventId: order.id,
    orderId,
    buyerPubkey,
    merchantPubkey,
  })
  anchorsByOrder.set(order, anchor)
  validatedAnchors.add(anchor)
  return order
}

/** Parse and brand an order only after the authenticated unwrap boundary. */
export function parseAuthenticatedInboundOrderRumor(
  rumor: NDKEvent
): ParsedOrderMessage {
  const message = parseOrderMessageRumorEvent(rumor)
  return message.type === "order"
    ? bindInboundOrderProvenance(message)
    : message
}

/** Parse and brand an order only after its durable cache envelope matches. */
export function parseValidatedCachedOrderMessageEnvelope(
  row: CachedOrderMessage
): ParsedOrderMessage | null {
  try {
    const message = parseCachedOrderMessage(JSON.parse(row.rawContent))
    if (
      message.id !== row.id ||
      message.orderId !== row.orderId ||
      message.type !== row.type ||
      message.senderPubkey !== row.senderPubkey ||
      message.recipientPubkey !== row.recipientPubkey ||
      message.createdAt !== row.createdAt
    ) {
      return null
    }
    return message.type === "order"
      ? bindInboundOrderProvenance(message)
      : message
  } catch {
    return null
  }
}

export function getValidatedInboundOrderLifecycleAnchor(input: {
  order: ParsedInboundOrder
  orderId: string
  buyerPubkey: string
  merchantPubkey: string
}): ValidatedInboundOrderLifecycleAnchor {
  const anchor = anchorsByOrder.get(input.order)
  if (
    !anchor ||
    anchor.orderId !== input.orderId.trim() ||
    anchor.buyerPubkey !== input.buyerPubkey.trim().toLowerCase() ||
    anchor.merchantPubkey !== input.merchantPubkey.trim().toLowerCase()
  ) {
    throw new Error(
      "Cannot authorize a self-record without a validated inbound order."
    )
  }
  return anchor
}

export function isValidatedInboundOrderLifecycleAnchor(
  anchor: ValidatedInboundOrderLifecycleAnchor
): boolean {
  return validatedAnchors.has(anchor)
}
