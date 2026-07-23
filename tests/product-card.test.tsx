import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { getProductPriceDisplay, getShopperPriceDisplay } from "@conduit/core"
import { ProductCard, ProductCartAction } from "@conduit/ui"

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

  it("keeps a sold-out product visible while disabling its cart action", () => {
    const html = renderToStaticMarkup(
      <ProductCard
        title="Sold Out Tee"
        merchantName="Alice Store"
        images={[]}
        primaryPrice="25 sats"
        soldOut
        action={
          <ProductCartAction
            title="Sold Out Tee"
            cartQuantity={0}
            onAddToCart={() => undefined}
            soldOut
          />
        }
      />
    )

    expect(html).toContain("Sold Out Tee")
    expect(html).toContain("Sold out")
    expect(html).toContain('disabled=""')
  })

  it("renders converted Bitcoin, source quote, and USD reference separately", () => {
    const price = getShopperPriceDisplay(
      {
        price: 10,
        currency: "EUR",
        sourcePrice: {
          amount: 10,
          currency: "EUR",
          normalizedCurrency: "EUR",
        },
      },
      undefined,
      {
        rate: 100_000,
        fetchedAt: 1_700_000_000_000,
        source: "env",
        fiatUsdRates: { EUR: 1.2 },
        fiatSource: "env",
      }
    )
    const html = renderToStaticMarkup(
      <ProductCard
        title="Euro Product"
        merchantName="Alice Store"
        images={[]}
        primaryPrice={price.primary}
        secondaryPrice={price.secondary}
        approximateUsdPrice={price.approximateUsd}
      />
    )

    expect(html).toContain("~ ₿12,000")
    expect(html).not.toContain("~=")
    expect(html).toContain("€10.00 EUR source quote")
    expect(html).toContain("about $12.00 USD")
  })
})
