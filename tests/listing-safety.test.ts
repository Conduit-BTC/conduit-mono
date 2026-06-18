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

  it("keeps policy-warning listings visible and purchasable", () => {
    const examples = [
      product({ tags: ["adult"] }),
      product({ title: "CBD wellness balm" }),
      product({ title: "Pocket knife sheath" }),
    ]

    for (const example of examples) {
      const safety = evaluateListingSafety(example)
      const display = getListingSafetyDisplay(safety)

      expect(safety.state).toBe("flagged")
      expect(isListingMarketVisible(safety)).toBe(true)
      expect(isListingPurchasable(safety)).toBe(true)
      expect(display.label).toBe("Policy warning")
      expect(display.summary).toContain("remains active")
    }
  })

  it("blocks high-confidence CSAM, weapons, and controlled-substance categories", () => {
    const examples = [
      product({ tags: ["csam"] }),
      product({ title: "Firearm listing" }),
      product({ title: "Controlled substance listing" }),
    ]

    for (const example of examples) {
      const safety = evaluateListingSafety(example)

      expect(safety.state).toBe("blocked")
      expect(safety.reasons.map((reason) => reason.code)).toContain(
        "blocked_term"
      )
      expect(isListingMarketVisible(safety)).toBe(false)
      expect(isListingPurchasable(safety)).toBe(false)
    }
  })

  it("blocks high-confidence counterfeit or stolen-goods phrases", () => {
    const safety = evaluateListingSafety(
      product({
        title: "Counterfeit goods display sample",
      })
    )

    expect(safety.state).toBe("blocked")
    expect(safety.reasons.map((reason) => reason.code)).toContain(
      "blocked_term"
    )
    expect(isListingPurchasable(safety)).toBe(false)
  })

  it("does not block broad ambiguous terms by themselves", () => {
    const examples = [
      product({ title: "Stolen moments photo book" }),
      product({ title: "Workshop tool organizer" }),
      product({ title: "Adult medium jacket" }),
    ]

    for (const example of examples) {
      const safety = evaluateListingSafety(example)

      expect(safety.state).toBe("active")
      expect(isListingMarketVisible(safety)).toBe(true)
      expect(isListingPurchasable(safety)).toBe(true)
    }
  })

  it("shows display copy for the final safety state when multiple reasons match", () => {
    const safety = evaluateListingSafety(
      product({
        title: "Counterfeit goods display sample",
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
    const variable = evaluateListingSafety(product({ type: "variable" }))
    const variation = evaluateListingSafety(product({ type: "variation" }))

    expect(variable.state).toBe("unsupported")
    expect(variable.reasons.map((reason) => reason.code)).toContain(
      "unsupported_product_type"
    )
    expect(variation.state).toBe("unsupported")
    expect(variation.reasons.map((reason) => reason.code)).toContain(
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
