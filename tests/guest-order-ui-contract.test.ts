import { describe, expect, it } from "bun:test"

describe("guest order UI contracts", () => {
  it("keeps buyer recovery local and disables guest relay inbox reads", async () => {
    const source = await Bun.file("apps/market/src/routes/orders.tsx").text()

    expect(source).toContain("enabled: signerConnected")
    expect(source).toContain("guestIdentity.expiresAt - Date.now()")
    expect(source).toContain("clearSessionGuestOrderSigningIdentity")
    expect(source).toContain("pruneExpiredGuestOrderData")
    expect(source).not.toContain("expectedCounterpartyPubkey")
  })

  it("removes guest Nostr actions and excludes guests from invoice metrics", async () => {
    const source = await Bun.file("apps/merchant/src/routes/orders.tsx").text()

    expect(source).toContain("assertBuyerHasNostrInbox()")
    expect(source).toContain("{!isGuestOrder && (")
    expect(source).toContain(
      '<TabsTrigger value="actions">Actions</TabsTrigger>'
    )
    expect(source).toContain('"guest_ephemeral"')
    expect(source).toContain("return false")
    expect(source).toContain("Guest activity is inbound-only")
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
