import { describe, expect, it } from "bun:test"
import {
  buildProductListingEventDraft,
  canonicalizeProductPrice,
  canonicalizeShippingCost,
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
    publicZapEnabled: true,
    zapMessagePolicy: "generic_only",
    publicZapPolicyKnown: true,
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
    expectTag(draft.tags, ["checkout_public_zaps", "true"])
    expectTag(draft.tags, ["checkout_zap_message_policy", "generic_only"])
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

  it("preserves source shipping currency in the public shipping cost tag", () => {
    const product = canonicalizeProductPrice({
      ...baseProduct({
        price: 15,
        currency: "USD",
        shippingCostSats: undefined,
      }),
      ...canonicalizeShippingCost(5, "USD"),
    })

    const draft = buildProductListingEventDraft({
      product,
      dTag: "usd-shipping-product",
    })

    expect(product.sourceShippingCost).toEqual({
      amount: 5,
      currency: "USD",
      normalizedCurrency: "USD",
    })
    expect(product.shippingCostSats).toBeUndefined()
    expectTag(draft.tags, ["price", "15", "USD"])
    expectTag(draft.tags, ["shipping_cost", "5", "USD"])
    expect(draft.tags).not.toContainEqual(["shipping_cost", "5"])
  })

  it("emits custom product shipping rules without a preset option reference", () => {
    const product = baseProduct({
      shippingOptionId: undefined,
      shippingOptionDTag: undefined,
      shippingCountries: ["US", "CA"],
      shippingCountryRules: [
        {
          code: "US",
          name: "United States",
          restrictTo: ["787**"],
          exclude: ["78799"],
        },
        {
          code: "CA",
          name: "Canada",
          restrictTo: [],
          exclude: [],
        },
      ],
    })

    const draft = buildProductListingEventDraft({
      product,
      dTag: "custom-shipping-product",
    })

    expect(draft.tags.some((tag) => tag[0] === "shipping_option")).toBe(false)
    expectTag(draft.tags, ["shipping_country", "US", "CA"])
    expectTag(draft.tags, ["shipping_restrict", "US", "787**"])
    expectTag(draft.tags, ["shipping_exclude", "US", "78799"])
  })

  it("defaults omitted runtime public zap policy fields to enabled and generic-only when emitting", () => {
    const product = baseProduct() as Partial<ProductSchema>
    delete product.publicZapEnabled
    delete product.zapMessagePolicy
    delete product.publicZapPolicyKnown

    const draft = buildProductListingEventDraft({
      product: product as ProductSchema,
      dTag: "runtime-default-policy",
    })

    expectTag(draft.tags, ["checkout_public_zaps", "true"])
    expectTag(draft.tags, ["checkout_zap_message_policy", "generic_only"])
  })

  it("normalizes the removed product_reference policy to generic-only when emitting", () => {
    const product = {
      ...baseProduct(),
      zapMessagePolicy: "product_reference",
    } as unknown as ProductSchema

    const draft = buildProductListingEventDraft({
      product,
      dTag: "removed-policy-candidate",
    })

    expectTag(draft.tags, ["checkout_zap_message_policy", "generic_only"])
  })

  it("emits explicit public zap opt-out and shopper-custom message policy tags", () => {
    const draft = buildProductListingEventDraft({
      product: baseProduct({
        publicZapEnabled: false,
        zapMessagePolicy: "custom",
      }),
      dTag: "private-product",
    })

    expectTag(draft.tags, ["checkout_public_zaps", "false"])
    expectTag(draft.tags, ["checkout_zap_message_policy", "custom"])
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
    expect(parsed.publicZapEnabled).toBe(true)
    expect(parsed.zapMessagePolicy).toBe("generic_only")
    expect(parsed.publicZapPolicyKnown).toBe(false)
  })

  it("lets explicit zap policy tags override legacy JSON-content defaults", () => {
    const product = baseProduct({
      publicZapEnabled: true,
      zapMessagePolicy: "generic_only",
      publicZapPolicyKnown: true,
    })
    const parsed = parseProductEvent({
      id: "legacy-event-with-policy-tags",
      pubkey: product.pubkey,
      created_at: 1_779_762_725,
      content: JSON.stringify(product),
      tags: [
        ["d", "overbudget"],
        ["checkout_public_zaps", "false"],
        ["checkout_zap_message_policy", "custom"],
      ],
    })

    expect(parsed.publicZapEnabled).toBe(false)
    expect(parsed.zapMessagePolicy).toBe("custom")
    expect(parsed.publicZapPolicyKnown).toBe(true)
  })

  it("requires valid zap policy tags before treating legacy JSON policy as known", () => {
    const product = baseProduct({
      publicZapEnabled: false,
      zapMessagePolicy: "custom",
      publicZapPolicyKnown: true,
    })
    const parsed = parseProductEvent({
      id: "legacy-content-only-policy-event",
      pubkey: product.pubkey,
      created_at: 1_779_762_725,
      content: JSON.stringify(product),
      tags: [
        ["d", "legacy-content-only-policy"],
        ["title", "Ignored title"],
        ["price", "99", "USD"],
      ],
    })

    expect(parsed.publicZapEnabled).toBe(true)
    expect(parsed.zapMessagePolicy).toBe("generic_only")
    expect(parsed.publicZapPolicyKnown).toBe(false)
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
        ["checkout_public_zaps", "false"],
        ["checkout_zap_message_policy", "custom"],
        ["image", "https://example.com/spec.png"],
      ],
    })

    expect(parsed.id).toBe("30402:merchant:spec-product")
    expect(parsed.title).toBe("Spec Product")
    expect(parsed.summary).toBe("A Markdown product description.")
    expect(parsed.price).toBe(25_000)
    expect(parsed.currency).toBe("SATS")
    expect(parsed.type).toBe("simple")
    expect(parsed.format).toBe("digital")
    expect(parsed.publicZapEnabled).toBe(false)
    expect(parsed.zapMessagePolicy).toBe("custom")
    expect(parsed.publicZapPolicyKnown).toBe(true)
  })

  it("defaults missing or unknown public zap tags to generic public-zap-safe policy", () => {
    const missing = parseProductEvent({
      id: "missing-policy-event",
      pubkey: "merchant",
      created_at: 1_779_762_725,
      content: "Legacy listing",
      tags: [
        ["d", "missing-policy"],
        ["title", "Missing Policy Product"],
        ["price", "25000", "SATS"],
      ],
    })
    const malformed = parseProductEvent({
      id: "malformed-policy-event",
      pubkey: "merchant",
      created_at: 1_779_762_725,
      content: "Malformed listing",
      tags: [
        ["d", "malformed-policy"],
        ["title", "Malformed Policy Product"],
        ["price", "25000", "SATS"],
        ["checkout_public_zaps", "maybe"],
        ["checkout_zap_message_policy", "ship_everything"],
      ],
    })

    expect(missing.publicZapEnabled).toBe(true)
    expect(missing.zapMessagePolicy).toBe("generic_only")
    expect(missing.publicZapPolicyKnown).toBe(false)
    expect(malformed.publicZapEnabled).toBe(true)
    expect(malformed.zapMessagePolicy).toBe("generic_only")
    expect(malformed.publicZapPolicyKnown).toBe(false)
  })

  it("parses the earlier public_zaps tag candidate for compatibility", () => {
    const parsed = parseProductEvent({
      id: "legacy-candidate-event",
      pubkey: "merchant",
      created_at: 1_779_762_725,
      content: "Earlier tag candidate listing",
      tags: [
        ["d", "legacy-candidate"],
        ["title", "Legacy Candidate Product"],
        ["price", "25000", "SATS"],
        ["public_zaps", "disabled"],
        ["zap_message_policy", "shopper_custom"],
      ],
    })

    expect(parsed.publicZapEnabled).toBe(false)
    expect(parsed.zapMessagePolicy).toBe("custom")
    expect(parsed.publicZapPolicyKnown).toBe(true)
  })

  it("maps the removed product_reference policy candidate to generic compatibility", () => {
    const parsed = parseProductEvent({
      id: "removed-candidate-event",
      pubkey: "merchant",
      created_at: 1_779_762_725,
      content: "Removed policy candidate listing",
      tags: [
        ["d", "removed-candidate"],
        ["title", "Removed Candidate Product"],
        ["price", "25000", "SATS"],
        ["checkout_public_zaps", "true"],
        ["checkout_zap_message_policy", "product_reference"],
      ],
    })

    expect(parsed.publicZapEnabled).toBe(true)
    expect(parsed.zapMessagePolicy).toBe("generic_only")
    expect(parsed.publicZapPolicyKnown).toBe(true)
  })

  it("parses variable and variation product types from spec type tags", () => {
    const variable = parseProductEvent({
      id: "variable-event",
      pubkey: "merchant",
      created_at: 1_779_762_725,
      content: "Choose a size before purchase.",
      tags: [
        ["d", "variable-product"],
        ["title", "Variable Product"],
        ["price", "25000", "SATS"],
        ["type", "variable", "physical"],
        ["image", "https://example.com/variable.png"],
      ],
    })
    const variation = parseProductEvent({
      id: "variation-event",
      pubkey: "merchant",
      created_at: 1_779_762_725,
      content: "Large size option.",
      tags: [
        ["d", "variation-product"],
        ["title", "Variation Product"],
        ["price", "25000", "SATS"],
        ["type", "variation", "physical"],
        ["image", "https://example.com/variation.png"],
      ],
    })

    expect(variable.type).toBe("variable")
    expect(variable.format).toBe("physical")
    expect(variation.type).toBe("variation")
    expect(variation.format).toBe("physical")
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
    expect(parsed.type).toBe("simple")
  })
})
