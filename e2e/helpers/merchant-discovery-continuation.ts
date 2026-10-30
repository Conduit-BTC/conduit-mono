import type { BrowserContext, Route } from "@playwright/test"

const REAL_MODULE_QUERY = "merchant-discovery-continuation-real"

function realModuleUrl(requestUrl: string): string {
  const url = new URL(requestUrl)
  url.searchParams.set(REAL_MODULE_QUERY, "1")
  return url.href
}

function moduleShim(
  route: Route,
  fixtureModuleUrl: string,
  exports: readonly string[]
): Promise<void> {
  if (new URL(route.request().url()).searchParams.has(REAL_MODULE_QUERY)) {
    return route.fallback()
  }
  const real = realModuleUrl(route.request().url())
  return route.fulfill({
    status: 200,
    contentType: "application/javascript; charset=utf-8",
    headers: { "cache-control": "no-store" },
    body: [
      `export * from ${JSON.stringify(real)};`,
      `export { ${exports.join(", ")} } from ${JSON.stringify(fixtureModuleUrl)};`,
    ].join("\n"),
  })
}

/**
 * Replace only the two system boundaries needed by this mounted UI fixture.
 * Every other Core and Merchant export comes from the real Vite module.
 */
export async function installMerchantDiscoveryContinuationModules(
  context: BrowserContext,
  fixtureModuleUrl: string
): Promise<() => Promise<void>> {
  const coreRoutes = [
    "**/packages/core/src/index.ts*",
    "**/@conduit_core.js*",
  ] as const
  const reconciliationRoute =
    "**/src/lib/checkout-spark-order-reconciliation.ts*"
  const coreHandler = (route: Route) =>
    moduleShim(route, fixtureModuleUrl, [
      "createMerchantCheckoutSparkRecoveryDiscovery",
    ])
  const reconciliationHandler = (route: Route) =>
    moduleShim(route, fixtureModuleUrl, [
      "advanceMerchantCheckoutSparkOrder",
      "reconcileMerchantCheckoutSparkOrder",
    ])

  for (const pattern of coreRoutes) {
    await context.route(pattern, coreHandler)
  }
  await context.route(reconciliationRoute, reconciliationHandler)

  return async () => {
    for (const pattern of coreRoutes) {
      await context.unroute(pattern, coreHandler)
    }
    await context.unroute(reconciliationRoute, reconciliationHandler)
  }
}
