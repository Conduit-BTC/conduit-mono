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
    expect(markup).toMatch(
      /<span class="block text-\[var\(--secondary\)\]">.*5:00 left/
    )
    expect(markup).not.toContain("lnbc")
  })

  it("warns against paying once the displayed deadline has passed", () => {
    const expiresAt = NOW + 5 * 60_000
    const markup = renderToStaticMarkup(
      <CheckoutSparkFundingExpiry expiresAt={expiresAt} now={() => expiresAt} />
    )

    expect(markup).toContain("Time has ended; do not pay this invoice.")
    expect(markup).toMatch(
      /<span class="block text-\[var\(--secondary\)\]">Time has ended/
    )
    expect(markup).not.toContain("0:00 left")
  })
})
