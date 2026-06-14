import { describe, expect, it } from "bun:test"
import {
  buildProductListingEventDraft,
  canonicalizeProductPrice,
  EVENT_KINDS,
  parseProductEvent,
  type ProductSchema,
} from "@conduit/core"

function baseProduct(overrides: Partial<ProductSchema> = {}): ProductSchema {
  return {
    id: "30402:merchant:overbudget",
    pubkey: "merchant",
    title: "Overbudget",
    summary: "Testing **Markdown** product description.",
    price: 10,
    currency: "USD",
    type: "simple",
    format: "physical",
    shippingCostSats: 1,
    shippingOptionId: "30406:merchant:conduit-default",
    shippingOptionDTag: "conduit-default",
    shippingCountries: ["US"],
    shippingCountryRules: [
      {
        code: "US",
        name: "United States",
        restrictTo: [],
        exclude: ["AK"],
      },
    ],
    visibility: "public",
    stock: undefined,
    images: [{ url: "https://example.com/product.png" }],
    tags: ["test", "commerce"],
    location: undefined,
    createdAt: 1_779_762_725_963,
    updatedAt: 1_779_762_725_963,
    ...overrides,
  }
}

function expectTag(tags: string[][], expected: string[]): void {
  expect(tags).toContainEqual(expected)
}

describe("product listing event drafts", () => {
  it("emits product summary as kind 30402 Markdown content", () => {
    const draft = buildProductListingEventDraft({
      product: baseProduct(),
      dTag: "overbudget",
      clientAppId: "merchant",
    })

    expect(draft.kind).toBe(EVENT_KINDS.PRODUCT)
    expect(draft.content).toBe("Testing **Markdown** product description.")
    expect(() => JSON.parse(draft.content)).toThrow()
    expectTag(draft.tags, ["d", "overbudget"])
    expectTag(draft.tags, ["title", "Overbudget"])
    expectTag(draft.tags, [
      "summary",
      "Testing **Markdown** product description.",
    ])
    expectTag(draft.tags, ["shipping_cost", "1"])
    expectTag(draft.tags, ["shipping_option", "30406:merchant:conduit-default"])
    expectTag(draft.tags, ["shipping_country", "US"])
    expectTag(draft.tags, ["shipping_exclude", "US", "AK"])
    expectTag(draft.tags, ["image", "https://example.com/product.png"])
    expectTag(draft.tags, ["t", "test"])
    expectTag(draft.tags, ["t", "commerce"])
  })

  it("emits empty content and no summary tag when summary is blank", () => {
    const draft = buildProductListingEventDraft({
      product: baseProduct({ summary: "   " }),
      dTag: "blank-summary",
    })

    expect(draft.content).toBe("")
    expect(draft.tags.some((tag) => tag[0] === "summary")).toBe(false)
  })

  it("preserves source price quote in the public price tag", () => {
    const product = canonicalizeProductPrice(
      baseProduct({
        price: 0.0025,
        currency: "BTC",
      })
    )

    const draft = buildProductListingEventDraft({
      product,
      dTag: "btc-product",
    })

    expect(product.price).toBe(250_000)
    expect(product.currency).toBe("SATS")
    expectTag(draft.tags, ["price", "0.0025", "BTC"])
  })
})

describe("product listing event parsing", () => {
  it("keeps parsing legacy Conduit JSON-content product listings", () => {
    const product = baseProduct()
    const parsed = parseProductEvent({
      id: "legacy-event",
      pubkey: product.pubkey,
      created_at: 1_779_762_725,
      content: JSON.stringify(product),
      tags: [
        ["d", "overbudget"],
        ["title", "Ignored title"],
        ["price", "99", "USD"],
      ],
    })

    expect(parsed.title).toBe(product.title)
    expect(parsed.summary).toBe(product.summary)
    expect(parsed.price).toBe(product.price)
    expect(parsed.currency).toBe(product.currency)
  })

  it("parses spec-aligned tag/content product listings", () => {
    const parsed = parseProductEvent({
      id: "spec-event",
      pubkey: "merchant",
      created_at: 1_779_762_725,
      content: "A Markdown product description.",
      tags: [
        ["d", "spec-product"],
        ["title", "Spec Product"],
        ["price", "25000", "SATS"],
        ["type", "simple", "digital"],
        ["image", "https://example.com/spec.png"],
      ],
    })

    expect(parsed.id).toBe("30402:merchant:spec-product")
    expect(parsed.title).toBe("Spec Product")
    expect(parsed.summary).toBe("A Markdown product description.")
    expect(parsed.price).toBe(25_000)
    expect(parsed.currency).toBe("SATS")
    expect(parsed.format).toBe("digital")
  })

  it("falls back to tags when Markdown content is JSON-shaped but not a legacy product", () => {
    const parsed = parseProductEvent({
      id: "json-shaped-summary-event",
      pubkey: "merchant",
      created_at: 1_779_762_725,
      content: '{"material":"linen","care":"cold wash"}',
      tags: [
        ["d", "json-shaped-summary"],
        ["title", "JSON-Shaped Summary Product"],
        ["price", "42000", "SATS"],
        ["type", "simple", "physical"],
      ],
    })

    expect(parsed.id).toBe("30402:merchant:json-shaped-summary")
    expect(parsed.title).toBe("JSON-Shaped Summary Product")
    expect(parsed.summary).toBe('{"material":"linen","care":"cold wash"}')
    expect(parsed.price).toBe(42_000)
    expect(parsed.currency).toBe("SATS")
  })
})
