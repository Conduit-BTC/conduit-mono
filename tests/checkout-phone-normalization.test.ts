import { expect, test } from "bun:test"
import { normalizeCheckoutPhone } from "../apps/market/src/lib/checkout-validation"

test("valid local phone uses the explicit selected country", () => {
  expect(normalizeCheckoutPhone("202 555 0123", "US") === "+12025550123").toBe(
    true
  )
  expect(
    normalizeCheckoutPhone("020 7946 0958", "GB") === "+442079460958"
  ).toBe(true)
})

test("international phone overrides delivery country without changing its destination", () => {
  expect(
    normalizeCheckoutPhone("+44 20 7946 0958", "US") === "+442079460958"
  ).toBe(true)
})

test("invalid or ambiguous phone is left for validation, not silently repaired", () => {
  const invalid = "555 123 4567"
  expect(normalizeCheckoutPhone(invalid, "US") === invalid).toBe(true)
  expect(normalizeCheckoutPhone("2025550123", "") === "2025550123").toBe(true)
  expect(normalizeCheckoutPhone("", "US") === "").toBe(true)
})
