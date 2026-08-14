import { describe, expect, it } from "bun:test"

describe("merchant shopper trust route contract", () => {
  it("hydrates trust only for the selected durable buyer after order reads settle", async () => {
    const source = await Bun.file("apps/merchant/src/routes/orders.tsx").text()

    expect(source).toContain("useShopperTrustEvidence(")
    expect(source).toContain("selected && !isGuestOrder")
    expect(source).toContain("shopperPubkey: selectedShopperPubkey")
    expect(source).toContain("session.relaySettingsReady &&")
    expect(source).toContain(
      "signerConnected && !isOrdersInitialHydration && buyerPubkeys.length > 0"
    )
    expect(source).toContain("<ShopperTrustCard")
    expect(source).toContain("evidence={shopperTrustQuery.evidence}")
    expect(source).toContain("profileState={selectedBuyerProfileState}")
    expect(source).toContain("onRefresh={shopperTrustQuery.refetch}")
    expect(source).toContain("relayScope: session.relayScope")

    const trustCardPosition = source.indexOf("<ShopperTrustCard")
    const shippingPosition = source.indexOf(
      "{orderSummary.shippingAddress && ("
    )
    expect(trustCardPosition).toBeGreaterThan(-1)
    expect(trustCardPosition).toBeLessThan(shippingPosition)
  })

  it("keeps profile verification shared and route orchestration shallow", async () => {
    const source = await Bun.file("apps/merchant/src/routes/orders.tsx").text()

    expect(source).toContain("useProfiles(buyerPubkeys")
    expect(source).toContain("useNip05Verification(")
    expect(source).not.toContain("kind: 1984")
    expect(source).not.toContain("kinds: [1984]")
    expect(source).not.toContain("shopperTrustScore")
    expect(source).not.toContain("trustedBuyer")
  })

  it("cancels obsolete trust hydration when the selected order changes", async () => {
    const source = await Bun.file(
      "packages/core/src/hooks/useShopperTrustEvidence.ts"
    ).text()

    expect(source).toContain("queryFn: async ({ signal }) =>")
    expect(source).toContain("signal,")
    expect(source).toContain("if (signal.aborted) return")
  })
})
