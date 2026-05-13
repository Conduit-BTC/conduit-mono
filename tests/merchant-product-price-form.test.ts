import { describe, expect, it } from "bun:test"
import {
  assertPublishableProductPrice,
  getProductPriceInputStep,
} from "../apps/merchant/src/lib/productPriceForm"

describe("merchant product price form", () => {
  it("uses currency-specific price input precision", () => {
    expect(getProductPriceInputStep("USD")).toBe("0.01")
    expect(getProductPriceInputStep("SAT")).toBe("1")
    expect(getProductPriceInputStep("SATS")).toBe("1")
    expect(getProductPriceInputStep("BTC")).toBe("0.00000001")
  })

  it("allows publishable positive source prices", () => {
    expect(() => assertPublishableProductPrice(25, "USD")).not.toThrow()
    expect(() => assertPublishableProductPrice(1, "SAT")).not.toThrow()
    expect(() => assertPublishableProductPrice(0.0025, "BTC")).not.toThrow()
  })

  it("rejects prices Market cannot settle or display as payable", () => {
    expect(() => assertPublishableProductPrice(0, "USD")).toThrow(
      "greater than zero"
    )
    expect(() => assertPublishableProductPrice(1.5, "SAT")).toThrow(
      "Satoshi prices must be at least 1 whole sat"
    )
    expect(() => assertPublishableProductPrice(0.000000001, "BTC")).toThrow(
      "BTC prices must convert to at least 1 whole sat"
    )
  })
})
