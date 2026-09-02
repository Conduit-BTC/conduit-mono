import type { OrderLifecycle, ParsedOrderMessage } from "@conduit/core"

export function makeMerchantInvoiceReopenEvidence(
  lifecycle: OrderLifecycle,
  options: { laterCancellation?: boolean } = {}
) {
  const cancellationEventId = "a".repeat(64)
  const messages: ParsedOrderMessage[] = [
    {
      id: "1".repeat(64),
      orderId: lifecycle.orderId,
      type: "order",
      createdAt: 1,
      senderPubkey: lifecycle.buyerPubkey,
      recipientPubkey: lifecycle.merchantPubkey,
      rawContent: "{}",
      payload: {},
    } as ParsedOrderMessage,
    {
      id: "9".repeat(64),
      orderId: lifecycle.orderId,
      type: "status_update",
      createdAt: 2,
      senderPubkey: lifecycle.merchantPubkey,
      recipientPubkey: lifecycle.buyerPubkey,
      rawContent: "{}",
      payload: { status: "pending" },
    } as ParsedOrderMessage,
    {
      id: cancellationEventId,
      orderId: lifecycle.orderId,
      type: "status_update",
      createdAt: 3,
      senderPubkey: lifecycle.merchantPubkey,
      recipientPubkey: lifecycle.buyerPubkey,
      rawContent: "{}",
      payload: { status: "cancelled" },
    } as ParsedOrderMessage,
    {
      id: "b".repeat(64),
      orderId: lifecycle.orderId,
      type: "status_update",
      createdAt: 4,
      senderPubkey: lifecycle.merchantPubkey,
      recipientPubkey: lifecycle.buyerPubkey,
      rawContent: "{}",
      payload: { status: "pending", reopens: cancellationEventId },
    } as ParsedOrderMessage,
  ]
  if (options.laterCancellation) {
    messages.push({
      id: "f".repeat(64),
      orderId: lifecycle.orderId,
      type: "status_update",
      createdAt: 5,
      senderPubkey: lifecycle.merchantPubkey,
      recipientPubkey: lifecycle.buyerPubkey,
      rawContent: "{}",
      payload: { status: "cancelled" },
    } as ParsedOrderMessage)
  }
  return { cancellationEventId, messages }
}
