import { describe, expect, it } from "bun:test"
import {
  BTC_USD_RATE_STALE_MS,
  type BtcUsdRateQuote,
  canonicalizeShippingCost,
  compareCommercePrices,
  DEFAULT_SHOPPER_PRICE_PREFERENCE,
  formatBitcoinBaseUnits,
  getCurrencyAmountStep,
  getCurrencyFractionDigits,
  getProductPriceDisplay,
  getShippingCostSats,
  getShopperPriceDisplay,
  getShopperSatsDisplay,
  isBtcUsdRateQuoteFresh,
  normalizeCommercePrice,
  normalizeCurrencyAmount,
  normalizeShopperPricePreference,
  orderSchema,
  parseProductEvent,
} from "@conduit/core"

function expectSats(amount: number, currency: string, sats: number) {
  const normalized = normalizeCommercePrice(amount, currency)
  expect(normalized.status).toBe("ok")
  if (normalized.status === "ok") {
    expect(normalized.sats).toBe(sats)
  }
}

const testRates: BtcUsdRateQuote = {
  rate: 100_000,
  fetchedAt: 1_700_000_000_000,
  source: "env",
  fiatUsdRates: {
    CAD: 0.75,
    EUR: 1.2,
    GBP: 1.25,
  },
  fiatSource: "env",
}

