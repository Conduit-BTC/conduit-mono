import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
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

  it("renders an in-place merchant skeleton while identity is pending", () => {
    const html = renderToStaticMarkup(
      <ProductCard
        title="Pending Store Product"
        merchantName="Store"
        merchantNamePending
        images={[]}
        primaryPrice="25 sats"
      />
    )

    expect(html).toContain("animate-pulse")
    expect(html).not.toContain(">Store<")
  })
})
