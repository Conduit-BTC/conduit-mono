import { describe, expect, it } from "bun:test"
import {
  formatGroupedProductOptionValue,
  parseGroupedProductOptionValue,
} from "@conduit/core"

describe("grouped product option values", () => {
  it("round-trips portable group-qualified option labels", () => {
    const value = formatGroupedProductOptionValue("Men", "5.5")

    expect(value).toBe("Men · 5.5")
    expect(parseGroupedProductOptionValue(value)).toEqual({
      group: "Men",
      value: "5.5",
    })
  })

  it("leaves ordinary option values ungrouped", () => {
    expect(parseGroupedProductOptionValue("XL")).toBeNull()
    expect(formatGroupedProductOptionValue("", "XL")).toBe("XL")
  })
})
