import { describe, expect, it } from "bun:test"
import {
  PRODUCT_SUMMARY_FALLBACK,
  getProductDisplaySummary,
} from "../apps/market/src/lib/productDisplaySummary"

const HERO_IMAGE_URL = "https://cdn.example.com/hero.jpg"

function displaySummary(
  summary: string | undefined,
  images = [HERO_IMAGE_URL]
) {
  return getProductDisplaySummary({
    summary,
    images: images.map((url) => ({ url })),
  })
}

describe("getProductDisplaySummary", () => {
  it("preserves markdown links that point to product image URLs", () => {
    const summary =
      "See the [full-resolution photo](https://cdn.example.com/hero.jpg) before ordering."

    expect(displaySummary(summary)).toBe(summary)
  })

  it("removes standalone product image URL lines", () => {
    expect(displaySummary(["Intro", HERO_IMAGE_URL, "Outro"].join("\n"))).toBe(
      "Intro\nOutro"
    )
  })

  it("removes standalone markdown image lines for product images", () => {
    expect(
      displaySummary(
        ["Intro", `![full-resolution photo](${HERO_IMAGE_URL})`, "Outro"].join(
          "\n"
        )
      )
    ).toBe("Intro\nOutro")
  })

  it("removes exact markdown image references with URL punctuation", () => {
    const signedImageUrl = "https://cdn.example.com/hero(1).jpg?size=full"

    expect(displaySummary(`![hero](${signedImageUrl})`, [signedImageUrl])).toBe(
      PRODUCT_SUMMARY_FALLBACK
    )
  })

  it("falls back when the summary only contains product image references", () => {
    expect(displaySummary(`![hero](${HERO_IMAGE_URL})`)).toBe(
      PRODUCT_SUMMARY_FALLBACK
    )
  })

  it("projects display copy from a cached JSON-shaped summary", () => {
    expect(
      displaySummary(
        JSON.stringify({
          title: "Love, Love, Love",
          description: "Nutti loves Ecash",
          pricing: "free",
        })
      )
    ).toBe("Nutti loves Ecash")
  })

  it("falls back for a cached JSON summary without display copy", () => {
    expect(displaySummary('{"material":"linen","care":"cold wash"}')).toBe(
      PRODUCT_SUMMARY_FALLBACK
    )
  })

  it("does not expose nested JSON from cached display copy", () => {
    expect(
      displaySummary(
        JSON.stringify({
          description: JSON.stringify({ material: "linen" }),
        })
      )
    ).toBe(PRODUCT_SUMMARY_FALLBACK)
  })
})
