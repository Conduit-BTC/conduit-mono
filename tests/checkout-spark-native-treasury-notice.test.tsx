import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

import { CheckoutSparkNativeTreasuryNotice } from "../apps/market/src/components/CheckoutSparkNativeTreasuryNotice"

describe("native Spark treasury disclosure", () => {
  it("records informed approval before funding without exposing treasury material", () => {
    const html = renderToStaticMarkup(
      <CheckoutSparkNativeTreasuryNotice
        estimatedBaseConduitAllocationSats={111}
        fixedCheckoutTotalSats={1_113}
        prepared={null}
      />
    )

    expect(html).toContain("Before funding")
    expect(html).toContain("111 sats")
    expect(html).toContain("best-effort Conduit allocation estimate")
    expect(html).toContain("unused, authorized recipient fee reserves")
    expect(html).toContain("fixed 1,113 sats buyer total")
    expect(html).toContain("configured Spark treasury")
    expect(html).toContain("saved order total cannot increase")
    expect(html).not.toContain("up to 2 sats")
    expect(html).not.toContain("spark-treasury.fixture")
    expect(html).not.toContain("spark-invoice.fixture")
    expect(html).not.toContain("<button")
  })

  it("places the authorization in checkout before the funding action", async () => {
    const route = await Bun.file("apps/market/src/routes/checkout.tsx").text()
    const notice = route.indexOf("<CheckoutSparkNativeTreasuryNotice")
    const fundingAction = route.indexOf("Continue to payment")

    expect(notice).toBeGreaterThan(0)
    expect(notice).toBeLessThan(fundingAction)
    expect(route).toMatch(
      /nativeTreasuryConfigured \? \(\s*<div[^>]*>\s*<CheckoutSparkNativeTreasuryNotice/
    )
    expect(route).toContain(
      "nativeTreasuryConfigured={nativeTreasuryConfigured}"
    )
    expect(route).toContain(
      "selectCheckoutSparkTreasuryAddress(configuration.network)"
    )
    expect(route).toMatch(
      /estimatedBaseConduitAllocationSats=\{\s*routerPrice\.conduitFeeSats\s*\}/
    )
    expect(route).toMatch(/fixedCheckoutTotalSats=\{routerPrice\.totalSats\}/)
  })

  it("shows the exact prepared native amount and zero-fee cap without claiming completion", () => {
    const html = renderToStaticMarkup(
      <CheckoutSparkNativeTreasuryNotice
        estimatedBaseConduitAllocationSats={111}
        fixedCheckoutTotalSats={1_113}
        prepared={{
          baseConduitAllocationSats: 110,
          unusedCommerceReserveSats: 4,
          totalSats: 114,
          sparkFeeCapSats: 0,
        }}
      />
    )

    expect(html).toContain("final Conduit payment is prepared for 114 sats")
    expect(html).toContain("actual 110 sats Conduit allocation")
    expect(html).toContain(
      "4 sats of unused, authorized recipient fee reserves"
    )
    expect(html).toContain("native Spark fee cap is 0 sats")
    expect(html).toContain("fixed 1,113 sats buyer total")
    expect(html).not.toContain("completed")
  })

  it("uses the native sidecar in Orders without requiring a Lightning review", async () => {
    const route = await Bun.file("apps/market/src/routes/orders.tsx").text()

    expect(route).toMatch(
      /settledRouterControl\.nativeTreasury && \(\s*<CheckoutSparkNativeTreasuryNotice/
    )
    expect(route).toMatch(
      /settledRouterControl\.status === "route_payout" &&\s*!settledRouterControl\.payoutReview &&\s*!settledRouterControl\.nativeTreasury\?\.prepared/
    )
    expect(route).toMatch(
      /prepared=\{settledRouterControl\.nativeTreasury\.prepared\}/
    )
    expect(route).toMatch(
      /result\.status === "paused" &&\s*result\.reason === "zero_remainder"/
    )
    expect(route).toContain(
      "No approved checkout credit remains for the final Conduit payment"
    )
  })
})
