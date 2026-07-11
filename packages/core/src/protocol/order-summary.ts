import { decodeLightningInvoiceAmount } from "./lightning"
import {
  isPaymentProofEvidenceMessage,
  type ParsedOrderMessage,
} from "./orders"

export type OrderSummary = {
  buyerIdentityKind: "signed_in" | "guest_ephemeral" | null
  items: Array<{
    productId: string
    title?: string
    quantity: number
    priceAtPurchase: number
    currency: string
    sourcePrice?: {
      amount: number
      currency: string
      normalizedCurrency: string
    }
  }>
  subtotal: number
  currency: string
  shippingAddress: {
    name: string
    street: string
    city: string
    state?: string
    postalCode: string
    country: string
  } | null
  guestContact: {
    email: string
    phone: string
  } | null
  orderNote: string | null
  invoiceSent: boolean
  invoiceCount: number
  invoiceAmount: number | null
  invoiceCurrency: string | null
  paymentProofReceived: boolean
  paymentProofCount: number
  paymentProofAmount: number | null
  paymentProofCurrency: string | null
  paymentReportReceived: boolean
  paymentReportCount: number
  paymentReportAmount: number | null
  paymentReportCurrency: string | null
  trackingCarrier: string | null
  trackingNumber: string | null
  trackingUrl: string | null
}

export function isExternalPaymentReportMessage(
  message: ParsedOrderMessage
): message is Extract<ParsedOrderMessage, { type: "payment_proof" }> {
  if (message.type !== "payment_proof") return false
  const verificationState = message.payload.verification?.state
  if (
    verificationState === "verification_failed" ||
    verificationState === "disputed"
  ) {
    return false
  }

  return (
    Boolean(message.payload.invoice) &&
    (message.payload.action === "external_invoice" ||
      message.payload.source === "external")
  )
}

/**
 * Extract a structured order summary from a list of parsed order messages.
 *
 * Finds the first `order` message for items/shipping, the latest
 * `payment_request` for invoice info, the latest payment proof with evidence
 * for buyer-paid confirmation, and the latest `shipping_update` for tracking.
 */
export function extractOrderSummary(
  messages: ParsedOrderMessage[]
): OrderSummary {
  const firstOrder = messages.find((m) => m.type === "order")
  const latestInvoice = [...messages]
    .reverse()
    .find((m) => m.type === "payment_request")
  const invoiceCount = messages.filter(
    (message) => message.type === "payment_request"
  ).length
  const paymentProofMessages = messages.filter(isPaymentProofEvidenceMessage)
  const latestPaymentProof = [...paymentProofMessages].reverse()[0]
  const paymentProofCount = paymentProofMessages.length
  const paymentReportMessages = messages.filter(
    (message) =>
      isPaymentProofEvidenceMessage(message) ||
      isExternalPaymentReportMessage(message)
  )
  const latestPaymentReport = [...paymentReportMessages].reverse()[0]
  const paymentReportCount = paymentReportMessages.length
  const latestShipping = [...messages]
    .reverse()
    .find((m) => m.type === "shipping_update")

  const items =
    firstOrder?.type === "order"
      ? firstOrder.payload.items.map((item) => ({
          productId: item.productId,
          title: item.title,
          quantity: item.quantity,
          priceAtPurchase: item.priceAtPurchase,
          currency: item.currency,
          sourcePrice: item.sourcePrice,
        }))
      : []

  const subtotal =
    firstOrder?.type === "order" ? firstOrder.payload.subtotal : 0
  const currency =
    firstOrder?.type === "order" ? firstOrder.payload.currency : "USD"

  const shippingAddress =
    firstOrder?.type === "order" && firstOrder.payload.shippingAddress
      ? {
          name: firstOrder.payload.shippingAddress.name,
          street: firstOrder.payload.shippingAddress.street,
          city: firstOrder.payload.shippingAddress.city,
          state: firstOrder.payload.shippingAddress.state,
          postalCode: firstOrder.payload.shippingAddress.postalCode,
          country: firstOrder.payload.shippingAddress.country,
        }
      : null

  const guestContact =
    firstOrder?.type === "order" && firstOrder.payload.guestContact
      ? {
          email: firstOrder.payload.guestContact.email,
          phone: firstOrder.payload.guestContact.phone,
        }
      : null

  const orderNote =
    firstOrder?.type === "order" && firstOrder.payload.note
      ? firstOrder.payload.note
      : null

  const invoiceSent = latestInvoice?.type === "payment_request"
  const decodedInvoice =
    latestInvoice?.type === "payment_request"
      ? decodeLightningInvoiceAmount(latestInvoice.payload.invoice)
      : null
  const invoiceAmount =
    latestInvoice?.type === "payment_request"
      ? (decodedInvoice?.sats ??
        decodedInvoice?.msats ??
        latestInvoice.payload.amount ??
        null)
      : null
  const invoiceCurrency =
    latestInvoice?.type === "payment_request"
      ? (decodedInvoice?.currency ?? latestInvoice.payload.currency ?? null)
      : null
  const paymentProofReceived = Boolean(latestPaymentProof)
  const paymentProofAmount = latestPaymentProof?.payload.amount ?? null
  const paymentProofCurrency = latestPaymentProof?.payload.currency ?? null
  const paymentReportReceived = Boolean(latestPaymentReport)
  const paymentReportAmount = latestPaymentReport?.payload.amount ?? null
  const paymentReportCurrency = latestPaymentReport?.payload.currency ?? null

  const trackingCarrier =
    latestShipping?.type === "shipping_update"
      ? (latestShipping.payload.carrier ?? null)
      : null
  const trackingNumber =
    latestShipping?.type === "shipping_update"
      ? (latestShipping.payload.trackingNumber ?? null)
      : null
  const trackingUrl =
    latestShipping?.type === "shipping_update"
      ? (latestShipping.payload.trackingUrl ?? null)
      : null

  return {
    buyerIdentityKind:
      firstOrder?.type === "order"
        ? (firstOrder.payload.buyerIdentityKind ?? null)
        : null,
    items,
    subtotal,
    currency,
    shippingAddress,
    guestContact,
    orderNote,
    invoiceSent,
    invoiceCount,
    invoiceAmount,
    invoiceCurrency,
    paymentProofReceived,
    paymentProofCount,
    paymentProofAmount,
    paymentProofCurrency,
    paymentReportReceived,
    paymentReportCount,
    paymentReportAmount,
    paymentReportCurrency,
    trackingCarrier,
    trackingNumber,
    trackingUrl,
  }
}
