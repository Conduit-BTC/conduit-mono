import { describe, expect, it } from "bun:test"

describe("generic Market event fulfillment", () => {
  it("routes product grids and storefronts through the shared resolver card", async () => {
    const products = await Bun.file(
      "apps/market/src/routes/products/index.tsx"
    ).text()
    const store = await Bun.file(
      "apps/market/src/routes/store/$pubkey.tsx"
    ).text()
    const resolvedCard = await Bun.file(
      "apps/market/src/components/ResolvedProductGridCard.tsx"
    ).text()

    for (const route of [products, store]) {
      expect(route).toContain("ResolvedProductGridCard")
      expect(route).not.toContain("createCartItemFromProduct")
    }
    expect(resolvedCard).toContain("useProductCartFulfillment")
    expect(resolvedCard).toContain("isSameCartFulfillment")
    expect(resolvedCard).toContain("View event catalog")
    expect(resolvedCard).toContain("cartActionDisabled={blocked}")
  })

  it("keeps detail and related-product adds behind resolved fulfillment", async () => {
    const detail = await Bun.file(
      "apps/market/src/routes/products/$productId.tsx"
    ).text()
    const cart = await Bun.file("apps/market/src/routes/cart.tsx").text()

    expect(detail).toContain("useProductCartFulfillment")
    expect(detail).toContain("productCartCandidate")
    expect(detail).toContain("productCartBlocked")
    expect(detail).toContain("ResolvedProductGridCard")
    expect(detail).toContain("View event catalog")
    expect(detail).not.toContain(
      "cart.addItem(createCartItemFromProduct(product), quantity)"
    )

    expect(cart).toContain("useProductCartFulfillment(product, btcUsdRate)")
    expect(cart).toContain("fulfillmentBlocked")
    expect(cart).toContain("View event catalog")
    expect(cart).not.toContain("createCartItemFromProduct(product))")
  })

  it("re-resolves event pickup before checkout actions", async () => {
    const checkout = await Bun.file(
      "apps/market/src/routes/checkout.tsx"
    ).text()
    const hook = await Bun.file(
      "apps/market/src/hooks/useProductCartFulfillment.ts"
    ).text()

    expect(checkout).toContain("useProductCartFulfillmentBatch")
    expect(checkout).toContain("getCartEventFulfillmentBlock")
    expect(checkout).toContain("resolveProductCartFulfillment")
    expect(checkout).toContain("refreshResult.products.map")
    expect(checkout).toContain("bindCartItemsToFreshProductPricing")
    expect(
      checkout.match(
        /const freshCheckoutItems = await assertCheckoutItemsAvailable\(\)/g
      )
    ).toHaveLength(2)
    expect(
      checkout.match(/getFreshPricingIntent\(freshCheckoutItems\)/g)
    ).toHaveLength(2)
    expect(checkout).toContain("checkoutEvidenceIsChecking")
    expect(checkout).toContain("fulfillmentBlockingMessage")
    expect(checkout).toContain("Event pickup must be refreshed")
    expect(checkout).toContain("View event catalog")
    expect(hook).toContain("staleTime: 0")
    expect(hook).toContain('refetchOnMount: "always"')
  })
})
