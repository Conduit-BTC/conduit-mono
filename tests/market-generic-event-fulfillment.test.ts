import { describe, expect, it } from "bun:test"

describe("generic Market event fulfillment", () => {
  it("routes product grids and storefronts through the shared resolver card", async () => {
    const products = await Bun.file(
      "apps/market/src/routes/products/index.tsx"
    ).text()
    const store = await Bun.file(
      "apps/market/src/routes/$identityRef.tsx"
    ).text()
    const resolvedCard = await Bun.file(
      "apps/market/src/components/ResolvedProductGridCard.tsx"
    ).text()

    for (const route of [products, store]) {
      expect(route).toContain("ResolvedProductGridCard")
      expect(route).not.toContain("createCartItemFromProduct")
    }
    expect(resolvedCard).toContain("useProductCartFulfillment")
    expect(resolvedCard).toContain("selectCartLine")
    expect(resolvedCard).toContain('resolution?.status === "standard"')
    expect(resolvedCard).toContain("type: resolution.type")
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
    expect(detail).toContain("let candidate = productCartCandidate")
    expect(detail).toContain("await readEventShippingProduct({")
    expect(detail).toContain("expectedEventId: candidate.productEventId")
    expect(detail).toContain("if (!shouldContinue()) return")
    expect(detail).toContain("cart.addItem(candidate, quantity)")
    expect(detail).toContain(
      "cart.refreshAndIncrementItem(cartItem, candidate, quantity)"
    )
    expect(detail).not.toContain("cart.incrementItem(cartItem")
    expect(detail).toContain("ResolvedProductGridCard")
    expect(detail).toContain("View event catalog")
    expect(detail).not.toContain(
      "cart.addItem(createCartItemFromProduct(product), quantity)"
    )

    expect(cart).toContain(
      "useProductCartFulfillment(selectedProduct, btcUsdRate)"
    )
    expect(cart).toContain("fulfillmentBlocked")
    expect(cart).toContain("cart.addItem(cartCandidate)")
    expect(cart).toContain(
      "cart.refreshAndIncrementItem(existing, cartCandidate)"
    )
    expect(cart).not.toContain(
      "cart.incrementItem(existing, 1, selectedProduct.stock)"
    )
    expect(cart).toContain('resolution?.status === "standard"')
    expect(cart).toContain("type: resolution.type")
    expect(cart).not.toContain("createCartItemFromProduct(product))")
  })

  it("resolves and mutates the selected signed child across product grids", async () => {
    const [products, store, detail, event, resolvedCard, variations] =
      await Promise.all([
        Bun.file("apps/market/src/routes/products/index.tsx").text(),
        Bun.file("apps/market/src/routes/$identityRef.tsx").text(),
        Bun.file("apps/market/src/routes/products/$productId.tsx").text(),
        Bun.file("apps/market/src/components/FutureEventMarketPage.tsx").text(),
        Bun.file(
          "apps/market/src/components/ResolvedProductGridCard.tsx"
        ).text(),
        Bun.file("apps/market/src/lib/productVariations.ts").text(),
      ])

    for (const route of [products, store, detail]) {
      expect(route).toContain("<ResolvedProductGridCard")
      expect(route).toContain("family={")
    }
    expect(resolvedCard).toContain(
      "useProductCartFulfillment(selectedProduct, btcUsdRate)"
    )
    expect(resolvedCard).toContain("cartItemInputFromProductSelection(")
    expect(resolvedCard).toContain("selectCartLine(cart.items, cartCandidate)")
    expect(resolvedCard).toContain("cart.addItem(cartCandidate, 1)")
    expect(resolvedCard).toContain(
      "cart.refreshAndIncrementItem(existing, cartCandidate, 1)"
    )
    expect(resolvedCard).not.toContain("cart.incrementItem(existing")
    expect(event).toContain(
      "onSelectedProductChange={(selected) => setSelectedProductId(selected.id)}"
    )
    expect(event).toContain('selected.type === "variable" ||')
    expect(event).toContain("selected.id !== entry.productCoordinate")
    expect(event).toContain("navigateToProduct(selected.id)")
    expect(event).toContain(
      "productRead.resolution.revision.id !== entry.resolution.revision.id"
    )
    expect(event).toContain("productCoordinate: entry.productCoordinate")
    expect(event).toContain("cartItemInputFromProductSelection(")
    expect(event).toContain("await cart.addItem(")
    expect(event).not.toContain(
      "cart.incrementItem(existing, 1, selectedProduct.stock)"
    )
    expect(resolvedCard).toContain("cart.removeItem(existing)")
    expect(resolvedCard).toContain("cart.decrementItem(existing)")
    expect(resolvedCard).toContain("selectedProductId={selectedProduct.id}")
    expect(variations).toContain("familyProductId:")
    expect(variations).toContain("selectedSpecifications:")

    const card = await Bun.file(
      "apps/market/src/components/ProductGridCard.tsx"
    ).text()
    expect(card.match(/\{ allowZero: allowZeroPrice \}/g)).toHaveLength(2)
  })

  it("re-resolves event pickup before checkout actions", async () => {
    const checkout = await Bun.file(
      "apps/market/src/routes/checkout.tsx"
    ).text()
    const hook = await Bun.file(
      "apps/market/src/hooks/useProductCartFulfillment.ts"
    ).text()
    const authorization = await Bun.file(
      "apps/market/src/lib/checkout-authorization.ts"
    ).text()

    expect(checkout).not.toContain("useProductCartFulfillmentBatch")
    expect(checkout).not.toContain("getCartEventFulfillmentBlock")
    expect(checkout).toContain("authorizeCurrentCheckoutItems")
    expect(
      checkout.match(/await assertCheckoutItemsAvailable\(/g)
    ).toHaveLength(2)
    expect(
      checkout.match(/getFreshPricingRateInput\(checkoutItems\)/g)
    ).toHaveLength(2)
    expect(authorization).toContain(
      "resolveCurrentFutureEventMarketFulfillments"
    )
    expect(authorization).toContain("await dependencies.readMarket({")
    expect(authorization).toContain("await dependencies.readProduct({")
    expect(authorization).toContain("!productRead.actionable")
    expect(authorization).toContain(
      'productRead.resolution.state !== "eligible"'
    )
    expect(authorization).toContain(
      "currentProduct.sourceEventId !== productRead.resolution.revision.id"
    )
    expect(authorization).toContain(
      "ordinaryProducts.map(resolveProductCartFulfillment)"
    )
    expect(authorization).toContain("assertCartPickupHandlerReady")
    expect(authorization).toContain("rebuildCurrentCartItems")
    expect(authorization).toContain("getCartCommerceFingerprint")
    expect(checkout).toContain("checkoutEvidenceIsChecking")
    expect(checkout).toContain("fulfillmentBlockingMessage")
    expect(checkout).not.toContain("Event pickup must be refreshed")
    expect(hook).toContain("resolveProductCartFulfillment(product)")
    expect(hook).not.toContain("useEventCatalogs")
    const ordinary = await Bun.file(
      "apps/market/src/lib/product-cart-fulfillment.ts"
    ).text()
    expect(ordinary).toContain(
      'type: product.format === "digital" ? "digital" : "shipping"'
    )
    expect(ordinary).toContain('status: "standard"')
  })
})
