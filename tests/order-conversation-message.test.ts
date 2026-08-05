import { describe, expect, it } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { ParsedOrderMessage } from "@conduit/core"
import { getConversationPreview, OrderConversationMessage } from "@conduit/ui"

function statusMessage(status: string): ParsedOrderMessage {
  return {
    id: `status-${status}`,
    orderId: "order-1",
    type: "status_update",
    createdAt: 1,
    senderPubkey: "merchant",
    recipientPubkey: "buyer",
    rawContent: "",
    payload: { status },
  } as ParsedOrderMessage
}

describe("order conversation status presentation", () => {
  it("uses the canonical display label for known statuses", () => {
    expect(getConversationPreview(statusMessage("refund_requested"))).toBe(
      "Status updated to Refund requested"
    )
  })

  it("keeps unknown incoming statuses readable", () => {
    expect(getConversationPreview(statusMessage("awaiting_fulfillment"))).toBe(
      "Status updated to Awaiting Fulfillment"
    )
  })

  it("uses the shopper amount formatter for previews and order details", () => {
    const message = {
      id: "order-message",
      orderId: "order-1",
      type: "order",
      createdAt: 1,
      senderPubkey: "buyer",
      recipientPubkey: "merchant",
      rawContent: "",
      payload: {
        id: "order-1",
        merchantPubkey: "merchant",
        buyerPubkey: "buyer",
        items: [
          {
            productId: "30402:merchant:item",
            title: "Tea",
            quantity: 1,
            priceAtPurchase: 10,
            currency: "EUR",
            sourcePrice: {
              amount: 10,
              currency: "EUR",
              normalizedCurrency: "EUR",
            },
          },
        ],
        subtotal: 12_000,
        currency: "SATS",
        createdAt: 1,
      },
    } as ParsedOrderMessage
    const formatAmount = (amount: number, currency: string) => ({
      primary: currency === "SATS" ? `₿${amount}` : `€${amount}`,
      secondary: currency === "EUR" ? "₿12,000" : null,
    })

    expect(getConversationPreview(message, formatAmount)).toBe(
      "Order for ₿12000"
    )
    const html = renderToStaticMarkup(
      createElement(OrderConversationMessage, {
        message,
        mine: true,
        formatAmount,
      })
    )
    expect(html).toContain("Total: ₿12000")
    expect(html).toContain("€10")
    expect(html).toContain("₿12,000")
  })

  it("keeps sub-satoshi invoice amounts exact instead of rounding to sats", () => {
    const message = {
      id: "invoice-message",
      orderId: "order-1",
      type: "payment_request",
      createdAt: 1,
      senderPubkey: "merchant",
      recipientPubkey: "buyer",
      rawContent: "",
      payload: {
        invoice: "not-a-decodable-invoice",
        amount: 999,
        currency: "MSATS",
      },
    } as ParsedOrderMessage

    const html = renderToStaticMarkup(
      createElement(OrderConversationMessage, {
        message,
        mine: false,
        formatAmount: () => ({
          primary: "Price unavailable",
          secondary: null,
        }),
      })
    )

    expect(html).toContain("999 msats")
    expect(html).not.toContain("Price unavailable")
  })
})
