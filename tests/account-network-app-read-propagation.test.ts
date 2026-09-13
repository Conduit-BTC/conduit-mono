import { describe, expect, it } from "bun:test"

async function source(path: string): Promise<string> {
  return await Bun.file(path).text()
}

describe("app account-network read propagation", () => {
  it("threads the signed-in Market account through event catalog and payment refreshes", async () => {
    const [
      eventHook,
      fulfillmentHook,
      adapter,
      authorization,
      checkout,
      orders,
    ] = await Promise.all([
      source("apps/market/src/hooks/useEventMarket.ts"),
      source("apps/market/src/hooks/useProductCartFulfillment.ts"),
      source("apps/market/src/lib/event-market-adapter.ts"),
      source("apps/market/src/lib/checkout-authorization.ts"),
      source("apps/market/src/routes/checkout.tsx"),
      source("apps/market/src/routes/orders.tsx"),
    ])

    expect(eventHook).toContain("loadEventCatalog(")
    expect(eventHook).toContain("authenticatedPubkey,")
    expect(eventHook).toContain("authGenerationRef.current === authGeneration")
    expect(fulfillmentHook).toContain("useConduitSession")
    expect(
      fulfillmentHook.match(/authGenerationRef\.current === authGeneration/g)
        ?.length
    ).toBe(2)
    expect(adapter).toContain("authenticatedPubkey?: string | null")
    expect(adapter).toContain(
      "reference: canonicalNaddr,\n    authenticatedPubkey,"
    )
    expect(adapter).toContain(
      "includeMerchantHiddenProductIds: requested,\n    authenticatedPubkey,\n    shouldContinue,"
    )
    expect(adapter).toContain(
      "includeMerchantHiddenProductIds: [item.productId],\n    authenticatedPubkey,\n    shouldContinue,"
    )
    expect(authorization).toContain("input.authenticatedPubkey")
    expect(authorization).toContain("input.shouldContinue")
    expect(checkout).toContain(
      'const draftOwnerIdentity = authStatus === "connected" ? pubkey : null'
    )
    expect(checkout).toContain(
      "requestingAccountPubkey: draftOwnerIdentity,\n        authenticatedPubkey: draftOwnerIdentity,"
    )
    expect(checkout).toContain("authGenerationRef.current === authGeneration")
    expect(
      orders.match(/row\.merchantPubkey,\s+authenticatedPubkey/g)?.length ?? 0
    ).toBeGreaterThanOrEqual(2)
    expect(
      orders.match(/authGenerationRef\.current === authGeneration/g)?.length
    ).toBeGreaterThanOrEqual(6)
  })

  it("threads account-only exclusions through exact products and cart suggestions", async () => {
    const [detailHook, readinessHook, cart, merchantOrders, commerce] =
      await Promise.all([
        source("apps/market/src/hooks/useProgressiveProducts.ts"),
        source("apps/market/src/hooks/useCartReadiness.ts"),
        source("apps/market/src/routes/cart.tsx"),
        source("apps/merchant/src/routes/orders.tsx"),
        source("packages/core/src/protocol/commerce.ts"),
      ])

    expect(detailHook).toContain("useConduitSession")
    expect(detailHook).toContain("getProductDetail({")
    expect(detailHook).toContain("authenticatedPubkey,")
    expect(readinessHook).toContain("getProductsByIds(productIds, {")
    expect(readinessHook).toContain("authenticatedPubkey,")
    expect(readinessHook).toContain("const { authGeneration } = useAuth()")
    expect(readinessHook).toContain(
      "authGenerationRef.current === readAuthGeneration"
    )
    expect(detailHook).toContain(
      "!cancelled && authGenerationRef.current === authGeneration"
    )
    expect(cart).toContain("getMarketplaceProducts({")
    expect(cart).toContain("accountPubkey,\n          authenticatedPubkey,")
    expect(merchantOrders).toContain("getProductsByIds(allOrderProductIds, {")
    expect(merchantOrders).toContain("authenticatedPubkey,")
    expect(merchantOrders).toContain(
      "authGenerationRef.current === authGeneration"
    )
    expect(merchantOrders).toContain('session.relayScope ?? "no-relay-scope"')

    const exactRead = commerce.slice(
      commerce.indexOf("export async function getProductsByIds("),
      commerce.indexOf("function resolveProductAvailabilityIssue(")
    )
    expect(exactRead).toContain("accountPubkey: options.authenticatedPubkey")
    expect(exactRead).toContain(
      "authenticatedPubkey: options.authenticatedPubkey"
    )
  })

  it("threads the signed-in shopper through initial, retry, and manual preset reads", async () => {
    const shopperPresets = await source(
      "apps/market/src/hooks/useShopperPresets.tsx"
    )

    expect(
      shopperPresets.match(/shouldContinue: isCurrentSession/g)
    ).toHaveLength(2)
    expect(shopperPresets).toContain(
      "fetchShopperPresets(identity, {\n        authenticatedPubkey: identity,\n        shouldContinue: () =>"
    )
    expect(
      shopperPresets.match(
        /isCurrentShopperPresetsRelayLifecycle\(\s+relayLifecycleRef\.current,\s+lifecycle\s+\)/g
      )?.length ?? 0
    ).toBeGreaterThanOrEqual(4)
  })

  it("threads explicit owner authority through media preference I/O", async () => {
    const [hook, controller, marketNetwork, merchantNetwork] =
      await Promise.all([
        source("packages/core/src/hooks/useMediaServerPreferences.ts"),
        source("packages/core/src/hooks/useAccountNetworkSettings.ts"),
        source("apps/market/src/routes/network.tsx"),
        source("apps/merchant/src/routes/network.tsx"),
      ])

    expect(
      hook.match(/authenticatedPubkey: normalizedAuthenticatedPubkey/g)
    ).toHaveLength(3)
    expect(
      hook.match(/authGenerationRef\.current === generation/g)
    ).toHaveLength(3)
    expect(hook).toContain(
      "useLayoutEffect(() => {\n    authGenerationRef.current = options.authGeneration ?? 0"
    )
    expect(hook).toContain('normalizedAuthenticatedPubkey ?? "anonymous"')
    expect(controller).toContain(
      'authenticatedPubkey: auth.status === "connected" ? auth.pubkey : null'
    )
    expect(marketNetwork).toContain(
      'useAccountNetworkSettings({ telemetryApp: "market" })'
    )
    expect(merchantNetwork).toMatch(
      /useAccountNetworkSettings\(\{\s*telemetryApp: "merchant",?\s*\}\)/
    )
  })

  it("aborts background account reconciliation when live authority changes", async () => {
    const [hook, reconciliation, ownerEvidence, inboxEvidence] =
      await Promise.all([
        source("packages/core/src/hooks/useAccountNetworkPreferences.ts"),
        source("packages/core/src/protocol/network-preferences.ts"),
        source("packages/core/src/protocol/owner-relay-list-evidence.ts"),
        source("packages/core/src/protocol/private-message-routing.ts"),
      ])

    expect(hook).toContain("const controller = new AbortController()")
    expect(hook).toContain("signal: controller.signal")
    expect(hook).toContain("controller.abort()")
    expect(reconciliation.match(/signal: options\.signal/g)).toHaveLength(2)
    expect(ownerEvidence).toContain("signal: options.signal")
    expect(inboxEvidence).toContain("signal: input.signal")
    expect(inboxEvidence).toContain("signal: options.signal")
  })

  it("never infers a viewed merchant as the authenticated account", async () => {
    const [discovery, trustHook, follows, merchantOrders] = await Promise.all([
      source("packages/core/src/protocol/event-market-discovery.ts"),
      source("packages/core/src/hooks/useShopperTrustEvidence.ts"),
      source("packages/core/src/protocol/follows.ts"),
      source("apps/merchant/src/routes/orders.tsx"),
    ])

    expect(discovery).not.toContain(
      "input.authenticatedPubkey ?? merchantPubkey"
    )
    expect(trustHook).not.toContain("authenticatedPubkey: merchantPubkey")
    expect(trustHook).toContain("options.authenticatedPubkey")
    expect(follows).not.toContain("authenticatedPubkey: normalizedViewerPubkey")
    expect(follows).toContain("accountPubkey: normalizedAccountPubkey")
    expect(merchantOrders).toContain(
      "authenticatedPubkey: signerConnected ? pubkey : null"
    )
  })

  it("keeps Merchant event reads bound to the live authenticated account", async () => {
    const [handoff, events, products] = await Promise.all([
      source("apps/merchant/src/lib/event-market-handoff.ts"),
      source("apps/merchant/src/routes/events.tsx"),
      source("apps/merchant/src/routes/products.tsx"),
    ])

    expect(handoff).toContain("authenticatedPubkey?: string | null")
    expect(handoff).toContain("authenticatedPubkey: input.authenticatedPubkey")
    expect(handoff).not.toContain("authenticatedPubkey: organizer")
    expect(events).toContain(
      'const authenticatedPubkey = status === "connected" ? pubkey : null'
    )
    expect(
      events.match(
        /resolveOrganizerHandoffMerchandise\(\{[\s\S]{0,160}authenticatedPubkey,/g
      )
    ).toHaveLength(2)
    expect(events).toMatch(
      /"merchant-organizer-handoff-merchandise",[\s\S]{0,160}authenticatedPubkey \?\? "disconnected"/
    )

    expect(products).toContain(
      'const authenticatedPubkey = authStatus === "connected" ? pubkey : null'
    )
    expect(products).toMatch(
      /listOrganizerEventMarkets\(\s*pubkey!,\s*authenticatedPubkey,\s*signal,\s*\(\) =>\s*!signal\.aborted && authGenerationRef\.current === authGeneration\s*\)/
    )
    expect(products).toMatch(
      /"merchant-product-event-market",[\s\S]{0,180}authenticatedPubkey \?\? "disconnected"/
    )
    expect(products).toMatch(
      /"merchant-product-event-context",[\s\S]{0,180}authenticatedPubkey \?\? "disconnected"/
    )
    expect(products).not.toContain(
      "resolveOrganizerEventMarket(reference, undefined, pubkey!)"
    )
  })

  it("threads account-only policy through storefront and profile presentation reads", async () => {
    const [
      storeProducts,
      marketOrders,
      publicProfile,
      progressiveProducts,
      productDetail,
      profileHook,
      marketMessages,
      merchantOrders,
      merchantMessages,
      merchantDashboard,
      merchantProducts,
      eventTemplates,
      marketCart,
      merchantIdentities,
      checkout,
      commerce,
    ] = await Promise.all([
      source("apps/market/src/lib/storeProducts.ts"),
      source("apps/market/src/routes/orders.tsx"),
      source("apps/market/src/routes/u/$profileRef.tsx"),
      source("apps/market/src/hooks/useProgressiveProducts.ts"),
      source("apps/market/src/routes/products/$productId.tsx"),
      source("packages/core/src/hooks/useProfiles.ts"),
      source("apps/market/src/routes/messages.tsx"),
      source("apps/merchant/src/routes/orders.tsx"),
      source("apps/merchant/src/routes/messages.tsx"),
      source("apps/merchant/src/routes/index.tsx"),
      source("apps/merchant/src/routes/products.tsx"),
      source("apps/merchant/src/lib/event-product-publishing.ts"),
      source("apps/market/src/components/MarketCartHud.tsx"),
      source("apps/market/src/hooks/useMerchantIdentities.ts"),
      source("apps/market/src/routes/checkout.tsx"),
      source("packages/core/src/protocol/commerce.ts"),
    ])

    expect(storeProducts).toContain("accountPubkey?: string | null")
    expect(storeProducts).toContain("authenticatedPubkey?: string | null")
    expect(storeProducts).toContain("accountPubkey,\n    authenticatedPubkey,")
    expect(marketOrders).toMatch(
      /fetchStoreProducts\(\s+row\.merchantPubkey,\s+authenticatedPubkey,\s+authenticatedPubkey,\s+\(\) => !signal\.aborted && shouldContinueAccountRead\(\)\s+\)/
    )
    expect(publicProfile).toMatch(
      /fetchStoreProducts\(\s*pubkey!,\s*accountPubkey,\s*authenticatedPubkey,\s*\(\) => !signal\.aborted && shouldContinueAccountRead\(\)\s*\)/
    )
    expect(progressiveProducts).toContain("accountPubkey: finalIoAccountPubkey")
    expect(productDetail).toContain("accountPubkey,")
    expect(profileHook).toContain("accountPubkey?: string | null")
    expect(profileHook).toContain("accountPubkey: options.accountPubkey")
    expect(profileHook).toContain("queryFn: async ({ signal })")
    expect(profileHook).toContain(
      "!signal.aborted && (options.shouldContinue?.() ?? true)"
    )
    expect(profileHook).toContain("signal,")
    expect(commerce).toContain("signal: query.signal")
    expect(commerce).toContain("signal: input.signal")
    expect(marketMessages).toContain(
      "accountPubkey: signerConnected ? pubkey : null,\n    authenticatedPubkey: signerConnected ? pubkey : null,"
    )
    expect(merchantOrders).toContain(
      "accountPubkey: authenticatedPubkey,\n    authenticatedPubkey,"
    )
    expect(merchantMessages).toContain(
      "accountPubkey: signerConnected ? pubkey : null,\n    authenticatedPubkey: signerConnected ? pubkey : null,"
    )
    expect(merchantDashboard).toMatch(
      /fetchDashboardStats\([\s\S]{0,180}!signal\.aborted && authGenerationRef\.current === authGeneration/
    )
    expect(merchantProducts).toContain(
      "{ accountPubkey, authenticatedPubkey, shouldContinue }"
    )
    expect(eventTemplates).toContain("accountPubkey: authenticatedPubkey,")
    expect(eventTemplates).toContain("authenticatedPubkey,")
    expect(eventTemplates).not.toContain("authenticatedPubkey: merchantPubkey")
    expect(marketCart).toContain("accountPubkey: authenticatedPubkey,")
    expect(marketCart).toContain("authenticatedPubkey,")
    expect(
      merchantIdentities.match(/accountPubkey,\n\s+authenticatedPubkey,/g)
        ?.length ?? 0
    ).toBeGreaterThanOrEqual(2)
    expect(checkout).toContain("accountPubkey={draftOwnerIdentity}")
    expect(checkout).toContain("authenticatedPubkey={draftOwnerIdentity}")
  })

  it("revalidates owner authority through profile refresh and publication", async () => {
    const [
      profiles,
      updateHook,
      marketProfile,
      merchantProfile,
      merchantPayments,
      checkout,
    ] = await Promise.all([
      source("packages/core/src/protocol/profiles.ts"),
      source("packages/core/src/hooks/useUpdateProfile.ts"),
      source("apps/market/src/routes/profile.tsx"),
      source("apps/merchant/src/routes/profile.tsx"),
      source("apps/merchant/src/routes/payments.tsx"),
      source("apps/market/src/routes/checkout.tsx"),
    ])

    expect(profiles).toContain("shouldContinue: opts?.shouldContinue")
    expect(profiles).toContain("shouldContinue: options.shouldContinue")
    expect(profiles).toContain("authenticatedPubkey,")
    expect(updateHook).toContain("authorityRef.current.authenticatedPubkey")
    expect(updateHook).toContain("authorityRef.current.authGeneration")
    expect(updateHook).toContain("publishProfile(profile, appId, {")
    for (const caller of [marketProfile, merchantProfile, merchantPayments]) {
      expect(caller).toContain("authenticatedPubkey,")
      expect(caller).toContain("authGeneration,")
    }
    expect(checkout).toContain(
      "shouldContinue: () => authGenerationRef.current === authGeneration"
    )
  })

  it("keeps organizer inbox and event-product action reads session-bound", async () => {
    const [checkout, products, eventProduct, publisher, events] =
      await Promise.all([
        source("apps/market/src/routes/checkout.tsx"),
        source("apps/merchant/src/routes/products.tsx"),
        source("apps/merchant/src/lib/event-product-publishing.ts"),
        source("apps/merchant/src/components/EventProductPublisherDialog.tsx"),
        source("apps/merchant/src/routes/events.tsx"),
      ])

    expect(checkout).toMatch(
      /resolveEventMarketOrganizerInbox\([\s\S]{0,220}authenticatedPubkey: draftOwnerIdentity,[\s\S]{0,40}signal,/
    )
    expect(products).toMatch(
      /resolveEventMarketOrganizerInbox\([\s\S]{0,240}authenticatedPubkey:[\s\S]{0,80}signal,/
    )
    expect(eventProduct).toContain("input.shouldContinue")
    expect(publisher).toContain("shouldContinue,")
    expect(events).toContain("shouldContinue={shouldContinue}")
  })

  it("threads account policy through shipping and public zap receipt I/O", async () => {
    const [
      shipping,
      checkout,
      merchantProducts,
      merchantShipping,
      merchantReadiness,
      lightning,
      paymentService,
      marketOrders,
      orderPublish,
      stockFulfillment,
      merchantOrders,
    ] = await Promise.all([
      source("packages/core/src/protocol/shipping.ts"),
      source("apps/market/src/routes/checkout.tsx"),
      source("apps/merchant/src/routes/products.tsx"),
      source("apps/merchant/src/routes/shipping.tsx"),
      source("apps/merchant/src/hooks/useMerchantReadiness.ts"),
      source("packages/core/src/protocol/lightning.ts"),
      source("apps/market/src/lib/order-payment-service.ts"),
      source("apps/market/src/routes/orders.tsx"),
      source("apps/market/src/lib/order-publish.ts"),
      source("apps/merchant/src/lib/order-stock-fulfillment.ts"),
      source("apps/merchant/src/routes/orders.tsx"),
    ])

    expect(shipping).toContain("accountNetworkLocalStateRepository")
    expect(checkout).toContain("accountPubkey: signedBuyerPubkey")
    expect(checkout).toContain("authenticatedPubkey: signedBuyerPubkey")
    expect(merchantProducts).toContain(
      "{ accountPubkey, authenticatedPubkey, shouldContinue }"
    )
    expect(merchantProducts).toContain(
      'authStatus === "connected" ? pubkey : null'
    )
    expect(merchantShipping).toContain("accountPubkey: pubkey")
    expect(merchantShipping).toContain(
      'authenticatedPubkey: authStatus === "connected" ? pubkey : null'
    )
    expect(merchantReadiness).toContain("accountPubkey: pubkey")
    expect(merchantReadiness).toContain(
      'authenticatedPubkey: authStatus === "connected" ? pubkey : null'
    )
    expect(stockFulfillment).toContain(
      "authenticatedPubkey: input.authenticatedPubkey"
    )
    expect(merchantOrders).toContain(
      'authenticatedPubkey: status === "connected" ? pubkey : null'
    )
    expect(lightning).toContain("accountPubkey,")
    expect(lightning).toContain("accountNetworkLocalStateRepository,")
    expect(paymentService).toContain("ctx.accountPubkey")
    expect(marketOrders).toContain("signerConnected ? activeBuyerPubkey : null")
    expect(
      orderPublish.match(/accountPubkey: input\.accountPubkey/g)
    ).toHaveLength(1)
    expect(orderPublish).toContain("accountPubkey,\n    authenticatedPubkey:")
    expect(checkout).toContain("accountPubkey: signedBuyerPubkey")
    expect(marketOrders).toContain("authenticatedPubkey ?? null")
  })
})
