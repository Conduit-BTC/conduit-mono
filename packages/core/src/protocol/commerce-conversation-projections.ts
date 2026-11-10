import type {
  BuyerConversationSummary,
  MerchantConversationSummary,
  DirectConversationSummary,
} from "./commerce"
import type { ParsedOrderMessage } from "./orders"
import type { ParsedDirectMessage } from "./messaging"
import { groupOrderConversationMessages } from "./order-conversation"
import { extractOrderSummary } from "./order-summary"
import { getEffectiveMerchantOrderStatus } from "./order-status"

function getConversationPreview(message: ParsedOrderMessage): string {
  switch (message.type) {
    case "order":
      return `Order for ${message.payload.subtotal} ${message.payload.currency}`
    case "payment_request":
      return message.payload.note ?? "Invoice sent"
    case "status_update":
      return (
        message.payload.note ?? `Status updated to ${message.payload.status}`
      )
    case "shipping_update":
      return message.payload.note ?? "Shipping updated"
    case "receipt":
      return message.payload.note ?? "Payment received"
    case "message":
      return message.payload.note
    case "payment_proof":
      return "Payment proof shared"
    default:
      return "Order update"
  }
}

export function buildBuyerConversationSummaries(
  messages: ParsedOrderMessage[],
  buyerPubkey: string
): BuyerConversationSummary[] {
  const conversations: BuyerConversationSummary[] = []
  for (const group of groupOrderConversationMessages(messages, buyerPubkey)) {
    if (group.buyerPubkey !== buyerPubkey) continue
    const { id, orderId, merchantPubkey, messages: bucket } = group
    bucket.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    const latest = bucket[bucket.length - 1]
    if (!latest) continue

    const effectiveStatus = getEffectiveMerchantOrderStatus(bucket, {
      buyerPubkey,
      merchantPubkey,
    })
    const summary = extractOrderSummary(bucket, {
      buyerPubkey,
      merchantPubkey,
    })

    conversations.push({
      id,
      orderId,
      merchantPubkey,
      latestAt: latest.createdAt,
      latestType: latest.type,
      status: effectiveStatus.status,
      totalSummary:
        summary.items.length > 0
          ? `${summary.subtotal} ${summary.currency}`
          : null,
      preview: getConversationPreview(latest),
      messageCount: bucket.length,
      messages: bucket,
      context: bucket.some((message) => message.type === "order")
        ? "complete"
        : "missing_order",
    })
  }

  conversations.sort((a, b) => b.latestAt - a.latestAt)
  return conversations
}

export function buildMerchantConversationSummaries(
  messages: ParsedOrderMessage[],
  merchantPubkey: string
): MerchantConversationSummary[] {
  const conversations: MerchantConversationSummary[] = []
  for (const group of groupOrderConversationMessages(
    messages,
    merchantPubkey
  )) {
    if (group.merchantPubkey !== merchantPubkey) continue
    const { id, orderId, buyerPubkey, messages: bucket } = group
    bucket.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    const latest = bucket[bucket.length - 1]
    if (!latest) continue

    const effectiveStatus = getEffectiveMerchantOrderStatus(bucket, {
      buyerPubkey,
      merchantPubkey,
    })
    const summary = extractOrderSummary(bucket, {
      buyerPubkey,
      merchantPubkey,
    })

    conversations.push({
      id,
      orderId,
      buyerPubkey,
      merchantPubkey,
      latestAt: latest.createdAt,
      latestType: latest.type,
      status: effectiveStatus.status,
      totalSummary:
        summary.items.length > 0
          ? `${summary.subtotal} ${summary.currency}`
          : null,
      preview: getConversationPreview(latest),
      messageCount: bucket.length,
      messages: bucket,
      context: bucket.some((message) => message.type === "order")
        ? "complete"
        : "missing_order",
    })
  }

  conversations.sort((a, b) => b.latestAt - a.latestAt)
  return conversations
}

export function counterpartyOf(
  message: ParsedDirectMessage,
  principalPubkey: string
): string {
  return message.senderPubkey === principalPubkey
    ? message.recipientPubkey
    : message.senderPubkey
}

export function buildDirectConversationSummaries(
  messages: ParsedDirectMessage[],
  principalPubkey: string,
  unreadMessageIds: ReadonlySet<string>
): DirectConversationSummary[] {
  const grouped = new Map<string, ParsedDirectMessage[]>()
  for (const message of messages) {
    const counterparty = counterpartyOf(message, principalPubkey)
    if (!counterparty) continue
    // The product supports two-party replies; extra p tags remain message metadata.
    const threadId = `${message.transport}:${counterparty}`
    const bucket = grouped.get(threadId) ?? []
    bucket.push(message)
    grouped.set(threadId, bucket)
  }

  const conversations: DirectConversationSummary[] = []
  for (const [id, bucket] of grouped.entries()) {
    bucket.sort((a, b) => a.createdAt - b.createdAt)
    const latest = bucket[bucket.length - 1]
    if (!latest) continue
    const counterpartyPubkey = counterpartyOf(latest, principalPubkey)
    conversations.push({
      id,
      transport: latest.transport,
      counterpartyPubkey,
      participants: latest.participants,
      latestAt: latest.createdAt,
      // Keep complete content so presentation can recognize structured legacy
      // envelopes before applying visual line clamping.
      preview: latest.content,
      messageCount: bucket.length,
      unreadFromCounterparty: bucket.filter(
        (message) =>
          message.senderPubkey === counterpartyPubkey &&
          unreadMessageIds.has(message.id)
      ).length,
      messages: bucket,
    })
  }

  conversations.sort((a, b) => b.latestAt - a.latestAt)
  return conversations
}
