import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { getProductPriceDisplay } from "@conduit/core"
import { ProductCard } from "@conduit/ui"

describe("ProductCard", () => {
  it("renders a stable card when no product image is available", () => {
    const html = renderToStaticMarkup(
      <ProductCard
        title="No Image Product"
        merchantName="Alice Store"
        images={[]}
        primaryPrice="25 sats"
      />
    )

    expect(html).toContain("No Image Product")
    expect(html).toContain("Alice Store")
    expect(html).toContain("Image unavailable")
  })

  it("renders an in-place merchant label shimmer while identity is pending", () => {
    const html = renderToStaticMarkup(
      <ProductCard
        title="Pending Store Product"
        merchantName="Store npub1abc...xyz"
        merchantNamePending
        images={[]}
        primaryPrice="25 sats"
      />
    )

    expect(html).toContain("animate-pulse")
    expect(html).toContain(">Store npub1abc...xyz<")
  })

  it("renders sats primary pricing with a USD secondary line", () => {
    const price = getProductPriceDisplay(
      { price: 40_000, currency: "SATS", priceSats: 40_000 },
      80_700
    )
    const html = renderToStaticMarkup(
      <ProductCard
        title="Sats Product"
        merchantName="Alice Store"
        images={[]}
        primaryPrice={price.primary}
        secondaryPrice={price.secondary}
      />
    )

    expect(html).toContain("40,000 sats")
    expect(html).toContain("about $32.28 USD")
  })
})
