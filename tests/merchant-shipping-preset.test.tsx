import { readFileSync } from "node:fs"
import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

import { ShippingDestinationsEditor } from "../apps/merchant/src/components/ShippingDestinationsEditor"

describe("merchant shipping preset rates", () => {
  it("exposes rate editing on the Shipping route", () => {
    const source = readFileSync(
      new URL("../apps/merchant/src/routes/shipping.tsx", import.meta.url),
      "utf8"
    )

    expect(source).toMatch(
      /<ShippingDestinationsEditor[\s\S]{0,240}\bshowRates\b/u
    )
  })

  it("renders a saved destination amount with its currency control", () => {
    const markup = renderToStaticMarkup(
      <ShippingDestinationsEditor
        config={{
          countries: [
            {
              code: "US",
              name: "United States",
              restrictTo: [],
              exclude: [],
              rate: { amount: "12.50", currency: "USD" },
            },
          ],
        }}
        showRates
        defaultCurrency="SATS"
        onChange={() => {}}
      />
    )

    expect(markup).toContain("Flat checkout rate")
    expect(markup).toContain('value="12.50"')
    expect(markup).toContain('aria-label="United States rate currency"')
  })
})
