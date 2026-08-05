import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { DirectConversationListItem } from "../apps/merchant/src/components/DirectConversationListItem"
import { OrderCardScroller } from "../apps/merchant/src/components/OrderCardScroller"

describe("Merchant related orders UI", () => {
  it("uses the Orders list card in the Messages workspace", async () => {
    const source = await Bun.file(
      "apps/merchant/src/routes/messages.tsx"
    ).text()

    expect(source).toContain(
      'import { OrderCardScroller } from "../components/OrderCardScroller"'
    )
    expect(source).toContain("<OrderCardScroller")
    expect(source).toContain("<BuyerAvatar")
    expect(source).toContain("truncate text-lg font-semibold")
    expect(source).toContain('to: "/orders"')
    expect(source).toContain("search: { order: order.orderId }")
  })

  it("shows the buyer, order preview, total, and status", () => {
    const markup = renderToStaticMarkup(
      <OrderCardScroller
        conversations={[
          {
            id: "order-thread",
            orderId: "order-123",
            buyerPubkey: "buyer",
            merchantPubkey: "merchant",
            latestAt: Date.UTC(2026, 6, 21),
            latestType: "order",
            status: "pending",
            totalSummary: "100 SATS",
            preview: "Test t-shirt",
            messageCount: 1,
            messages: [],
            context: "complete",
          },
        ]}
        buyerName={() => "Satoshi"}
        buyerPicture={() => undefined}
        onSelect={() => undefined}
      />
    )

    expect(markup).toContain("Satoshi")
    expect(markup).toContain("Test t-shirt")
    expect(markup).toContain("100 SATS")
    expect(markup).toContain("Pending")
    expect(markup).toContain("overflow-x-auto")
    expect(markup).toContain("w-full min-w-0 max-w-full")
    expect(markup).toContain("linear-gradient(to right")
    expect(markup).not.toContain("touch-pan-x")
  })

  it("uses the Orders list selection style for buyer conversations", () => {
    const markup = renderToStaticMarkup(
      <DirectConversationListItem
        conversation={{
          id: "nip17:buyer",
          transport: "nip17",
          counterpartyPubkey: "b".repeat(64),
          latestAt: Date.UTC(2026, 6, 21),
          preview: "Where is my order?",
          messageCount: 2,
          unreadFromCounterparty: 1,
          messages: [],
        }}
        buyerName="Satoshi"
        active
        onClick={() => undefined}
      />
    )

    expect(markup).toContain("Satoshi")
    expect(markup).toContain("Where is my order?")
    expect(markup).toContain("1 unread")
    expect(markup).toContain("var(--primary-500)")
    expect(markup).toContain("rounded-[1.1rem]")
  })
})
