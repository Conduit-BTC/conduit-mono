import { describe, expect, it } from "bun:test"

const APP_SOURCES = {
  market: {
    main: "apps/market/src/main.tsx",
    root: "apps/market/src/routes/__root.tsx",
    tree: "apps/market/src/routeTree.gen.ts",
    privacy: "apps/market/src/routes/privacy-policy.tsx",
    terms: "apps/market/src/routes/terms-of-service.tsx",
  },
  merchant: {
    main: "apps/merchant/src/main.tsx",
    root: "apps/merchant/src/routes/__root.tsx",
    tree: "apps/merchant/src/routeTree.gen.ts",
    privacy: "apps/merchant/src/routes/privacy-policy.tsx",
    terms: "apps/merchant/src/routes/terms-of-service.tsx",
  },
} as const

describe("Product legal routing contract", () => {
  it("generates both exact routes in both apps", async () => {
    for (const app of Object.values(APP_SOURCES)) {
      const tree = await Bun.file(app.tree).text()
      expect(tree).toContain("/privacy-policy")
      expect(tree).toContain("/terms-of-service")
    }
  })

  it("keeps app routes as thin wrappers around shared documents", async () => {
    const marketPrivacy = await Bun.file(APP_SOURCES.market.privacy).text()
    const merchantPrivacy = await Bun.file(APP_SOURCES.merchant.privacy).text()
    const marketTerms = await Bun.file(APP_SOURCES.market.terms).text()
    const merchantTerms = await Bun.file(APP_SOURCES.merchant.terms).text()

    expect(merchantPrivacy).toBe(marketPrivacy)
    expect(merchantTerms).toBe(marketTerms)
    expect(marketPrivacy).toContain("component: ProductPrivacyPolicy")
    expect(marketTerms).toContain("component: ProductTermsOfService")
  })

  it("branches before product providers and startup workflows", async () => {
    const marketMain = await Bun.file(APP_SOURCES.market.main).text()
    const merchantMain = await Bun.file(APP_SOURCES.merchant.main).text()

    for (const source of [marketMain, merchantMain]) {
      expect(source).toContain(
        "const isProductLegalEntry = isProductLegalPath(window.location.pathname)"
      )
      expect(source).toContain("if (isProductLegalEntry)")
      expect(source).toMatch(
        /if \(isProductLegalEntry\) \{[\s\S]*?<RouterProvider router=\{router\} \/>[\s\S]*?\} else \{/
      )
    }

    const marketElse = marketMain.slice(marketMain.indexOf("} else {"))
    expect(marketElse).toContain("pruneCommerceCaches")
    expect(marketElse).toContain("pruneGuestRecoveryState")
    expect(marketElse).toContain("<AuthProvider>")
    expect(marketElse).toContain("<ConduitSessionProvider")
    expect(marketElse).toContain("<MarketPricingWarmup />")

    const merchantElse = merchantMain.slice(merchantMain.indexOf("} else {"))
    expect(merchantElse).toContain("startProductDeletionDeliveryWorker")
    expect(merchantElse).toContain("void pruneShopperTrustSnapshots()")
    expect(merchantElse).toContain("<AuthProvider>")
    expect(merchantElse).toContain("<ConduitSessionProvider")
    const merchantBeforeElse = merchantMain.slice(
      0,
      merchantMain.indexOf("} else {")
    )
    expect(merchantBeforeElse).not.toContain(
      "startProductDeletionDeliveryWorker()"
    )
    expect(merchantBeforeElse).not.toContain(
      "void pruneShopperTrustSnapshots()"
    )
  })

  it("keeps telemetry and authenticated shells behind path-only root dispatch", async () => {
    for (const app of Object.values(APP_SOURCES)) {
      const root = await Bun.file(app.root).text()
      const dispatchStart = root.indexOf("function RootLayout()")
      const productRootStart = root.indexOf("function ", dispatchStart + 1)
      const dispatch = root.slice(dispatchStart, productRootStart)

      expect(dispatch).toContain("isProductLegalPath(pathname)")
      expect(dispatch).toContain("return <Outlet />")
      expect(dispatch).not.toContain("useAuth")
      expect(dispatch).not.toContain("recordBrowserTelemetry")
    }
  })

  it("keeps Product links local and cross-origin links no-referrer", async () => {
    const footer = await Bun.file(
      "packages/ui/src/components/LegalFooter.tsx"
    ).text()
    const merchantHeader = await Bun.file(
      "apps/merchant/src/components/MerchantHeader.tsx"
    ).text()
    const merchantRoot = await Bun.file(APP_SOURCES.merchant.root).text()

    expect(footer).toContain('termsHref = "/terms-of-service"')
    expect(footer).toContain('privacyHref = "/privacy-policy"')
    expect(merchantHeader).toContain('href: "/terms-of-service"')
    expect(merchantHeader).toContain('href: "/privacy-policy"')
    expect(merchantRoot).toContain('href="/terms-of-service"')
    expect(merchantRoot).toContain('href="/privacy-policy"')
    expect(footer).toContain('referrerPolicy="no-referrer"')
    expect(merchantHeader).toContain(
      'referrerPolicy={link.external ? "no-referrer" : undefined}'
    )
    expect(merchantHeader).toContain("external: false")
  })
})
