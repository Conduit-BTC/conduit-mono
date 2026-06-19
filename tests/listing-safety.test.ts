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
      product({ title: "Delta 8 topical sample" }),
      product({ title: "Movie prop replica display" }),
      product({ title: "Faux leather wallet" }),
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

  it("blocks high-confidence CSAM, firearms, ammo, and explosives", () => {
    const examples = [
      product({ tags: ["csam"] }),
      product({ tags: ["csem"] }),
      product({ title: "Firearm listing" }),
      product({ title: "Glock 19 slide" }),
      product({ title: "9mm ammo box" }),
      product({ title: "Pipe bomb instructions" }),
      product({ title: "Stun gun" }),
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

  it("blocks high-confidence controlled and prescription substance listings", () => {
    const examples = [
      product({ title: "Controlled substance listing" }),
      product({ title: "Fentanyl sample" }),
      product({ title: "Methamphetamine listing" }),
      product({ title: "MDMA tablets" }),
      product({ title: "Oxycodone tablets" }),
      product({ title: "Xanax bars" }),
      product({ title: "Pill press tooling" }),
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
    const examples = [
      product({ title: "Counterfeit goods display sample" }),
      product({ title: "Fake Rolex watch" }),
      product({ title: "Replica Gucci bag" }),
      product({ title: "Stolen iPhone" }),
    ]

    for (const example of examples) {
      const safety = evaluateListingSafety(example)

      expect(safety.state).toBe("blocked")
      expect(safety.reasons.map((reason) => reason.code)).toContain(
        "blocked_term"
      )
      expect(isListingPurchasable(safety)).toBe(false)
    }
  })

  it("does not block broad ambiguous terms by themselves", () => {
    const examples = [
      product({ title: "Stolen moments photo book" }),
      product({ title: "Workshop tool organizer" }),
      product({ title: "Adult medium jacket" }),
      product({ title: "Nintendo Switch case" }),
      product({ title: "Glue gun craft kit" }),
      product({ title: "Bath bomb gift set" }),
      product({ title: "Bullet journal" }),
      product({ title: "Printer ink cartridges" }),
    ]

    for (const example of examples) {
      const safety = evaluateListingSafety(example)

      expect(safety.state).toBe("active")
      expect(isListingMarketVisible(safety)).toBe(true)
      expect(isListingPurchasable(safety)).toBe(true)
    }
  })

  it("keeps lower-confidence regulated-adjacent terms as warnings only", () => {
    const examples = [
      product({ title: "Rolling papers" }),
      product({ title: "Bong cleaner kit" }),
      product({ title: "Cannabis art print" }),
      product({ title: "Machete sheath" }),
    ]

    for (const example of examples) {
      const safety = evaluateListingSafety(example)

      expect(safety.state).toBe("flagged")
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
