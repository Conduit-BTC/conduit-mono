import { describe, expect, it } from "bun:test"
import {
  evaluateListingSafety,
  getListingSafetyDisplay,
  hasMarketVisibleListingImage,
  isListingMarketVisible,
  isListingPurchasable,
  type Product,
} from "@conduit/core"

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "30402:merchant:item",
    pubkey: "merchant",
    title: "Launch Item",
    price: 1000,
    currency: "SATS",
    type: "simple",
    format: "physical",
    visibility: "public",
    images: [{ url: "https://example.com/item.png" }],
    tags: ["gear"],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe("listing safety", () => {
  it("allows ordinary simple listings with market images", () => {
    const safety = evaluateListingSafety(product())

    expect(safety.state).toBe("active")
    expect(isListingMarketVisible(safety)).toBe(true)
    expect(isListingPurchasable(safety)).toBe(true)
    expect(getListingSafetyDisplay(safety).label).toBe("Active")
  })

  it("hides listings without a market-visible image", () => {
    const safety = evaluateListingSafety(product({ images: [] }))

    expect(safety.state).toBe("hidden")
    expect(safety.reasons.map((reason) => reason.code)).toContain(
      "missing_market_image"
    )
    expect(isListingMarketVisible(safety)).toBe(false)
    expect(isListingPurchasable(safety)).toBe(false)
  })

  it("flags launch-restricted tags and terms", () => {
    const safety = evaluateListingSafety(
      product({
        title: "Vintage firearm accessory",
        tags: ["gear"],
      })
    )

    expect(safety.state).toBe("flagged")
    expect(safety.reasons.map((reason) => reason.code)).toContain(
      "restricted_term"
    )
    expect(isListingMarketVisible(safety)).toBe(false)
  })

  it("blocks counterfeit or stolen-goods terms", () => {
    const safety = evaluateListingSafety(
      product({
        title: "Counterfeit display sample",
      })
    )

    expect(safety.state).toBe("blocked")
    expect(safety.reasons.map((reason) => reason.code)).toContain(
      "blocked_term"
    )
    expect(isListingPurchasable(safety)).toBe(false)
  })

  it("shows display copy for the final safety state when multiple reasons match", () => {
    const safety = evaluateListingSafety(
      product({
        title: "Counterfeit display sample",
        images: [],
      })
    )
    const display = getListingSafetyDisplay(safety)

    expect(safety.state).toBe("blocked")
    expect(safety.reasons.map((reason) => reason.code)).toEqual([
      "missing_market_image",
      "blocked_term",
    ])
    expect(display.label).toBe("Blocked")
    expect(display.summary).toContain("counterfeit or stolen-goods")
    expect(display.merchantAction).toContain("counterfeit or stolen-goods")
  })

  it("marks unsupported product types separately from moderation", () => {
    const safety = evaluateListingSafety(product({ type: "variable" }))

    expect(safety.state).toBe("unsupported")
    expect(safety.reasons.map((reason) => reason.code)).toContain(
      "unsupported_product_type"
    )
  })

  it("validates market image URLs", () => {
    expect(
      hasMarketVisibleListingImage(
        product({ images: [{ url: "ftp://x.test" }] })
      )
    ).toBe(false)
    expect(hasMarketVisibleListingImage(product())).toBe(true)
  })
})
