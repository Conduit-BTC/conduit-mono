import { describe, expect, it } from "bun:test"
import {
  buildTagCorpusIndex,
  suggestProductTags,
  type TagCorpusEntry,
} from "@conduit/core"

const CORPUS: TagCorpusEntry[] = [
  {
    title: "Merino wool hoodie",
    summary: "Warm pullover hoodie for winter",
    tags: ["hoodie", "clothing", "wool"],
  },
  {
    title: "Cotton zip hoodie",
    summary: "Everyday hooded sweatshirt",
    tags: ["hoodie", "clothing", "cotton"],
  },
  {
    title: "Ceramic coffee mug",
    summary: "Handmade stoneware mug",
    tags: ["mug", "kitchen", "handmade"],
  },
  {
    title: "Stainless travel mug",
    summary: "Insulated coffee mug",
    tags: ["mug", "kitchen", "travel"],
  },
  {
    title: "Leather wallet",
    summary: "Slim bifold wallet",
    tags: ["wallet", "accessories", "leather"],
  },
]

const index = buildTagCorpusIndex(CORPUS)

function tags(query: Parameters<typeof suggestProductTags>[1]): string[] {
  return suggestProductTags(index, query).map((s) => s.tag)
}

describe("suggestProductTags", () => {
  it("surfaces tags from textually similar products", () => {
    const result = tags({ title: "Fleece hoodie", summary: "cozy hooded top" })
    expect(result).toContain("hoodie")
    expect(result).toContain("clothing")
    // Unrelated categories should not be suggested.
    expect(result).not.toContain("mug")
    expect(result).not.toContain("wallet")
  })

  it("ranks a direct tag match (word present in copy) first", () => {
    const result = suggestProductTags(index, {
      title: "Insulated mug",
      summary: "keeps coffee hot",
    })
    expect(result[0]?.tag).toBe("mug")
    expect(result[0]?.direct).toBe(true)
  })

  it("excludes tags the merchant already applied", () => {
    const result = tags({
      title: "Cotton hoodie",
      summary: "hooded sweatshirt",
      existingTags: ["hoodie"],
    })
    expect(result).not.toContain("hoodie")
    expect(result).toContain("clothing")
  })

  it("respects the limit", () => {
    const result = suggestProductTags(index, {
      title: "Hoodie mug wallet",
      summary: "clothing kitchen accessories",
      limit: 2,
    })
    expect(result.length).toBeLessThanOrEqual(2)
  })

  it("returns nothing for empty text or empty corpus", () => {
    expect(tags({ title: "", summary: "" })).toEqual([])
    const emptyIndex = buildTagCorpusIndex([])
    expect(
      suggestProductTags(emptyIndex, { title: "Hoodie", summary: "warm" })
    ).toEqual([])
  })

  it("prefers the most common surface spelling of a tag", () => {
    const mixed = buildTagCorpusIndex([
      { title: "Tee one", summary: "", tags: ["T-Shirt"] },
      { title: "Tee two", summary: "", tags: ["t-shirt"] },
      { title: "Tee three", summary: "", tags: ["t-shirt"] },
    ])
    const result = suggestProductTags(mixed, {
      title: "Graphic t shirt",
      summary: "printed tee",
    })
    expect(result.map((s) => s.tag)).toContain("t-shirt")
  })
})
