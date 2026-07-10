import { describe, expect, it } from "bun:test"
import {
  assertPublishableProductPrice,
  assertPublishableProductShippingCost,
  canonicalizeProductShippingCost,
  formatProductAmountInput,
  getProductAmountInputMode,
  getProductPriceInputStep,
  getProductShippingCostHelpText,
  getProductShippingCurrencyLabel,
  isPlainDecimalInput,
  normalizePublishableProductPrice,
  normalizePublishableProductShippingCost,
  parsePlainDecimalAmount,
} from "../apps/merchant/src/lib/productPriceForm"

describe("merchant product price form", () => {
  it("uses currency-specific price input precision", () => {
    expect(getProductPriceInputStep("USD")).toBe("0.01")
    expect(getProductPriceInputStep("SAT")).toBe("1")
    expect(getProductPriceInputStep("SATS")).toBe("1")
    expect(getProductPriceInputStep("BTC")).toBe("0.00000001")
    expect(getProductPriceInputStep("JPY")).toBe("1")
    expect(getProductPriceInputStep("KWD")).toBe("0.001")
    expect(getProductAmountInputMode("SATS")).toBe("numeric")
    expect(getProductAmountInputMode("USD")).toBe("decimal")
  })

  it("accepts plain decimal input without exponent or sign syntax", () => {
    expect(isPlainDecimalInput("")).toBe(true)
    expect(isPlainDecimalInput("12.")).toBe(true)
    expect(isPlainDecimalInput("12.50")).toBe(true)
    expect(isPlainDecimalInput("e")).toBe(false)
    expect(isPlainDecimalInput("1e3")).toBe(false)
    expect(isPlainDecimalInput("-1")).toBe(false)
    expect(isPlainDecimalInput("+1")).toBe(false)
    expect(isPlainDecimalInput("1,000")).toBe(false)

    expect(parsePlainDecimalAmount("12.50", "Price")).toBe(12.5)
    expect(() => parsePlainDecimalAmount("1e3", "Price")).toThrow(
      "digits and a decimal point only"
    )
  })

  it("formats small currency values without exponent syntax", () => {
    expect(formatProductAmountInput(0.00000001)).toBe("0.00000001")
    expect(formatProductAmountInput(25.5)).toBe("25.5")
    expect(formatProductAmountInput(5)).toBe("5")
    expect(formatProductAmountInput(1e21)).toBe("1000000000000000000000")
  })

  it("uses explicit shipping currency labels", () => {
    expect(getProductShippingCurrencyLabel("USD")).toBe("USD")
    expect(getProductShippingCurrencyLabel("SAT")).toBe("sats")
    expect(getProductShippingCurrencyLabel("SATS")).toBe("sats")
  })

  it("explains fixed, included, coordinated, and digital shipping states", () => {
    expect(
      getProductShippingCostHelpText("", "physical", "USD", "fixed")
    ).toContain("Enter 0 when shipping is included")
    expect(
      getProductShippingCostHelpText("0", "physical", "USD", "fixed")
    ).toContain("fast checkout")
    expect(
      getProductShippingCostHelpText("5", "physical", "USD", "fixed")
    ).toContain("added to the buyer total")
    expect(
      getProductShippingCostHelpText(
        "",
        "physical",
        "USD",
        "coordinate_after_order"
      )
    ).toContain("No shipping amount will be published")
    expect(
      getProductShippingCostHelpText("", "digital", "USD", "fixed")
    ).toContain("Digital products do not need shipping")
  })

  it("allows publishable positive source prices", () => {
    expect(() => assertPublishableProductPrice(25, "USD")).not.toThrow()
    expect(() => assertPublishableProductPrice(1, "SAT")).not.toThrow()
    expect(() => assertPublishableProductPrice(0.0025, "BTC")).not.toThrow()
  })

  it("preserves valid publishable prices at the selected precision", () => {
    expect(normalizePublishableProductPrice(6.66, "USD")).toBe(6.66)
    expect(normalizePublishableProductPrice(6, "JPY")).toBe(6)
    expect(normalizePublishableProductPrice(1, "SAT")).toBe(1)
    expect(normalizePublishableProductPrice(0.00000001, "BTC")).toBe(0.00000001)
  })

  it("rejects amounts that would be silently rounded", () => {
    expect(() => normalizePublishableProductPrice(6.666, "USD")).toThrow(
      "USD supports up to 2 decimal places"
    )
    expect(() => normalizePublishableProductPrice(6.6, "JPY")).toThrow(
      "JPY amounts must be whole numbers"
    )
    expect(() => normalizePublishableProductPrice(1.5, "SAT")).toThrow(
      "SAT amounts must be whole numbers"
    )
    expect(() => normalizePublishableProductPrice(1.000000001, "USD")).toThrow(
      "USD supports up to 2 decimal places"
    )
    expect(() => normalizePublishableProductPrice(1.0000001, "SAT")).toThrow(
      "SAT amounts must be whole numbers"
    )
    expect(() => normalizePublishableProductPrice(0.000000014, "BTC")).toThrow(
      "BTC supports up to 8 decimal places"
    )
  })

  it("rejects prices Market cannot settle or display as payable", () => {
    expect(() => assertPublishableProductPrice(0, "USD")).toThrow(
      "greater than zero"
    )
    expect(() => assertPublishableProductPrice(0.4, "SAT")).toThrow(
      "whole numbers"
    )
    expect(() => assertPublishableProductPrice(0.000000001, "BTC")).toThrow(
      "up to 8 decimal places"
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

    expect(() => canonicalizeProductShippingCost(6.666, "USD")).toThrow(
      "USD supports up to 2 decimal places"
    )
  })

  it("allows zero shipping and rejects invalid shipping amounts", () => {
    expect(() => assertPublishableProductShippingCost(0, "USD")).not.toThrow()
    expect(() =>
      assertPublishableProductShippingCost(5.99, "USD")
    ).not.toThrow()
    expect(normalizePublishableProductShippingCost(6.66, "USD")).toBe(6.66)
    expect(normalizePublishableProductShippingCost(1, "SAT")).toBe(1)
    expect(() => normalizePublishableProductShippingCost(6.666, "USD")).toThrow(
      "USD supports up to 2 decimal places"
    )
    expect(() => normalizePublishableProductShippingCost(1.5, "SAT")).toThrow(
      "SAT amounts must be whole numbers"
    )
    expect(() =>
      normalizePublishableProductShippingCost(1.000000001, "USD")
    ).toThrow("USD supports up to 2 decimal places")
    expect(() => assertPublishableProductShippingCost(-1, "USD")).toThrow(
      "non-negative"
    )
  })
})
