import { describe, expect, it } from "bun:test"
import {
  calculateCheckoutSparkBuyerPrice,
  getShopperPriceDisplay,
  type BtcUsdRateQuote,
} from "@conduit/core"
import {
  getCartCoordinationEstimate,
  getCheckoutCoordinationPriceEstimate,
  getFeeInclusiveListingPriceDisplay,
} from "../apps/market/src/lib/checkout-coordination-pricing"
import type { CartItem } from "../apps/market/src/lib/cart-model"

const preference = { currency: "BITCOIN", bitcoinUnit: "sats" } as const

describe("buyer coordination pricing", () => {
  it("rolls the minimum and network allowance into one fee without changing the base", () => {
    expect(
      calculateCheckoutSparkBuyerPrice({
        itemSubtotalSats: 1_000,
        shippingSubtotalSats: 0,
      })
    ).toEqual({
      itemSubtotalSats: 1_000,
      shippingSubtotalSats: 0,
      commerceTotalSats: 1_000,
      conduitFeeSats: 111,
      networkAllowanceSats: 2,
      coordinationFeeSats: 113,
      totalSats: 1_113,
      minimumApplies: true,
    })
  })

  it.each([
    [100_000, 0, 2_100, 150, 102_250],
    [100_001, 0, 2_101, 151, 102_253],
    [90_000, 10_000, 2_100, 150, 102_250],
  ])(
    "uses the existing shipping-inclusive policy and integer rounding",
    (items, shipping, fee, allowance, total) => {
      const result = calculateCheckoutSparkBuyerPrice({
        itemSubtotalSats: items,
        shippingSubtotalSats: shipping,
      })
      expect(result.conduitFeeSats).toBe(fee)
      expect(result.networkAllowanceSats).toBe(allowance)
      expect(result.coordinationFeeSats).toBe(fee + allowance)
      expect(result.totalSats).toBe(total)
      expect(result.minimumApplies).toBe(false)
    }
  )

  it("applies the minimum once to combined items, not to every listing", () => {
    const single = calculateCheckoutSparkBuyerPrice({
      itemSubtotalSats: 1_000,
      shippingSubtotalSats: 0,
    })
    const combined = calculateCheckoutSparkBuyerPrice({
      itemSubtotalSats: 2_000,
      shippingSubtotalSats: 0,
    })
    expect(single.totalSats).toBe(1_113)
    expect(combined.totalSats).toBe(2_114)
    expect(combined.coordinationFeeSats).toBe(114)
    expect(combined.totalSats).toBeLessThan(single.totalSats * 2)
  })

  it("does not add a payment or fee to a free order", () => {
    const result = calculateCheckoutSparkBuyerPrice({
      itemSubtotalSats: 0,
      shippingSubtotalSats: 0,
    })
    expect(result.totalSats).toBe(0)
    expect(result.coordinationFeeSats).toBe(0)
    expect(result.minimumApplies).toBe(false)
  })

  it.each([-1, 1.1, Number.NaN, Number.MAX_SAFE_INTEGER])(
    "rejects unsafe inputs without displaying a made-up estimate: %s",
    (amount) => {
      expect(() =>
        calculateCheckoutSparkBuyerPrice({
          itemSubtotalSats: amount,
          shippingSubtotalSats: 0,
        })
      ).toThrow()
      expect(
        getCheckoutCoordinationPriceEstimate({
          itemSubtotalSats: amount,
          shippingSubtotalSats: 0,
        })
      ).toBeNull()
      expect(() =>
        calculateCheckoutSparkBuyerPrice({
          itemSubtotalSats: 1,
          shippingSubtotalSats: amount,
        })
      ).toThrow()
    }
  )
})

describe("fee-inclusive listing estimates", () => {
  it("adds fees to presentation only and preserves the signed/cart base price", () => {
    const product = Object.freeze({
      price: 1_000,
      currency: "SATS",
      priceSats: 1_000,
    })
    const display = getFeeInclusiveListingPriceDisplay(
      product,
      preference,
      null,
      true
    )
    expect(display.sats).toBe(1_113)
    expect(display.primary).toBe("~ 1,113 sats")
    expect(display.feeEstimateIncluded).toBe(true)
    expect(display.approximate).toBe(true)
    expect(product.price).toBe(1_000)
    expect(getShopperPriceDisplay(product, preference).sats).toBe(1_000)
  })

  it("leaves direct/production browsing unchanged when the router lane is disabled", () => {
    const price = { price: 1_000, currency: "SATS" }
    expect(
      getFeeInclusiveListingPriceDisplay(price, preference, null, false)
    ).toEqual({
      ...getShopperPriceDisplay(price, preference),
      feeEstimateIncluded: false,
    })
  })

  it("uses a fresh fiat conversion for the whole estimated total", () => {
    const nowMs = 1_800_000_000_000
    const quote: BtcUsdRateQuote = {
      rate: 100_000,
      fetchedAt: nowMs,
      source: "env",
    }
    const display = getFeeInclusiveListingPriceDisplay(
      { price: 1, currency: "USD" },
      { currency: "USD", bitcoinUnit: "sats" },
      quote,
      true,
      { nowMs }
    )
    expect(display.sats).toBe(1_113)
    expect(display.primary).toBe("~ $1.11")
    expect(display.secondary).toBe("1,113 sats")
    expect(display.feeEstimateIncluded).toBe(true)
  })

  it("does not invent a fiat fee estimate when conversion is unavailable", () => {
    const display = getFeeInclusiveListingPriceDisplay(
      { price: 1, currency: "USD" },
      preference,
      null,
      true
    )
    expect(display.sats).toBeNull()
    expect(display.feeEstimateIncluded).toBe(false)
  })

  it("keeps verified free pickup free", () => {
    const display = getFeeInclusiveListingPriceDisplay(
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
      preference,
      null,
      true,
      { allowZero: true }
    )
    expect(display.primary).toBe("Free")
    expect(display.sats).toBe(0)
    expect(display.feeEstimateIncluded).toBe(false)
  })
})

describe("combined cart estimates", () => {
  const item = (merchant = "a", product = "item"): CartItem => ({
    productId: `30402:${merchant}:${product}`,
    merchantPubkey: merchant,
    title: "Test item",
    price: 1_000,
    priceSats: 1_000,
    currency: "SATS",
    quantity: 1,
    format: "digital",
  })
  it("adds one minimum per compatible purchase and never changes cart line prices", () => {
    const first = Object.freeze(item())
    const second = Object.freeze(item("a", "other"))
    expect(getCartCoordinationEstimate([first, second], null)).toEqual({
      totalSats: 2_114,
      coordinationFeeSats: 114,
      shippingPending: false,
    })
    expect(first.priceSats).toBe(1_000)
    expect(second.priceSats).toBe(1_000)
  })
  it("adds each merchant's separate minimum instead of treating all carts as one order", () => {
    expect(getCartCoordinationEstimate([item("a"), item("b")], null)).toEqual({
      totalSats: 2_226,
      coordinationFeeSats: 226,
      shippingPending: false,
    })
  })
  it("waits for a usable conversion rather than estimating from stale cached fiat sats", () => {
    expect(
      getCartCoordinationEstimate(
        [{ ...item(), currency: "USD", price: 1, priceSats: undefined }],
        null
      )
    ).toBeNull()
  })
})
