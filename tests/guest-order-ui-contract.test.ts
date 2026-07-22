import { describe, expect, it } from "bun:test"
import {
  buildMerchantOrderRumorTags,
  getMerchantOrderDeliveryRecipients,
} from "@conduit/core"

describe("guest order UI contracts", () => {
  it("publishes guest operations to the merchant self-copy only", () => {
    expect(
      getMerchantOrderDeliveryRecipients({
        merchantPubkey: "merchant",
        buyerPubkey: "ephemeral-guest",
        delivery: "self_only",
      })
    ).toEqual(["merchant"])
    expect(
      getMerchantOrderDeliveryRecipients({
        merchantPubkey: "merchant",
        buyerPubkey: "buyer",
        delivery: "buyer_and_self",
      })
    ).toEqual(["buyer", "merchant"])
    expect(
      buildMerchantOrderRumorTags({
        buyerPubkey: "ephemeral-guest",
        orderId: "guest-order",
        type: "shipping_update",
      })
    ).toContainEqual(["p", "ephemeral-guest"])
  })

  it("keeps buyer recovery local and disables guest relay inbox reads", async () => {
    const source = await Bun.file("apps/market/src/routes/orders.tsx").text()

    expect(source).toContain("enabled: signerConnected")
    expect(source).toContain("guestIdentity.expiresAt - Date.now()")
    expect(source).toContain("clearSessionGuestOrderSigningIdentity")
    expect(source).toContain("pruneExpiredGuestOrderData")
    expect(source).not.toContain("expectedCounterpartyPubkey")
  })

  it("records guest fulfillment without claiming a guest relay inbox", async () => {
    const source = await Bun.file("apps/merchant/src/routes/orders.tsx").text()
    const publisher = await Bun.file(
      "packages/core/src/protocol/merchant-order-publish.ts"
    ).text()

    expect(source).toContain("assertBuyerHasNostrInbox()")
    expect(source).toContain("delivery: operationalDelivery")
    expect(source).toContain("readOnly={!buyerInboxKnown}")
    expect(source).toContain('"Record shipping update"')
    expect(source).toContain('"guest_ephemeral"')
    expect(source).toContain("return false")
    expect(source).toContain("This guest has no Nostr reply inbox")
    expect(source).toContain("assertPaidForFulfillment()")
    expect(source).not.toContain("{!isGuestOrder && (")
    expect(publisher).toContain(
      'export type MerchantOrderDelivery = "buyer_and_self" | "self_only"'
    )
    expect(publisher).toContain("publishPrivateMessage({")
    expect(publisher).toContain('selfCopy: input.delivery === "buyer_and_self"')
    expect(publisher).not.toContain("giftWrap(")
  })

  it("keeps all kind-16 publishers on the shared private-message boundary", async () => {
    const buyerPublisher = await Bun.file(
      "apps/market/src/lib/order-publish.ts"
    ).text()
    const ordersRoute = await Bun.file(
      "apps/market/src/routes/orders.tsx"
    ).text()

    expect(buyerPublisher).toContain("publishPrivateMessage")
    expect(buyerPublisher).not.toContain("giftWrap(")
    expect(ordersRoute).toContain("publishBuyerOrderMessage(")
    expect(ordersRoute).not.toContain("giftWrap(")
  })

  it("omits guest contact and shipping details from durable buyer history", async () => {
    const source = await Bun.file("apps/market/src/routes/checkout.tsx").text()

    expect(source).toContain("shippingAddress: guestIdentity")
    expect(source).toContain("contactNote: guestIdentity ? undefined")
    expect(source).toContain("guestContact: undefined")
    expect(source).toContain("createdAt: orderCreatedAt")
    expect(source).toContain("clearCheckoutShippingSession()")
  })

  it("maintains guest key and checkout PII expiry outside checkout", async () => {
    const source = await Bun.file("apps/market/src/main.tsx").text()

    expect(source).toContain("pruneExpiredSessionGuestOrderSigningIdentities()")
    expect(source).toContain("pruneExpiredCheckoutShippingSession()")
    expect(source).toContain('window.addEventListener("focus"')
    expect(source).toContain('window.addEventListener("visibilitychange"')
  })
})
