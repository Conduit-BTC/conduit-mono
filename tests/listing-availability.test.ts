import { describe, expect, it } from "bun:test"
import {
  evaluateListingAvailability,
  getListingAvailabilityDisplay,
  hasMarketVisibleListingImage,
  isMerchantHiddenOnlyListingAvailable,
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
    images: [{ url: "https://cdn.conduit.market/item.png" }],
    tags: ["gear"],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe("listing availability", () => {
  it("admits formerly flagged and blocked content when the listing is renderable", () => {
    const examples = [
      product({ tags: ["adult"] }),
      product({ tags: ["csam"] }),
      product({ tags: ["csem"] }),
      product({ title: "Firearm listing" }),
      product({ summary: "Fentanyl sample" }),
      product({ title: "Counterfeit goods display sample" }),
      product({ title: "CBD wellness balm" }),
      product({ title: "Rolling papers" }),
    ]

    for (const example of examples) {
      const availability = evaluateListingAvailability(example)
      expect(availability.state).toBe("active")
      expect(availability.reasons).toEqual([])
      expect(isListingMarketVisible(availability)).toBe(true)
      expect(isListingPurchasable(availability)).toBe(true)
      expect(getListingAvailabilityDisplay(availability).label).toBe("Active")
    }
  })

  it("hides listings without a market-visible image regardless of content", () => {
    const availability = evaluateListingAvailability(
      product({ title: "Counterfeit goods", images: [] })
    )
    expect(availability.state).toBe("hidden")
    expect(availability.reasons.map((reason) => reason.code)).toEqual([
      "missing_market_image",
    ])
    expect(isListingMarketVisible(availability)).toBe(false)
    expect(isListingPurchasable(availability)).toBe(false)
  })

  it("keeps merchant-hidden listings out of Market", () => {
    const availability = evaluateListingAvailability(
      product({ title: "Counterfeit goods", visibility: "hidden" })
    )
    expect(availability.state).toBe("hidden")
    expect(availability.reasons.map((reason) => reason.code)).toEqual([
      "merchant_hidden",
    ])
    expect(isListingMarketVisible(availability)).toBe(false)
    expect(isListingPurchasable(availability)).toBe(false)
  })

  it("marks unsupported product types until commerce prepares a valid family", () => {
    const variable = evaluateListingAvailability(product({ type: "variable" }))
    const variation = evaluateListingAvailability(
      product({ type: "variation" })
    )
    expect(variable.state).toBe("unsupported")
    expect(variation.state).toBe("unsupported")
    expect(variable.reasons.map((reason) => reason.code)).toContain(
      "unsupported_product_type"
    )
    expect(variation.reasons.map((reason) => reason.code)).toContain(
      "unsupported_product_type"
    )

    const parent = evaluateListingAvailability(
      product({ type: "variable", images: [] }),
      { variationGroupRole: "parent", hasGroupImage: true }
    )
    const child = evaluateListingAvailability(product({ type: "variation" }), {
      variationGroupRole: "variation",
    })
    expect(parent.state).toBe("active")
    expect(parent.marketVisible).toBe(true)
    expect(child.state).toBe("active")
    expect(child.purchasable).toBe(true)
  })

  it("rechecks structural eligibility with prepared family context", () => {
    const listing = product({ type: "variable", images: [] })
    const retained = evaluateListingAvailability(listing)
    const contextual = evaluateListingAvailability(listing, {
      variationGroupRole: "parent",
      hasGroupImage: true,
    })
    expect(retained.reasons.map((reason) => reason.code)).toEqual([
      "missing_market_image",
      "unsupported_product_type",
    ])
    expect(contextual.state).toBe("active")
    expect(contextual.reasons).toEqual([])
  })

  it("limits exact-read recovery to merchant-hidden listings with an image", () => {
    const hidden = evaluateListingAvailability(
      product({ visibility: "hidden" })
    )
    const titledHidden = evaluateListingAvailability(
      product({ visibility: "hidden", title: "Counterfeit goods" })
    )
    const hiddenWithoutImage = evaluateListingAvailability(
      product({ visibility: "hidden", images: [] })
    )
    expect(isMerchantHiddenOnlyListingAvailable(hidden)).toBe(true)
    expect(isMerchantHiddenOnlyListingAvailable(titledHidden)).toBe(true)
    expect(isMerchantHiddenOnlyListingAvailable(hiddenWithoutImage)).toBe(false)
  })

  it("validates market image URLs", () => {
    expect(
      hasMarketVisibleListingImage(
        product({ images: [{ url: "ftp://x.test" }] })
      )
    ).toBe(false)
    expect(
      hasMarketVisibleListingImage(
        product({ images: [{ url: "http://127.0.0.1/camera.jpg" }] })
      )
    ).toBe(false)
    expect(
      hasMarketVisibleListingImage(
        product({ images: [{ url: "https://192.168.1.1/status.png" }] })
      )
    ).toBe(false)
    expect(
      hasMarketVisibleListingImage(
        product({ images: [{ url: "http://cdn.conduit.market/item.png" }] })
      )
    ).toBe(true)
    expect(hasMarketVisibleListingImage(product())).toBe(true)
  })
})
