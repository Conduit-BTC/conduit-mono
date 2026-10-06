import { expect, test } from "bun:test"
import {
  displayShippingWeight,
  shippingWeightInputToGrams,
} from "../apps/merchant/src/lib/shippingWeightUnits"

test("metric and imperial entries round upward into exact whole grams", () => {
  for (const [text, unit, grams] of [
    ["1", "lb", 454],
    ["1", "oz", 29],
    ["10", "oz", 284],
    ["1.25", "kg", 1250],
    ["0.001", "g", 1],
    ["0", "oz", 0],
    ["100000", "lb", 45359237],
  ] as const)
    expect(shippingWeightInputToGrams(text, unit)).toBe(grams)
  expect(shippingWeightInputToGrams("1.0000000000000001", "kg")).toBe(1001)
  expect(() => shippingWeightInputToGrams("1e3", "g")).toThrow()
  expect(() => shippingWeightInputToGrams("-1", "lb")).toThrow()
  expect(() => shippingWeightInputToGrams("9007199254740992", "g")).toThrow()
})
test("display conversions leave the canonical weight untouched", () => {
  const canonical = "454"
  expect(displayShippingWeight(canonical, "g")).toBe("454")
  expect(displayShippingWeight("1000", "kg")).toBe("1")
  expect(displayShippingWeight(canonical, "lb")).toBe("1.001")
  expect(displayShippingWeight("", "oz")).toBe("")
})
