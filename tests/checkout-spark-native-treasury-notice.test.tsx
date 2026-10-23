import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

import { CheckoutSparkNativeTreasuryNotice } from "../apps/market/src/components/CheckoutSparkNativeTreasuryNotice"
import { getCheckoutSparkSettledOutcomeMessage } from "../apps/market/src/lib/checkout-spark-settled-outcome-message"

describe("checkout payment approval disclosure", () => {
  it("keeps required approval in a plain note without treasury jargon", () => {
    const html = renderToStaticMarkup(
      <CheckoutSparkNativeTreasuryNotice
        estimatedBaseConduitAllocationSats={111}
        fixedCheckoutTotalSats={1_113}
        prepared={null}
      />
    )

    expect(html).toContain("fixed total of 1,113 sats")
    expect(html).toContain("best-effort 111 sats Conduit fee estimate")
    expect(html).toContain("payment reserves")
    expect(html).toContain("Conduit is paid last")
    expect(html).toContain("unused authorized reserves")
    expect(html).toContain("no increase to your total")
    expect(html).toStartWith("<p ")
    expect(html).not.toContain("<section")
    expect(html).not.toContain("<h3")
    expect(html).not.toContain("rounded-")
    expect(html).not.toContain("Spark")
    expect(html).not.toContain("treasury")
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

  it("keeps the approval without duplicate gray fee commentary", async () => {
    const route = await Bun.file("apps/market/src/routes/checkout.tsx").text()

    expect(route.includes("<CheckoutSparkNativeTreasuryNotice")).toBe(true)
    expect(
      route.includes("The coordination fee includes the network estimate.")
    ).toBe(false)
    expect(route.includes("Shipping is not included until quoted")).toBe(true)
  })

  it("does not turn prepared payment data into another detail panel or completion claim", () => {
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

    expect(html).toContain("fixed total of 1,113 sats")
    expect(html).toContain("Conduit is paid last")
    expect(html).not.toContain("114 sats")
    expect(html).not.toContain("110 sats")
    expect(html).not.toContain("4 sats")
    expect(html).not.toContain("fee cap")
    expect(html).not.toContain("<section")
    expect(html).not.toContain("Spark")
    expect(html).not.toContain("treasury")
    expect(html).not.toContain("completed")
  })

  it("keeps native dispatch independent of a treasury detail panel or Lightning review", async () => {
    const route = await Bun.file("apps/market/src/routes/orders.tsx").text()

    expect(route.includes("CheckoutSparkNativeTreasuryNotice")).toBe(false)
    expect(route).toMatch(
      /settledRouterControl\.status === "route_payout" &&\s*!settledRouterControl\.payoutReview &&\s*!settledRouterControl\.nativeTreasury\?\.prepared/
    )
    expect(route).toContain(
      "setSettledRouterOutcome(getCheckoutSparkSettledOutcomeMessage(result))"
    )
    expect(
      getCheckoutSparkSettledOutcomeMessage({
        status: "paused",
        reason: "zero_remainder",
      })
    ).toBe(
      "No approved checkout credit remains for the final Conduit payment. No additional payment was sent; merchant recovery is required."
    )
  })
})
