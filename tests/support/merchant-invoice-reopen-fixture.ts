import type { OrderLifecycle, ParsedOrderMessage } from "@conduit/core"

export function makeMerchantInvoiceReopenEvidence(
  lifecycle: OrderLifecycle,
  options: {
    laterCancellation?: boolean
    merchantPaymentEvidence?: "paid_then_processing" | "shipping_update"
  } = {}
) {
  const cancellationEventId = "a".repeat(64)
  let createdAt = 1
  const merchantStatus = (
    id: string,
    status: string,
    reopens?: string
  ): ParsedOrderMessage =>
    ({
      id,
      orderId: lifecycle.orderId,
      type: "status_update",
      createdAt: createdAt++,
      senderPubkey: lifecycle.merchantPubkey,
      recipientPubkey: lifecycle.buyerPubkey,
      rawContent: "{}",
      payload: { status, ...(reopens ? { reopens } : {}) },
    }) as ParsedOrderMessage

  const messages: ParsedOrderMessage[] = [
    {
      id: "1".repeat(64),
      orderId: lifecycle.orderId,
      type: "order",
      createdAt: createdAt++,
      senderPubkey: lifecycle.buyerPubkey,
      recipientPubkey: lifecycle.merchantPubkey,
      rawContent: "{}",
      payload: {
        id: lifecycle.orderId,
        buyerPubkey: lifecycle.buyerPubkey,
        merchantPubkey: lifecycle.merchantPubkey,
        items: [],
        subtotal: lifecycle.totalSats,
        currency: lifecycle.currency,
        createdAt: 1,
      },
    } as ParsedOrderMessage,
    merchantStatus("9".repeat(64), "pending"),
  ]
  if (options.merchantPaymentEvidence === "paid_then_processing") {
    messages.push(
      merchantStatus("7".repeat(64), "paid"),
      merchantStatus("8".repeat(64), "processing")
    )
  } else if (options.merchantPaymentEvidence === "shipping_update") {
    messages.push({
      id: "8".repeat(64),
      orderId: lifecycle.orderId,
      type: "shipping_update",
      createdAt: createdAt++,
      senderPubkey: lifecycle.merchantPubkey,
      recipientPubkey: lifecycle.buyerPubkey,
      rawContent: "{}",
      payload: { carrier: "USPS", trackingNumber: "9234" },
    } as ParsedOrderMessage)
  }
  messages.push(
    merchantStatus(cancellationEventId, "cancelled"),
    merchantStatus(
      "b".repeat(64),
      options.merchantPaymentEvidence === "paid_then_processing"
        ? "processing"
        : "pending",
      cancellationEventId
    )
  )
  if (options.laterCancellation) {
    messages.push(merchantStatus("f".repeat(64), "cancelled"))
  }
  return { cancellationEventId, messages }
}
