import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

import { CheckoutSparkFundingExpiry } from "../apps/market/src/components/CheckoutSparkFundingExpiry"

const NOW = 1_800_000_000_000

describe("settled Spark funding expiry notice", () => {
  it("shows the saved local expiry time and remaining time without invoice data", () => {
    const expiresAt = NOW + 5 * 60_000
    const markup = renderToStaticMarkup(
      <CheckoutSparkFundingExpiry expiresAt={expiresAt} now={() => NOW} />
    )

    expect(markup).toContain("Funding invoice expires")
    expect(markup).toContain(new Date(expiresAt).toISOString())
    expect(markup).toContain(
      new Date(expiresAt).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "medium",
      })
    )
    expect(markup).toContain("5:00 left")
    expect(markup).not.toContain("lnbc")
  })

  it("warns against paying once the displayed deadline has passed", () => {
    const expiresAt = NOW + 5 * 60_000
    const markup = renderToStaticMarkup(
      <CheckoutSparkFundingExpiry expiresAt={expiresAt} now={() => expiresAt} />
    )

    expect(markup).toContain("Time has ended; do not pay this invoice.")
    expect(markup).not.toContain("0:00 left")
  })

  it("shows the saved funding deadline while payable or checking exact credit", async () => {
    const route = await Bun.file("apps/market/src/routes/orders.tsx").text()
    expect(route).toMatch(
      /settledRouterControl\?\.status === "pay_funding"\s*\? settledRouterControl\.fundingExpiresAt/
    )
    expect(route).toMatch(
      /settledRouterControl\.status === "pay_funding" \|\|\s*settledRouterControl\.status === "check_funding"\) && \(\s*<CheckoutSparkFundingExpiry\s+expiresAt=\{settledRouterControl\.fundingExpiresAt\}/
    )
    expect(route).toMatch(
      /inspectionOnly:\s*current\.status === "check_funding" && !exposeExternalInvoice/
    )
  })

  it("warns before preparation that the funding clock starts immediately", async () => {
    const route = await Bun.file("apps/market/src/routes/checkout.tsx").text()
    expect(route).toMatch(/funding invoice valid\s+for\{" "\}/)
    expect(route).toContain(
      "{getCheckoutSparkSettledTiming().fundingExpirySecs / 60}"
    )
    expect(route).toMatch(
      /minutes\. Recipients and the funding amount are fixed/
    )
    expect(route).toContain("Continue when you are ready to pay")
  })
})
