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

  it("uses the current shared catalog reader with session cancellation", async () => {
    const route = await Bun.file(
      "apps/market/src/routes/events/$collectionRef.tsx"
    ).text()
    const page = await Bun.file(
      "apps/market/src/components/FutureEventMarketPage.tsx"
    ).text()
    expect(route).toContain("<FutureEventMarketPage")
    expect(route).toContain(
      "decodeEventMarketReference(collectionRef, [30409])"
    )
    expect(route).toContain("This event needs to be reposted")
    expect(page).toContain("readEventMarketCatalog({")
    expect(page).toContain(
      "shouldContinue: () => !signal.aborted && shouldContinue()"
    )
    expect(page).toContain("queryClient.setQueryData(catalogQueryKey, result)")
    expect(page).not.toContain("NDKEvent")
  })

  it("keeps organizer identity, share links, selected merchant, and selected date visible", async () => {
    const route = await Bun.file(
      "apps/market/src/routes/events/$collectionRef.tsx"
    ).text()
    const page = await Bun.file(
      "apps/market/src/components/FutureEventMarketPage.tsx"
    ).text()
    expect(page).toContain("Organized by")
    expect(page).toContain(
      "getMerchantDisplayName(organizerProfile, organizerPubkey"
    )
    expect(page).toContain("shareUrl={shareUrl}")
    expect(page).toContain(
      'shareLabel={selectedMerchant ? "Share this view" : "Share event"}'
    )
    expect(route).toContain("selectedOccurrence={search.occurrence}")
    expect(route).toContain(
      "selectedMerchant={normalizePubkey(search.merchant)"
    )
    expect(route).toContain("merchant: pubkeyToNpub(merchant)")
  })

  it("distinguishes provisional browsing from exact purchase checks", async () => {
    const page = await Bun.file(
      "apps/market/src/components/FutureEventMarketPage.tsx"
    ).text()
    expect(page).toContain('catalog.coverage !== "complete"')
    expect(page).toContain("More products may be available.")
    expect(page).toContain(
      "The current signed Event Market record is unavailable."
    )
    expect(page).toContain("This Event Market is closed to new purchases.")
    expect(page).toContain("Event records could not be checked. Try again.")
    expect(page).toContain("readEventMarketProduct({")
    expect(page).toContain("createEventMarketPickupSnapshot({")
    expect(page.indexOf("readEventMarketProduct({")).toBeLessThan(
      page.indexOf("await cart.addItem(")
    )
  })

  it("preserves reversible shipping choices and exact occurrence context", async () => {
    const page = await Bun.file(
      "apps/market/src/components/FutureEventMarketPage.tsx"
    ).text()
    const cart = await Bun.file(
      "apps/market/src/components/CartEventFulfillmentChoice.tsx"
    ).text()
    expect(page).toContain('choice === "shipping"')
    expect(page).toContain(
      "hasEventShippingChoice(productRead.resolution.product)"
    )
    expect(page).toContain("eventMarketContext:")
    expect(page).toContain(
      "calendarCoordinate: fulfillment.calendar.coordinate"
    )
    expect(cart).toContain("event_market_pickup")
    expect(cart).toContain("shipping")
  })

  it("keeps product selection tied to the exact chosen listing", async () => {
    const page = await Bun.file(
      "apps/market/src/components/FutureEventMarketPage.tsx"
    ).text()
    expect(page).toContain("cartItemInputFromProductSelection(")
    expect(page).toContain("productRead.resolution.product")
    expect(page).toContain("navigateToProduct")
    expect(page).toContain('to: "/products/$productId"')
    expect(page).toContain("event: market.coordinate")
  })

  it("keeps automatic payment retries behind pickup freshness checks", async () => {
    const orders = await Bun.file("apps/market/src/routes/orders.tsx").text()
    const checkout = await Bun.file(
      "apps/market/src/routes/checkout.tsx"
    ).text()
    const authorization = await Bun.file(
      "apps/market/src/lib/checkout-authorization.ts"
    ).text()

    expect(orders).toContain("verifyRetryFreshness")
    expect(orders).toContain("assertCartPickupHandlerReady")
    expect(orders).toContain("assertCreatedEventMarketPickupTerms({")
    expect(orders).toContain("async function retryPayment")
    expect(orders).toContain("runOrderPrivateFallback")
    expect(orders.indexOf("verifyRetryFreshness")).toBeLessThan(
      orders.lastIndexOf("await runOrderPrivateFallback({")
    )
    expect(checkout).toContain("sourceShippingCost: item.sourceShippingCost")
    expect(authorization).toContain(
      "resolveCurrentFutureEventMarketFulfillments"
    )
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
      const orderIdentity = checkoutAction.indexOf("const orderId =")
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

  it("keeps shopper pickup details concise in the order sidebar", async () => {
    const orders = await Bun.file("apps/market/src/routes/orders.tsx").text()

    expect(orders).toContain("Handled by")
    expect(orders).toContain("Pickup code")
    expect(orders).toContain("View event market")
    expect(orders).not.toContain("Resolved pickup cost")
    expect(orders).not.toContain("Calendar revision")
    expect(orders).not.toContain("Pickup revision")
    expect(orders).not.toContain("getPickupHandoffPrivacyCopy(handoff)")
    expect(orders).not.toContain("Copy pickup handler npub")
  })

  it("lets order progress end independently of the taller sidebar", async () => {
    const orders = await Bun.file("apps/market/src/routes/orders.tsx").text()

    expect(orders).toContain(
      'className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_320px]"'
    )
  })
})
