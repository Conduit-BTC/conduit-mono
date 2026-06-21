import { describe, expect, it } from "bun:test"
import {
  SHIPPING_COUNTRIES,
  UNAVAILABLE_SHIPPING_COUNTRY_CODES,
} from "@conduit/core"

describe("shipping country options", () => {
  it("excludes unavailable shipping destinations from selectable countries", () => {
    const countryCodes = new Set(
      SHIPPING_COUNTRIES.map((country) => country.code)
    )

    for (const code of UNAVAILABLE_SHIPPING_COUNTRY_CODES) {
      expect(countryCodes.has(code)).toBe(false)
    }
  })

  it("keeps ordinary shipping countries selectable", () => {
    const countryCodes = new Set(
      SHIPPING_COUNTRIES.map((country) => country.code)
    )

    expect(countryCodes.has("US")).toBe(true)
    expect(countryCodes.has("CA")).toBe(true)
    expect(countryCodes.has("GB")).toBe(true)
  })

  it("excludes Ukraine rather than exposing restricted Ukraine regions", () => {
    const countryCodes = new Set(
      SHIPPING_COUNTRIES.map((country) => country.code)
    )

    expect(countryCodes.has("UA")).toBe(false)
  })
})
