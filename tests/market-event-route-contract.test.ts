import { describe, expect, it } from "bun:test"

describe("Market event catalog route", () => {
  it("registers the canonical collection route and page title", async () => {
    const route = await Bun.file(
      "apps/market/src/routes/events/$collectionRef.tsx"
    ).text()
    const root = await Bun.file("apps/market/src/routes/__root.tsx").text()
    const tree = await Bun.file("apps/market/src/routeTree.gen.ts").text()

    expect(route).toContain('createFileRoute("/events/$collectionRef")')
    expect(root).toContain('pathname.startsWith("/events/")')
    expect(tree).toContain("'/events/$collectionRef'")
  })

  it("keeps Nostr reads in one adapter and renders organizer-neutral provenance", async () => {
    const route = await Bun.file(
      "apps/market/src/routes/events/$collectionRef.tsx"
    ).text()
    const adapter = await Bun.file(
      "apps/market/src/lib/event-market-adapter.ts"
    ).text()

    expect(route).toContain("useEventMarket")
    expect(route).not.toContain("getEventMarket(")
    expect(route).not.toContain("NDKEvent")
    expect(adapter).toContain("getEventMarket")
    expect(adapter).toContain("getProductsByIds")
    expect(adapter).toContain("resolveEventMarketProductParticipation")
    expect(route).toContain("Organizer identity")
    expect(route).toContain("operate an organizer registry")
    expect(route.toLowerCase()).not.toContain("chicago")
  })

  it("shows degraded, deleted, conflict, archive, and unlinked-product states", async () => {
    const route = await Bun.file(
      "apps/market/src/routes/events/$collectionRef.tsx"
    ).text()

    expect(route).toContain("Archived event catalog")
    expect(route).toContain("Event evidence is incomplete")
    expect(route).toContain("Event relays are unavailable")
    expect(route).toContain("Event catalog removed")
    expect(route).toContain("Conflicting event evidence")
    expect(route).toContain("no current")
    expect(route).toContain("exact merchant pickup link")
    expect(route).toContain("Checkout is disabled")
  })

  it("keeps products without a pickup snapshot out of cart and checkout", async () => {
    const route = await Bun.file(
      "apps/market/src/routes/events/$collectionRef.tsx"
    ).text()

    expect(route).toContain("const candidate = pickupFulfillment")
    expect(route).toContain("pickupFulfillment !== null")
    expect(route).toContain("!canAdd || !candidate")
    expect(route).not.toContain("pickupFulfillment ?? undefined")
  })

  it("keeps variable parent acceptance separate from exact child authority", async () => {
    const [route, adapter] = await Promise.all([
      Bun.file("apps/market/src/routes/events/$collectionRef.tsx").text(),
      Bun.file("apps/market/src/lib/event-market-adapter.ts").text(),
    ])

    expect(adapter).toContain("buildEventCatalogFamilyPickupFulfillments")
    expect(adapter).toContain("buildPickupFulfillmentSnapshot(")
    expect(route).toContain("entry.familyPickupFulfillments?.[")
    expect(route).toContain("authorizedChildren")
    expect(route).toContain("prepareProductCatalog(")
    expect(route).toContain("selectedProduct.id === product.id")
    expect(route).toContain('product.type !== "variable"')
    expect(route).toContain("cartItemInputFromProductSelection(")
  })

  it("keeps automatic payment retries behind pickup freshness checks", async () => {
    const orders = await Bun.file("apps/market/src/routes/orders.tsx").text()
    const checkout = await Bun.file(
      "apps/market/src/routes/checkout.tsx"
    ).text()
    const authorization = await Bun.file(
      "apps/market/src/lib/checkout-authorization.ts"
    ).text()

    expect(orders).toContain("verifyPickupCartFreshness")
    expect(orders).toContain("assertCartPickupHandlerReady")
    expect(orders).toContain(
      "row.lifecycle?.merchantPubkey ?? row.merchantPubkey"
    )
    expect(orders).toContain("async function retryPayment")
    expect(orders).toContain("runOrderPrivateFallback")
    expect(orders.indexOf("verifyPickupCartFreshness")).toBeLessThan(
      orders.lastIndexOf("runOrderPrivateFallback(ctx)")
    )
    expect(checkout).toContain("sourceShippingCost: item.sourceShippingCost")
    expect(authorization).toContain("resolveProductCartFulfillment")
    expect(authorization).toContain("assertCartPickupHandlerReady")
    expect(authorization).toContain("getCartCommerceFingerprint")
    const placeOrderStart = checkout.indexOf("async function placeOrder()")
    const payNowStart = checkout.indexOf("async function payNow(")
    const placeOrder = checkout.slice(placeOrderStart, payNowStart)
    const payNow = checkout.slice(payNowStart)
    for (const checkoutAction of [placeOrder, payNow]) {
      const freshnessGate = checkoutAction.indexOf(
        "await assertCheckoutItemsAvailable("
      )
      const orderIdentity = checkoutAction.indexOf(
        "const orderId = crypto.randomUUID()"
      )
      expect(freshnessGate).toBeGreaterThan(-1)
      expect(freshnessGate).toBeLessThan(orderIdentity)
    }
    expect(checkout.match(/orderSchema\.parse\(/g)?.length).toBe(2)
    expect(checkout.indexOf("orderSchema.parse(payload)")).toBeLessThan(
      checkout.indexOf("rumor.content = JSON.stringify(payload)")
    )
    expect(checkout.indexOf("orderSchema.parse(orderPayload)")).toBeLessThan(
      checkout.indexOf("orderRumor.content = JSON.stringify(orderPayload)")
    )
  })

  it("keeps the full buyer order merchant-only for both handoff modes", async () => {
    const checkout = await Bun.file(
      "apps/market/src/routes/checkout.tsx"
    ).text()

    expect(checkout.match(/\["p", selectedMerchant\]/g)?.length).toBe(2)
    expect(checkout).not.toContain('["p", pickupHandoff.handlerPubkey]')
    expect(checkout).not.toContain(
      "publishBuyerOrderMessage(\n          orderRumor,\n          ndk,\n          pickupHandoff.handlerPubkey"
    )
    expect(checkout.match(/publishBuyerOrderMessage\(/g)?.length).toBe(2)
  })

  it("keeps organizer-pickup evidence inside the fixed order sidebar", async () => {
    const orders = await Bun.file("apps/market/src/routes/orders.tsx").text()
    const costLabel = orders.indexOf("Resolved pickup cost")
    const panelStart = orders.lastIndexOf("<dl", costLabel)
    const panelEnd = orders.indexOf(
      "getPickupHandoffPrivacyCopy(handoff)",
      panelStart
    )
    const pickupPanel = orders.slice(panelStart, panelEnd)

    expect(costLabel).toBeGreaterThan(-1)
    expect(panelStart).toBeGreaterThan(-1)
    expect(panelEnd).toBeGreaterThan(panelStart)
    expect(pickupPanel).toContain(
      'className="mt-4 grid grid-cols-1 gap-3 border-t border-[var(--border)] pt-4 text-xs sm:grid-cols-2 xl:grid-cols-1"'
    )
  })

  it("lets order progress end independently of the taller sidebar", async () => {
    const orders = await Bun.file("apps/market/src/routes/orders.tsx").text()

    expect(orders).toContain(
      'className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_320px]"'
    )
  })
})