describe("commerce pricing", () => {
  it("defaults Bitcoin display to integer base units with a sats opt-out", () => {
    expect(DEFAULT_SHOPPER_PRICE_PREFERENCE).toEqual({
      currency: "BITCOIN",
      bitcoinUnit: "bitcoin",
    })
    expect(formatBitcoinBaseUnits(1)).toBe("₿1")
    expect(formatBitcoinBaseUnits(10_000)).toBe("₿10,000")
    expect(formatBitcoinBaseUnits(100_000_000)).toBe("₿100,000,000")
    expect(formatBitcoinBaseUnits(10_000, "sats")).toBe("10,000 sats")
  })

  it("validates persisted shopper price preferences", () => {
    expect(
      normalizeShopperPricePreference({
        currency: "eur",
        bitcoinUnit: "sats",
      })
    ).toEqual({ currency: "EUR", bitcoinUnit: "sats" })
    expect(
      normalizeShopperPricePreference({
        currency: "DOGE",
        bitcoinUnit: "bits",
      })
    ).toEqual(DEFAULT_SHOPPER_PRICE_PREFERENCE)
  })

  it("formats one shopper currency while preserving the merchant source quote", () => {
    const euroProduct = {
      price: 10,
      currency: "EUR",
      sourcePrice: {
        amount: 10,
        currency: "EUR",
        normalizedCurrency: "EUR",
      },
    }

    expect(getShopperPriceDisplay(euroProduct, undefined, testRates)).toEqual({
      state: "ready",
      primary: "~ ₿12,000",
      secondary: "€10.00 EUR source quote",
      approximateUsd: "about $12.00 USD",
      displayCurrency: "BITCOIN",
      sats: 12_000,
      approximate: true,
      source: euroProduct.sourcePrice,
    })
    expect(
      getShopperPriceDisplay(
        euroProduct,
        { currency: "EUR", bitcoinUnit: "bitcoin" },
        testRates
      )
    ).toMatchObject({
      state: "ready",
      primary: "€10.00",
      secondary: "₿12,000",
      displayCurrency: "EUR",
      sats: 12_000,
      approximate: false,
    })
    expect(
      getShopperPriceDisplay(
        { price: 250_000, currency: "SATS", priceSats: 250_000 },
        { currency: "USD", bitcoinUnit: "bitcoin" },
        testRates
      )
    ).toMatchObject({
      state: "ready",
      primary: "~ $250.00",
      secondary: "₿250,000 Bitcoin amount",
      approximateUsd: null,
      displayCurrency: "USD",
      sats: 250_000,
    })
  })

  it("keeps an exact preferred source quote available without rates", () => {
    expect(
      getShopperPriceDisplay(
        {
          price: 10,
          currency: "EUR",
          sourcePrice: {
            amount: 10,
            currency: "EUR",
            normalizedCurrency: "EUR",
          },
        },
        { currency: "EUR", bitcoinUnit: "bitcoin" }
      )
    ).toMatchObject({
      state: "ready",
      primary: "€10.00",
      secondary: null,
      approximateUsd: null,
      sats: null,
      approximate: false,
    })
  })

  it("keeps USD context useful without duplicating a USD source quote", () => {
    expect(
      getShopperPriceDisplay(
        { price: 40_000, currency: "SATS", priceSats: 40_000 },
        DEFAULT_SHOPPER_PRICE_PREFERENCE,
        testRates
      )
    ).toMatchObject({
      primary: "₿40,000",
      secondary: null,
      approximateUsd: "about $40.00 USD",
    })

    expect(
      getShopperPriceDisplay(
        {
          price: 20,
          currency: "USD",
          sourcePrice: {
            amount: 20,
            currency: "USD",
            normalizedCurrency: "USD",
          },
        },
        DEFAULT_SHOPPER_PRICE_PREFERENCE,
        testRates
      )
    ).toMatchObject({
      primary: "~ ₿20,000",
      secondary: "$20.00 USD source quote",
      approximateUsd: null,
    })
  })

  it("does not reuse cached listing sats for a stale source-fiat conversion", () => {
    const price = {
      price: 10,
      currency: "EUR",
      priceSats: 8_000,
      sourcePrice: {
        amount: 10,
        currency: "EUR",
        normalizedCurrency: "EUR",
      },
    }
    const preference = { currency: "EUR", bitcoinUnit: "bitcoin" } as const

    expect(
      getShopperPriceDisplay(
        price,
        preference,
        { ...testRates, source: "mempool", fetchedAt: 1_000 },
        { nowMs: 1_000 + BTC_USD_RATE_STALE_MS + 1 }
      )
    ).toMatchObject({
      state: "ready",
      primary: "€10.00",
      secondary: null,
      approximateUsd: null,
      sats: null,
    })
    expect(getShopperPriceDisplay(price, preference, testRates)).toMatchObject({
      secondary: "₿12,000",
      sats: 12_000,
    })
    expect(
      getShopperPriceDisplay(price, preference, null, {
        settledSatsAreAuthoritative: true,
      })
    ).toMatchObject({
      secondary: "₿8,000",
      sats: 8_000,
    })
  })

  it("keeps exact sats visible when a preferred-fiat conversion is unavailable", () => {
    const preference = { currency: "EUR", bitcoinUnit: "bitcoin" } as const

    expect(getShopperSatsDisplay(10_000, preference)).toMatchObject({
      state: "rate_required",
      primary: "₿10,000",
      secondary: "Price conversion unavailable",
      sats: 10_000,
    })
    expect(
      getShopperSatsDisplay(
        10_000,
        preference,
        { ...testRates, source: "mempool", fetchedAt: 1_000 },
        { nowMs: 1_000 + BTC_USD_RATE_STALE_MS + 1 }
      )
    ).toMatchObject({
      state: "rate_stale",
      primary: "₿10,000",
      secondary: "Price conversion is stale",
      sats: 10_000,
    })
  })

  it("keeps recorded order sats authoritative when current rates change", () => {
    expect(
      getShopperPriceDisplay(
        {
          price: 8_000,
          currency: "SATS",
          priceSats: 8_000,
          sourcePrice: {
            amount: 10,
            currency: "EUR",
            normalizedCurrency: "EUR",
          },
        },
        DEFAULT_SHOPPER_PRICE_PREFERENCE,
        testRates,
        { settledSatsAreAuthoritative: true }
      )
    ).toMatchObject({
      state: "ready",
      primary: "₿8,000",
      secondary: "€10.00 EUR source quote",
      sats: 8_000,
      approximate: false,
    })
  })

  it("reports missing and stale conversion rates explicitly", () => {
    const fiatProduct = {
      price: 10,
      currency: "EUR",
      sourcePrice: {
        amount: 10,
        currency: "EUR",
        normalizedCurrency: "EUR",
      },
    }
    expect(getShopperPriceDisplay(fiatProduct)).toMatchObject({
      state: "rate_required",
      primary: "Price conversion unavailable",
      secondary: "€10.00 EUR source quote",
    })
    expect(
      getShopperPriceDisplay(
        fiatProduct,
        DEFAULT_SHOPPER_PRICE_PREFERENCE,
        { ...testRates, source: "mempool", fetchedAt: 1_000 },
        { nowMs: 1_000 + BTC_USD_RATE_STALE_MS + 1 }
      )
    ).toMatchObject({
      state: "rate_stale",
      primary: "Price conversion is stale",
      secondary: "€10.00 EUR source quote",
    })
  })

  it("derives amount precision from supported currency units", () => {
    expect(getCurrencyFractionDigits("USD")).toBe(2)
    expect(getCurrencyAmountStep("USD")).toBe("0.01")
    expect(getCurrencyFractionDigits("JPY")).toBe(0)
    expect(getCurrencyAmountStep("JPY")).toBe("1")
    expect(getCurrencyFractionDigits("KWD")).toBe(3)
    expect(getCurrencyAmountStep("KWD")).toBe("0.001")
    expect(getCurrencyFractionDigits("SATS")).toBe(0)
    expect(getCurrencyFractionDigits("BTC")).toBe(8)
    expect(getCurrencyAmountStep("BTC")).toBe("0.00000001")
  })

  it("normalizes currency amounts to the nearest accepted unit", () => {
    expect(normalizeCurrencyAmount(6.666, "USD")).toMatchObject({
      status: "ok",
      amount: 6.67,
      rounded: true,
    })
    expect(normalizeCurrencyAmount(6.6, "JPY")).toMatchObject({
      status: "ok",
      amount: 7,
      rounded: true,
    })
    expect(normalizeCurrencyAmount(1.5, "SATS")).toMatchObject({
      status: "ok",
      amount: 2,
      rounded: true,
    })
    expect(normalizeCurrencyAmount(0.000000014, "BTC")).toMatchObject({
      status: "ok",
      amount: 0.00000001,
      rounded: true,
    })
  })

  it("normalizes bitcoin-denominated prices into exact integer sats", () => {
    expectSats(250_000, "SAT", 250_000)
    expectSats(250_000, "SATS", 250_000)
    expectSats(0.0025, "BTC", 250_000)
    expectSats(0.025, "BTC", 2_500_000)
    expectSats(0.00000003, "BTC", 3)
    expectSats(0.00000123, "BTC", 123)
    expectSats(0.29, "BTC", 29_000_000)
    expectSats(0.0025, "XBT", 250_000)
    expectSats(250_000, "MSATS", 250)
  })

  it("rejects ambiguous or unsupported prices instead of guessing", () => {
    expect(normalizeCommercePrice(0, "SAT").status).toBe("invalid")
    expect(normalizeCommercePrice(999, "MSATS").status).toBe("invalid")
    expect(normalizeCommercePrice(0, "USD", testRates).status).toBe("invalid")
    expect(normalizeCommercePrice(1.5, "SAT").status).toBe("invalid")
    expect(normalizeCommercePrice(-1, "SATS").status).toBe("invalid")
    expect(normalizeCommercePrice(Number.NaN, "BTC").status).toBe("invalid")
    expect(normalizeCommercePrice(10, "EUR").status).toBe("rate_required")
    expect(normalizeCommercePrice(10, "USD").status).toBe("rate_required")
    expect(normalizeCommercePrice(10, "EUR", 100_000).status).toBe(
      "rate_required"
    )
  })

  it("converts fiat only when reliable fiat and BTC/USD rates are supplied", () => {
    const normalized = normalizeCommercePrice(25, "USD", 100_000)
    expect(normalized.status).toBe("ok")
    if (normalized.status === "ok") {
      expect(normalized.sats).toBe(25_000)
      expect(normalized.approximate).toBe(true)
    }

    const eur = normalizeCommercePrice(10, "EUR", testRates)
    expect(eur.status).toBe("ok")
    if (eur.status === "ok") {
      expect(eur.sats).toBe(12_000)
      expect(eur.approximate).toBe(true)
    }

    const gbp = normalizeCommercePrice(20, "GBP", testRates)
    expect(gbp.status).toBe("ok")
    if (gbp.status === "ok") {
      expect(gbp.sats).toBe(25_000)
      expect(gbp.approximate).toBe(true)
    }
  })

  it("canonicalizes shipping costs without assuming fiat amounts are sats", () => {
    expect(canonicalizeShippingCost(5, "USD")).toEqual({
      sourceShippingCost: {
        amount: 5,
        currency: "USD",
        normalizedCurrency: "USD",
      },
    })

    expect(canonicalizeShippingCost(5, "SATS")).toEqual({
      shippingCostSats: 5,
      sourceShippingCost: {
        amount: 5,
        currency: "SATS",
        normalizedCurrency: "SATS",
      },
    })

    expect(canonicalizeShippingCost(0, "USD")).toEqual({
      shippingCostSats: 0,
      sourceShippingCost: {
        amount: 0,
        currency: "USD",
        normalizedCurrency: "USD",
      },
    })
  })

  it("parses tag-only NIP-99 SAT listings as sats-canonical products", () => {
    const product = parseProductEvent({
      id: "event-1",
      pubkey: "merchant",
      created_at: 1_700_000_000,
      content: "Pocket clip",
      tags: [
        ["d", "clip"],
        ["title", "Extra Pocket Clip"],
        ["price", "250000", "SAT"],
        ["shipping_cost", "5000"],
        ["image", "https://example.com/clip.png"],
      ],
    })

    expect(product.price).toBe(250_000)
    expect(product.currency).toBe("SATS")
    expect(product.priceSats).toBe(250_000)
    expect(product.shippingCostSats).toBe(5_000)
    expect(product.sourcePrice).toEqual({
      amount: 250_000,
      currency: "SAT",
      normalizedCurrency: "SAT",
    })
  })

  it("preserves fiat shipping source quotes and converts them with rate input", () => {
    const product = parseProductEvent({
      id: "event-usd-shipping",
      pubkey: "merchant",
      created_at: 1_700_000_000,
      content: "Notebook",
      tags: [
        ["d", "notebook"],
        ["title", "Notebook"],
        ["price", "1000", "SATS"],
        ["shipping_cost", "10", "USD"],
        ["image", "https://example.com/notebook.png"],
      ],
    })

    expect(product.shippingCostSats).toBeUndefined()
    expect(product.sourceShippingCost).toEqual({
      amount: 10,
      currency: "USD",
      normalizedCurrency: "USD",
    })
    expect(getShippingCostSats(product, testRates)).toEqual({
      sats: 10_000,
      approximate: true,
    })
  })

  it("parses BTC listings as sats-canonical products", () => {
    const product = parseProductEvent({
      id: "event-2",
      pubkey: "merchant",
      created_at: 1_700_000_000,
      content: "Knife",
      tags: [
        ["d", "knife"],
        ["title", "Cyberita Scandigrind Folder"],
        ["price", "0.0025", "BTC"],
        ["image", "https://example.com/knife.png"],
      ],
    })

    expect(product.price).toBe(250_000)
    expect(product.currency).toBe("SATS")
    expect(product.priceSats).toBe(250_000)
    expect(getProductPriceDisplay(product, 100_000)).toEqual({
      primary: "250,000 sats",
      secondary: "about $250.00 USD",
    })
  })

  it("parses tag-only digital listings as not requiring shipping", () => {
    const product = parseProductEvent({
      id: "event-digital",
      pubkey: "merchant",
      created_at: 1_700_000_000,
      content: "PDF guide",
      tags: [
        ["d", "pdf-guide"],
        ["title", "PDF Guide"],
        ["price", "25000", "SATS"],
        ["type", "simple", "digital"],
        ["image", "https://example.com/guide.png"],
      ],
    })

    expect(product.type).toBe("simple")
    expect(product.format).toBe("digital")
    expect(product.shippingCostSats).toBeUndefined()
    expect(product.shippingOptionId).toBeUndefined()
  })

  it("preserves fiat source quotes and displays rate-backed sats", () => {
    const product = parseProductEvent({
      id: "event-3",
      pubkey: "merchant",
      created_at: 1_700_000_000,
      content: "Euro listing",
      tags: [
        ["d", "euro-listing"],
        ["title", "Euro Listing"],
        ["price", "10", "EUR"],
      ],
    })

    expect(product.price).toBe(10)
    expect(product.currency).toBe("EUR")
    expect(product.priceSats).toBeUndefined()
    expect(product.sourcePrice).toEqual({
      amount: 10,
      currency: "EUR",
      normalizedCurrency: "EUR",
    })

    expect(getProductPriceDisplay(product, testRates)).toEqual({
      primary: "〜 12,000 sats",
      secondary: "€10.00 EUR source quote",
    })
  })

  it("labels fiat source quote currencies without double-estimating USD", () => {
    expect(
      getProductPriceDisplay(
        {
          price: 20,
          currency: "USD",
          sourcePrice: {
            amount: 20,
            currency: "USD",
            normalizedCurrency: "USD",
          },
        },
        testRates
      )
    ).toEqual({
      primary: "〜 20,000 sats",
      secondary: "$20.00 USD source quote",
    })

    expect(
      getProductPriceDisplay(
        {
          price: 20,
          currency: "CAD",
          sourcePrice: {
            amount: 20,
            currency: "CAD",
            normalizedCurrency: "CAD",
          },
        },
        testRates
      )
    ).toEqual({
      primary: "〜 15,000 sats",
      secondary: "CA$20.00 CAD source quote",
    })

    expect(
      getProductPriceDisplay(
        {
          price: 20,
          currency: "USD",
        },
        testRates
      )
    ).toEqual({
      primary: "〜 20,000 sats",
      secondary: "$20.00 USD source quote",
    })
  })

  it("sorts commerce prices by sats and keeps unavailable prices last", () => {
    const exactSats = { price: 10_000, currency: "SATS", priceSats: 10_000 }
    const btc = { price: 0.0002, currency: "BTC" }
    const fiat = { price: 15, currency: "USD" }
    const zero = { price: 0, currency: "USD" }
    const unavailable = { price: 20, currency: "CHF" }
    const prices = [
      { label: "unavailable", price: unavailable },
      { label: "btc", price: btc },
      { label: "zero", price: zero },
      { label: "fiat", price: fiat },
      { label: "exactSats", price: exactSats },
    ]

    expect(
      [...prices]
        .sort((a, b) =>
          compareCommercePrices(a.price, b.price, testRates, "asc")
        )
        .map((item) => item.label)
    ).toEqual(["exactSats", "fiat", "btc", "unavailable", "zero"])

    expect(
      [...prices]
        .sort((a, b) =>
          compareCommercePrices(a.price, b.price, testRates, "desc")
        )
        .map((item) => item.label)
    ).toEqual(["btc", "fiat", "exactSats", "unavailable", "zero"])
  })

  it("does not display zero-value source prices as 0 sats", () => {
    expect(
      getProductPriceDisplay(
        {
          price: 0,
          currency: "USD",
          sourcePrice: {
            amount: 0,
            currency: "USD",
            normalizedCurrency: "USD",
          },
        },
        testRates
      )
    ).toEqual({
      primary: "Price unavailable",
      secondary: "$0.00 USD source quote",
    })

    expect(
      getProductPriceDisplay(
        {
          price: 0,
          currency: "SATS",
          priceSats: 0,
        },
        testRates
      ).primary
    ).toBe("Price unavailable")
  })

  it("keeps 0.025 BTC distinct from 250000 sats", () => {
    const normalized = normalizeCommercePrice(0.025, "BTC")
    expect(normalized.status).toBe("ok")
    if (normalized.status === "ok") {
      expect(normalized.sats).toBe(2_500_000)
    }
  })

  it("allows checkout payloads to preserve source quotes while settling in sats", () => {
    const parsed = orderSchema.parse({
      id: "order-1",
      merchantPubkey: "merchant",
      buyerPubkey: "buyer",
      items: [
        {
          productId: "30402:merchant:item",
          quantity: 1,
          priceAtPurchase: 250_000,
          currency: "SATS",
          sourcePrice: {
            amount: 0.0025,
            currency: "BTC",
            normalizedCurrency: "BTC",
          },
        },
      ],
      subtotal: 250_000,
      currency: "SATS",
      createdAt: 1_700_000_000_000,
    })

    expect(parsed.subtotal).toBe(250_000)
    expect(parsed.items[0]?.priceAtPurchase).toBe(250_000)
    expect(parsed.items[0]?.sourcePrice?.normalizedCurrency).toBe("BTC")
  })

  it("classifies BTC/USD quotes by their own fetchedAt age", () => {
    const now = 1_700_000_000_000
    expect(
      isBtcUsdRateQuoteFresh(
        {
          rate: 100_000,
          fetchedAt: now - BTC_USD_RATE_STALE_MS + 1,
          source: "mempool",
        },
        now
      )
    ).toBe(true)
    expect(
      isBtcUsdRateQuoteFresh(
        {
          rate: 100_000,
          fetchedAt: now - BTC_USD_RATE_STALE_MS - 1,
          source: "mempool",
        },
        now
      )
    ).toBe(false)
    expect(
      isBtcUsdRateQuoteFresh(
        {
          rate: 100_000,
          fetchedAt: now + 1,
          source: "mempool",
        },
        now
      )
    ).toBe(false)
  })

  it("treats configured env BTC/USD quotes as always fresh", () => {
    expect(
      isBtcUsdRateQuoteFresh(
        {
          rate: 100_000,
          fetchedAt: 1,
          source: "env",
        },
        1_700_000_000_000
      )
    ).toBe(true)
  })
})
