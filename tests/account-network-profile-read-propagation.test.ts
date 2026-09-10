import { describe, expect, it } from "bun:test"

async function source(path: string): Promise<string> {
  return await Bun.file(path).text()
}

describe("authenticated account profile and storefront read propagation", () => {
  it("keeps the active Market account distinct through shared identity surfaces", async () => {
    const [
      cartHud,
      identities,
      browse,
      eventCatalog,
      productDetail,
      publicProfile,
      storeProducts,
    ] = await Promise.all([
      source("apps/market/src/components/MarketCartHud.tsx"),
      source("apps/market/src/hooks/useMerchantIdentities.ts"),
      source("apps/market/src/hooks/useMarketBrowseModel.ts"),
      source("apps/market/src/routes/events/$collectionRef.tsx"),
      source("apps/market/src/routes/products/$productId.tsx"),
      source("apps/market/src/routes/u/$profileRef.tsx"),
      source("apps/market/src/lib/storeProducts.ts"),
    ])

    expect(cartHud).toContain(
      'const authenticatedPubkey = status === "connected" ? pubkey : null'
    )
    expect(cartHud).toContain("accountPubkey: authenticatedPubkey,")
    expect(cartHud).toContain("authenticatedPubkey,")
    expect(identities).toContain("authenticatedPubkey?: string | null")
    expect(
      identities.match(/accountPubkey,\n\s+authenticatedPubkey,/g)?.length ?? 0
    ).toBeGreaterThanOrEqual(2)
    expect(browse).toContain("accountPubkey: authenticatedPubkey,")
    expect(eventCatalog).toContain("const accountPubkey = authenticatedPubkey")
    expect(eventCatalog).toContain("authenticatedPubkey,")
    expect(productDetail).toContain("const accountPubkey = authenticatedPubkey")
    expect(productDetail).toContain("authenticatedPubkey,")
    expect(publicProfile).toContain(
      "fetchStoreProducts(pubkey!, accountPubkey, authenticatedPubkey)"
    )
    expect(publicProfile).toContain('authenticatedPubkey ?? "anonymous"')
    expect(storeProducts).toContain("authenticatedPubkey?: string | null")
    expect(storeProducts).toContain("accountPubkey,\n    authenticatedPubkey,")
  })

  it("carries the signed-in Market account through cart and checkout profile reads", async () => {
    const [cart, checkout] = await Promise.all([
      source("apps/market/src/routes/cart.tsx"),
      source("apps/market/src/routes/checkout.tsx"),
    ])

    expect(cart).toContain("const accountPubkey = authenticatedPubkey")
    expect(cart).toContain('authenticatedPubkey ?? "anonymous"')
    expect(cart).toContain("accountPubkey,\n          authenticatedPubkey,")
    expect(
      cart.match(/authenticatedPubkey=\{authenticatedPubkey\}/g)?.length ?? 0
    ).toBeGreaterThanOrEqual(3)
    expect(checkout).toContain("authenticatedPubkey: string | null")
    expect(checkout).toContain("accountPubkey,\n    authenticatedPubkey,")
    expect(checkout).toContain("accountPubkey={draftOwnerIdentity}")
    expect(checkout).toContain("authenticatedPubkey={draftOwnerIdentity}")
  })

  it("uses only explicit Merchant authentication for storefront and organizer profiles", async () => {
    const [dashboard, eventTemplates, organizerPanel, eventsRoute] =
      await Promise.all([
        source("apps/merchant/src/routes/index.tsx"),
        source("apps/merchant/src/lib/event-product-publishing.ts"),
        source("apps/merchant/src/components/OrganizerEventMarketPanel.tsx"),
        source("apps/merchant/src/routes/events.tsx"),
      ])

    expect(dashboard).toContain(
      "fetchDashboardStats(pubkey!, pubkey!, pubkey!)"
    )
    expect(dashboard).toContain(
      "authenticatedPubkey: signerConnected ? pubkey : null"
    )
    expect(eventTemplates).toContain("accountPubkey: authenticatedPubkey,")
    expect(eventTemplates).toContain("authenticatedPubkey,")
    expect(eventTemplates).not.toContain("authenticatedPubkey: merchantPubkey")
    expect(organizerPanel).toContain("authenticatedPubkey: string | null")
    expect(organizerPanel).toContain("accountPubkey,\n    authenticatedPubkey,")
    expect(eventsRoute).toContain(
      'const authenticatedPubkey = status === "connected" ? pubkey : null'
    )
    expect(eventsRoute).toContain("authenticatedPubkey={authenticatedPubkey}")
  })
})
