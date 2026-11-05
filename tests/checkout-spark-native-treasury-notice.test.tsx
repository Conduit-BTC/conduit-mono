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
