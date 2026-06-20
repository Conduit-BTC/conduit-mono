import { describe, expect, it } from "bun:test"
import {
  assertPublishableProductPrice,
  assertPublishableProductShippingCost,
  canonicalizeProductShippingCost,
  getProductPriceInputStep,
  getProductShippingCurrencyLabel,
  normalizePublishableProductPrice,
  normalizePublishableProductShippingCost,
} from "../apps/merchant/src/lib/productPriceForm"

describe("merchant product price form", () => {
  it("uses currency-specific price input precision", () => {
    expect(getProductPriceInputStep("USD")).toBe("0.01")
    expect(getProductPriceInputStep("SAT")).toBe("1")
    expect(getProductPriceInputStep("SATS")).toBe("1")
    expect(getProductPriceInputStep("BTC")).toBe("0.00000001")
    expect(getProductPriceInputStep("JPY")).toBe("1")
    expect(getProductPriceInputStep("KWD")).toBe("0.001")
  })

  it("uses explicit shipping currency labels", () => {
    expect(getProductShippingCurrencyLabel("USD")).toBe("USD")
    expect(getProductShippingCurrencyLabel("SAT")).toBe("sats")
    expect(getProductShippingCurrencyLabel("SATS")).toBe("sats")
  })

  it("allows publishable positive source prices", () => {
    expect(() => assertPublishableProductPrice(25, "USD")).not.toThrow()
    expect(() => assertPublishableProductPrice(1, "SAT")).not.toThrow()
    expect(() => assertPublishableProductPrice(0.0025, "BTC")).not.toThrow()
  })

  it("normalizes publishable prices to the selected currency precision", () => {
    expect(normalizePublishableProductPrice(6.666, "USD")).toBe(6.67)
    expect(normalizePublishableProductPrice(6.6, "JPY")).toBe(7)
    expect(normalizePublishableProductPrice(1.5, "SAT")).toBe(2)
    expect(normalizePublishableProductPrice(0.000000014, "BTC")).toBe(
      0.00000001
    )
  })

  it("rejects prices Market cannot settle or display as payable", () => {
    expect(() => assertPublishableProductPrice(0, "USD")).toThrow(
      "greater than zero"
    )
    expect(() => assertPublishableProductPrice(0.4, "SAT")).toThrow(
      "greater than zero"
    )
    expect(() => assertPublishableProductPrice(0.000000001, "BTC")).toThrow(
      "greater than zero"
    )
  })

  it("canonicalizes fixed shipping in the selected listing currency", () => {
    expect(canonicalizeProductShippingCost(5, "USD")).toEqual({
      sourceShippingCost: {
        amount: 5,
        currency: "USD",
        normalizedCurrency: "USD",
      },
    })

    expect(canonicalizeProductShippingCost(5, "SATS")).toEqual({
      shippingCostSats: 5,
      sourceShippingCost: {
        amount: 5,
        currency: "SATS",
        normalizedCurrency: "SATS",
      },
    })

    expect(canonicalizeProductShippingCost(6.666, "USD")).toEqual({
      sourceShippingCost: {
        amount: 6.67,
        currency: "USD",
        normalizedCurrency: "USD",
      },
    })
  })

  it("allows zero shipping and rejects invalid shipping amounts", () => {
    expect(() => assertPublishableProductShippingCost(0, "USD")).not.toThrow()
    expect(() =>
      assertPublishableProductShippingCost(5.99, "USD")
    ).not.toThrow()
    expect(normalizePublishableProductShippingCost(6.666, "USD")).toBe(6.67)
    expect(normalizePublishableProductShippingCost(1.5, "SAT")).toBe(2)
    expect(() => assertPublishableProductShippingCost(-1, "USD")).toThrow(
      "non-negative"
    )
  })
})
