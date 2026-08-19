import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { CheckoutAvailabilityNotice } from "../apps/market/src/components/CheckoutAvailabilityNotice"

describe("checkout availability notice", () => {
  it("explains partial relay coverage without blocking checkout", () => {
    const markup = renderToStaticMarkup(
      <CheckoutAvailabilityNotice
        lastQuantityReported={false}
        partialCoverage
      />
    )

    expect(markup).toContain('role="status"')
    expect(markup).toContain('aria-live="polite"')
    expect(markup).toContain("A current signed listing was found")
    expect(markup).toContain("some relays did not respond")
  })

  it("explains last-unit and restocking outcomes", () => {
    const markup = renderToStaticMarkup(
      <CheckoutAvailabilityNotice
        lastQuantityReported
        partialCoverage={false}
      />
    )

    expect(markup).toContain("Limited availability")
    expect(markup).toContain("last quantity reported")
    expect(markup).toContain("do not reserve inventory")
    expect(markup).toContain("restocking is delayed")
    expect(markup).toContain("coordinate a refund")
  })

  it("renders nothing when availability is complete and not limited", () => {
    expect(
      renderToStaticMarkup(
        <CheckoutAvailabilityNotice
          lastQuantityReported={false}
          partialCoverage={false}
        />
      )
    ).toBe("")
  })
})
