import { describe, expect, it } from "bun:test"
import {
  getShopperCardPriceDisplay,
  getShopperPriceDisplay,
  getProductCardPriceDisplay,
  getProductPriceDisplay,
} from "@conduit/core"

const preference = { currency: "USD", bitcoinUnit: "bitcoin" } as const
const quote = { rate: 100_000, fetchedAt: 1, source: "env" } as const

describe("catalog compact pricing", () => {
  it.each([
    [99_999_999, "₿99,999,999"],
    [100_000_000, "1 BTC"],
    [100_000_001, "1 BTC"],
    [123_456_789, "1.235 BTC"],
    [999_999_999_999, "10k BTC"],
    [Number.MAX_SAFE_INTEGER, "90.07M BTC"],
  ])(
    "formats %s sats as %s without changing amount authority",
    (price, text) => {
      const product = { price, currency: "SATS" }
      const full = getShopperPriceDisplay(product)
      const card = getShopperCardPriceDisplay(product)
      expect(card.primary).toEqual({ text, fullText: full.primary })
      expect(card.sats).toBe(full.sats)
      expect(card.approximate).toBe(false)
      expect(getProductCardPriceDisplay(product).primary.text).toBe(
        text.replace(/^₿/, "") + (price < 100_000_000 ? " sats" : "")
      )
      expect(getProductPriceDisplay(product).primary).toBe(
        `${price.toLocaleString()} sats`
      )
    }
  )

  it.each([
    [170, "$170.00"],
    [999.99, "$999.99"],
    [1000, "$1k"],
    [100300, "$100.3k"],
    [1403000, "$1.403M"],
    [1403000000, "$1.403B"],
    [999950, "$1M"],
  ])("formats %s USD as %s while retaining its full quote", (price, text) => {
    const product = { price, currency: "USD" }
    const card = getShopperCardPriceDisplay(product, preference)
    expect(card.primary.text).toBe(text)
    expect(card.primary.fullText).toBe(
      getShopperPriceDisplay(product, preference).primary
    )
    expect(card.state).toBe("ready")
    expect(card.approximate).toBe(false)
  })

  it("preserves currency and locale placement rather than parsing formatted labels", () => {
    const product = { price: 1_403_000, currency: "EUR" }
    const card = getShopperCardPriceDisplay(
      product,
      { ...preference, currency: "EUR" },
      null,
      { locale: "de-DE" }
    )
    expect(card.primary.text).toBe(
      new Intl.NumberFormat("de-DE", {
        style: "currency",
        currency: "EUR",
        notation: "compact",
        maximumSignificantDigits: 4,
      }).format(product.price)
    )
    expect(card.primary.fullText).toContain("1.403.000")
    const yen = getShopperCardPriceDisplay(
      { price: 170, currency: "JPY" },
      { ...preference, currency: "JPY" }
    )
    expect(yen.primary.text).toBe("¥170")
  })

  it("compacts source, converted and USD reference lines while retaining estimate provenance", () => {
    const product = { price: 1_403_000, currency: "EUR" }
    const rate = { ...quote, fiatUsdRates: { EUR: 1.2 } }
    const card = getShopperCardPriceDisplay(product, undefined, rate)
    const full = getShopperPriceDisplay(product, undefined, rate)
    expect(card.primary.text).toBe("~ 16.84 BTC")
    expect(card.primary.fullText).toBe(full.primary)
    expect(card.secondary?.text).toBe("€1.403M EUR")
    expect(card.secondary?.fullText).toBe(full.secondary)
    expect(card.approximateUsd?.text).toBe("~ $1.684M USD")
    expect(card.approximateUsd?.fullText).toBe(full.approximateUsd)
    expect(card.approximate).toBe(true)
    const fiat = getShopperCardPriceDisplay(
      { price: 100_300_000, currency: "SATS" },
      preference,
      quote
    )
    expect(fiat.primary.text).toBe("~ $100.3k")
    expect(fiat.secondary?.text).toBe("1.003 BTC")
  })

  it("preserves unavailable, stale, free and tiny conversion behavior", () => {
    const product = { price: 100_300, currency: "USD" }
    const missing = getShopperCardPriceDisplay(product)
    expect(missing.primary.text).toBe("Price conversion unavailable")
    expect(missing.secondary?.text).toBe("$100.3k USD")
    const stale = getShopperCardPriceDisplay(
      product,
      undefined,
      { ...quote, source: "mempool" },
      { nowMs: 1_000_000 }
    )
    expect(stale.state).toBe("rate_stale")
    const free = getShopperCardPriceDisplay(
      {
        price: 0,
        currency: "SATS",
        priceSats: 0,
        sourcePrice: {
          amount: 0,
          currency: "SATS",
          normalizedCurrency: "SATS",
        },
      },
      undefined,
      null,
      { allowZero: true }
    )
    expect(free.primary).toEqual({ text: "Free", fullText: "Free" })
    const tiny = getShopperCardPriceDisplay(
      { price: 1, currency: "SATS" },
      undefined,
      quote
    )
    expect(tiny.approximateUsd?.text).toBe("~ $0.01 USD")
  })
})
