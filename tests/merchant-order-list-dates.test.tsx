import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type {
  MerchantConversationSummary,
  ParsedOrderMessage,
} from "@conduit/core"
import { OrderListItem } from "../apps/merchant/src/components/OrderListItem"

const placedAt = Date.UTC(2026, 8, 29, 17)
const updatedAt = Date.UTC(2026, 9, 1, 17)
const buyerPubkey = "a".repeat(64)
const merchantPubkey = "b".repeat(64)
const conversation: MerchantConversationSummary = {
  id: "order-dates",
  orderId: "order-dates",
  buyerPubkey,
  merchantPubkey,
  latestAt: updatedAt,
  latestType: "order",
  status: "pending",
  totalSummary: "100 SATS",
  preview: "Order",
  messageCount: 1,
  messages: [
    {
      id: "order-dates-message",
      orderId: "order-dates",
      type: "order",
      createdAt: placedAt,
      senderPubkey: buyerPubkey,
      recipientPubkey: merchantPubkey,
      rawContent: "",
      payload: {
        id: "order-dates",
        buyerPubkey,
        merchantPubkey,
        createdAt: placedAt,
        items: [],
        subtotal: 100,
        currency: "SATS",
      },
    } as ParsedOrderMessage,
  ],
}

describe("Merchant order list dates", () => {
  it("distinguishes when the order was placed from its latest update", () => {
    const html = renderToStaticMarkup(
      <OrderListItem
        conversation={conversation}
        active={false}
        onClick={() => {}}
      />
    )
    expect(html).toContain(`dateTime="${new Date(placedAt).toISOString()}"`)
    expect(html).toContain(`dateTime="${new Date(updatedAt).toISOString()}"`)
    expect(html).toContain(`Placed ${new Date(placedAt).toLocaleDateString()}`)
    expect(html).toContain(
      `Updated ${new Date(updatedAt).toLocaleDateString()}`
    )
  })

  it("does not mislabel latest activity as the placed date in partial history", () => {
    const html = renderToStaticMarkup(
      <OrderListItem
        conversation={{ ...conversation, messages: [] }}
        active={false}
        onClick={() => {}}
      />
    )
    expect(html.includes("Placed date unavailable")).toBe(true)
    expect(
      html.includes(`Updated ${new Date(updatedAt).toLocaleDateString()}`)
    ).toBe(true)
    expect(
      html.includes(`Placed ${new Date(updatedAt).toLocaleDateString()}`)
    ).toBe(false)
  })
})
