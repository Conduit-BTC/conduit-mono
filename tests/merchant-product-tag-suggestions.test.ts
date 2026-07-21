import { describe, expect, it } from "bun:test"
import {
  buildProductTagCatalog,
  getProductTagSuggestions,
} from "../apps/merchant/src/lib/productTagSuggestions"

describe("merchant product tag suggestions", () => {
  it("builds canonical usage counts from the loaded product catalog", () => {
    const catalog = buildProductTagCatalog([
      { tags: [" Bitcoin ", "bitcoin", "Hardware"] },
      { tags: ["HARDWARE", "Relay"] },
      { tags: ["handmade", "hardware", "relay"] },
    ])

    expect(catalog).toEqual([
      { tag: "hardware", count: 3 },
      { tag: "relay", count: 2 },
      { tag: "bitcoin", count: 1 },
      { tag: "handmade", count: 1 },
    ])
  })

  it("ranks prefix matches before usage count and then alphabetically", () => {
    const suggestions = getProductTagSuggestions(
      [
        { tag: "smart-home", count: 9 },
        { tag: "art", count: 1 },
        { tag: "artist", count: 2 },
        { tag: "artisan", count: 2 },
      ],
      [],
      " ART "
    )

    expect(suggestions.map((suggestion) => suggestion.tag)).toEqual([
      "artisan",
      "artist",
      "art",
      "smart-home",
    ])
  })

  it("excludes selected tags and returns nothing for an empty query", () => {
    const catalog = [
      { tag: "hardware", count: 3 },
      { tag: "handmade", count: 1 },
    ]

    expect(
      getProductTagSuggestions(catalog, [" HARDWARE "], "ha").map(
        (suggestion) => suggestion.tag
      )
    ).toEqual(["handmade"])
    expect(getProductTagSuggestions(catalog, [], "  ")).toEqual([])
    expect(getProductTagSuggestions([], [], "hardware")).toEqual([])
  })
})
