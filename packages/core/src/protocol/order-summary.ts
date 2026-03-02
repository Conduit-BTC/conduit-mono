import type { ParsedOrderMessage } from "./orders"

export type OrderSummary = {
  items: Array<{
    productId: string
    quantity: number
    priceAtPurchase: number
    currency: string
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
  orderNote: string | null
  invoiceSent: boolean
  invoiceAmount: number | null
  invoiceCurrency: string | null
  trackingCarrier: string | null
  trackingNumber: string | null
  trackingUrl: string | null
}

/**
 * Extract a structured order summary from a list of parsed order messages.
 *
 * Finds the first `order` message for items/shipping, the latest
 * `payment_request` for invoice info, and the latest `shipping_update`
 * for tracking details.
 */
export function extractOrderSummary(messages: ParsedOrderMessage[]): OrderSummary {
  const firstOrder = messages.find((m) => m.type === "order")
  const latestInvoice = [...messages].reverse().find((m) => m.type === "payment_request")
  const latestShipping = [...messages].reverse().find((m) => m.type === "shipping_update")

  const items =
    firstOrder?.type === "order"
      ? firstOrder.payload.items.map((item) => ({
          productId: item.productId,
          quantity: item.quantity,
          priceAtPurchase: item.priceAtPurchase,
          currency: item.currency,
        }))
      : []

  const subtotal = firstOrder?.type === "order" ? firstOrder.payload.subtotal : 0
  const currency = firstOrder?.type === "order" ? firstOrder.payload.currency : "USD"

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

  const orderNote =
    firstOrder?.type === "order" && firstOrder.payload.note
      ? firstOrder.payload.note
      : null

  const invoiceSent = latestInvoice?.type === "payment_request"
  const invoiceAmount =
    latestInvoice?.type === "payment_request" ? (latestInvoice.payload.amount ?? null) : null
  const invoiceCurrency =
    latestInvoice?.type === "payment_request" ? (latestInvoice.payload.currency ?? null) : null

  const trackingCarrier =
    latestShipping?.type === "shipping_update" ? (latestShipping.payload.carrier ?? null) : null
  const trackingNumber =
    latestShipping?.type === "shipping_update"
      ? (latestShipping.payload.trackingNumber ?? null)
      : null
  const trackingUrl =
    latestShipping?.type === "shipping_update" ? (latestShipping.payload.trackingUrl ?? null) : null

  return {
    items,
    subtotal,
    currency,
    shippingAddress,
    orderNote,
    invoiceSent,
    invoiceAmount,
    invoiceCurrency,
    trackingCarrier,
    trackingNumber,
    trackingUrl,
  }
}
