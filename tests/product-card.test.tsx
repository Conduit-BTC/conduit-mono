import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { getProductPriceDisplay, getShopperPriceDisplay } from "@conduit/core"
import { ProductCard, ProductCartAction, ShareLinkButton } from "@conduit/ui"

describe("ProductCard", () => {
  it("renders an accessible product share action and status region", () => {
    const html = renderToStaticMarkup(
      <ShareLinkButton
        url="https://shop.conduit.market/products/naddr1product"
        shareTitle="Conduit Shirt"
        aria-label="Share Conduit Shirt"
      />
    )

    expect(html).toContain('aria-label="Share Conduit Shirt"')
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain(">Share</button>")
  })

  it("loads only the first public candidate and does not preload a fallback chain", () => {
    const html = renderToStaticMarkup(
      <ProductCard
        title="Public Image Product"
        merchantName="Alice Store"
        images={[
          { url: "https://cdn.conduit.market/primary.png" },
          { url: "https://fallback.conduit.market/fallback.png" },
        ]}
        primaryPrice="25 sats"
      />
    )

    expect(html).toContain("https://cdn.conduit.market/primary.png")
    expect(html).not.toContain("https://fallback.conduit.market/fallback.png")
    expect(html).toContain('referrerPolicy="no-referrer"')
  })

  it("does not render a non-public image destination passed at the UI boundary", () => {
    for (const url of [
      "http://127.0.0.1/private.png",
      "https://[2001:100::1]/avatar.png",
      "https://[2001:1::4]/avatar.png",
    ]) {
      const html = renderToStaticMarkup(
        <ProductCard
          title="Unsafe Image Product"
          merchantName="Mallory Store"
          images={[{ url }]}
          primaryPrice="25 sats"
        />
      )

      expect(html).toContain("Image unavailable")
      expect(html).not.toContain(url)
      expect(html).not.toContain("<img")
    }
  })

  it("does not skip an unsafe first candidate to request a later author URL", () => {
    const html = renderToStaticMarkup(
      <ProductCard
        title="Unsafe First Image Product"
        merchantName="Mallory Store"
        images={[
          { url: "http://127.0.0.1/private.png" },
          { url: "https://fallback.conduit.market/fallback.png" },
        ]}
        primaryPrice="25 sats"
      />
    )

    expect(html).toContain("Image unavailable")
    expect(html).not.toContain("127.0.0.1")
    expect(html).not.toContain("fallback.conduit.market")
  })

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

  it("merges options wrapper classes without making options behavior app-specific", () => {
    const html = renderToStaticMarkup(
      <ProductCard
        title="Option Product"
        merchantName="Alice Store"
        images={[]}
        primaryPrice="25 sats"
        options={<span>Size</span>}
        optionsClassName="test-options-wrapper"
      />
    )

    expect(html).toContain('class="pt-3 test-options-wrapper"')
    expect(html).toContain(">Size<")
  })

  it("can disable image-only hover zoom for parent-level card motion", () => {
    const html = renderToStaticMarkup(
      <ProductCard
        title="Motion Product"
        merchantName="Alice Store"
        images={[{ url: "https://cdn.conduit.market/product.png" }]}
        primaryPrice="25 sats"
        disableImageHoverZoom
      />
    )

    expect(html).not.toContain("group-hover:scale-105")
  })

  it("truncates product titles to one line without constraining title badges", () => {
    const html = renderToStaticMarkup(
      <ProductCard
        title="An intentionally long product title that must not take a second line"
        titleAside={<span>Featured</span>}
        merchantName="Alice Store"
        images={[]}
        primaryPrice="25 sats"
        soldOut
      />
    )

    expect(html).toContain("min-w-0 flex-1 truncate")
    expect(html).not.toContain("line-clamp-2")
    expect(html).not.toContain("min-h-[2.5rem]")
    expect(html).toContain(">Featured<")
    expect(html).toContain(">Sold out<")
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

  it("disables product-card increments at the known stock limit", () => {
    const html = renderToStaticMarkup(
      <ProductCartAction
        title="Limited Tee"
        cartQuantity={1}
        onAddToCart={() => undefined}
        onIncrement={() => undefined}
        onDecrement={() => undefined}
        atStockLimit
      />
    )

    expect(html).toMatch(
      /<button(?=[^>]*disabled="")(?=[^>]*aria-label="Stock limit reached for Limited Tee")[^>]*>/
    )
    expect(html).toMatch(
      /<button(?![^>]*disabled="")(?=[^>]*aria-label="Remove one Limited Tee from cart")[^>]*>/
    )
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
