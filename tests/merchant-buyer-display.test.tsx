import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

import {
  formatNpub,
  type MerchantConversationSummary,
  type ParsedOrderMessage,
  type Profile,
} from "@conduit/core"
import { OrderListItem } from "../apps/merchant/src/components/OrderListItem"

const buyerPubkey = "b".repeat(64)
const merchantPubkey = "a".repeat(64)

function conversation(
  buyerIdentityKind?: "signed_in" | "guest_ephemeral"
): MerchantConversationSummary {
  const orderId = `order-${buyerIdentityKind ?? "legacy"}`
  const order = {
    id: `${orderId}-message`,
    orderId,
    type: "order",
    createdAt: 1,
    senderPubkey: buyerPubkey,
    recipientPubkey: merchantPubkey,
    rawContent: "",
    payload: {
      id: orderId,
      buyerPubkey,
      merchantPubkey,
      items: [],
      subtotal: 10,
      currency: "SATS",
      createdAt: 1,
      ...(buyerIdentityKind ? { buyerIdentityKind } : {}),
    },
  } as ParsedOrderMessage

  return {
    id: orderId,
    orderId,
    buyerPubkey,
    merchantPubkey,
    latestAt: 1,
    latestType: "order",
    status: null,
    totalSummary: "10 SATS",
    preview: "Order received",
    messageCount: 1,
    messages: [order],
  }
}

function renderOrderRow(
  identityKind?: "signed_in" | "guest_ephemeral",
  buyerProfile?: Profile
): string {
  return renderToStaticMarkup(
    <OrderListItem
      conversation={conversation(identityKind)}
      buyerProfile={buyerProfile}
      active={false}
      onClick={() => undefined}
    />
  )
}

describe("merchant buyer display", () => {
  it("labels an explicitly tagged guest without durable profile decoration", () => {
    const html = renderOrderRow("guest_ephemeral", {
      pubkey: buyerPubkey,
      displayName: "Ephemeral profile",
      picture: "https://example.com/guest-avatar.png",
    })

    expect(html).toContain("Guest shopper")
    expect(html).not.toContain("Ephemeral profile")
    expect(html).not.toContain("guest-avatar.png")
    expect(html).not.toContain(formatNpub(buyerPubkey, 8))
  })

  it("keeps profile names for signed-in buyers", () => {
    const namedHtml = renderOrderRow("signed_in", {
      pubkey: buyerPubkey,
      displayName: "Alice Buyer",
    })
    const unresolvedHtml = renderOrderRow("signed_in")

    expect(namedHtml).toContain("Alice Buyer")
    expect(namedHtml).not.toContain("Guest shopper")
    expect(unresolvedHtml).toContain(formatNpub(buyerPubkey, 8))
  })

  it("keeps the formatted npub fallback for untagged legacy buyers", () => {
    const html = renderOrderRow()

    expect(html).toContain(formatNpub(buyerPubkey, 8))
    expect(html).not.toContain("Guest shopper")
  })

  it("shares the guest-aware order row between Merchant Home and Orders", async () => {
    const [homeSource, ordersSource, rowSource] = await Promise.all([
      Bun.file("apps/merchant/src/routes/index.tsx").text(),
      Bun.file("apps/merchant/src/routes/orders.tsx").text(),
      Bun.file("apps/merchant/src/components/OrderListItem.tsx").text(),
    ])

    expect(homeSource).toContain("<OrderListItem")
    expect(ordersSource).toContain("<OrderListItem")
    expect(homeSource).toContain("buyerProfile={")
    expect(ordersSource).toContain("buyerProfile={")
    expect(ordersSource).toContain("pubkeyToNpub(conversation.buyerPubkey)")
    expect(ordersSource).toContain("conversation.buyerPubkey,")
    expect(ordersSource).toContain("formatNpub(selected.buyerPubkey, 8)")
    expect(rowSource).toContain("getMerchantBuyerDisplayName")
  })
})
