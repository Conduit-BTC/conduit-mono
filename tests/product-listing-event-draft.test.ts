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

  it("emits the product-reference message policy when configured", () => {
    const product = {
      ...baseProduct(),
      zapMessagePolicy: "product_reference",
    } as ProductSchema

    const draft = buildProductListingEventDraft({
      product,
      dTag: "product-reference-policy",
    })

    expectTag(draft.tags, ["checkout_zap_message_policy", "product_reference"])
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
        ["checkout_zap_message_policy", "product_reference"],
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
    expect(parsed.zapMessagePolicy).toBe("product_reference")
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

  it("maps the legacy product policy alias to product-reference compatibility", () => {
    const parsed = parseProductEvent({
      id: "legacy-product-policy-event",
      pubkey: "merchant",
      created_at: 1_779_762_725,
      content: "Legacy policy candidate listing",
      tags: [
        ["d", "legacy-product-policy"],
        ["title", "Legacy Product Policy"],
        ["price", "25000", "SATS"],
        ["checkout_public_zaps", "true"],
        ["checkout_zap_message_policy", "product"],
      ],
    })

    expect(parsed.publicZapEnabled).toBe(true)
    expect(parsed.zapMessagePolicy).toBe("product_reference")
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

  it("does not render raw JSON-shaped content as product summary", () => {
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
    expect(parsed.summary).toBeUndefined()
    expect(parsed.price).toBe(42_000)
    expect(parsed.currency).toBe("SATS")
    expect(parsed.type).toBe("simple")
  })

  it("uses partial JSON listing metadata for display compatibility", () => {
    const parsed = parseProductEvent({
      id: "partial-json-listing-event",
      pubkey: "merchant",
      created_at: 1_779_762_725,
      content: JSON.stringify({
        title: "Sats gift",
        description: "I got some sats for you!",
        category: "Ecash",
        pricing: "free",
        images: [""],
        created_at: "2025-07-25T13:43:52.327Z",
      }),
      tags: [
        ["d", "sats-gift"],
        ["price", "0", "SATS"],
        ["type", "simple", "digital"],
        ["t", "Ecard"],
        ["t", "Ecash"],
      ],
    })

    expect(parsed.id).toBe("30402:merchant:sats-gift")
    expect(parsed.title).toBe("Sats gift")
    expect(parsed.summary).toBe("I got some sats for you!")
    expect(parsed.price).toBe(0)
    expect(parsed.currency).toBe("SATS")
    expect(parsed.format).toBe("digital")
    expect(parsed.tags).toEqual(["Ecard", "Ecash"])
    expect(parsed.images).toEqual([])
  })

  it("clamps partial JSON listing metadata before schema validation", () => {
    const parsed = parseProductEvent({
      id: "oversized-partial-json-listing-event",
      pubkey: "merchant",
      created_at: 1_779_762_725,
      content: JSON.stringify({
        title: "T".repeat(240),
        description: "D".repeat(5_040),
      }),
      tags: [
        ["d", "oversized-json-listing"],
        ["price", "1000", "SATS"],
        ["type", "simple", "digital"],
      ],
    })

    expect(parsed.id).toBe("30402:merchant:oversized-json-listing")
    expect(parsed.title).toHaveLength(200)
    expect(parsed.summary).toHaveLength(5000)
    expect(parsed.title).toBe("T".repeat(200))
    expect(parsed.summary).toBe("D".repeat(5000))
  })

  it("strips generated card metadata from summary tags", () => {
    const parsed = parseProductEvent({
      id: "generated-card-summary-event",
      pubkey:
        "43baaf0c28e6cfb195b17ee083e19eb3a4afdfac54d9b6baf170270ed193e34c",
      created_at: 1_783_424_610,
      content:
        "## Sun Smile Joy \n\nSun Smile Joy Fluffy Pluche\n\n 14.95 EUR\n pluche\n Physical Product\n\n*Listed by [BitPopArt](https://bitpopart.com) -- Nostr pubkey: 43baaf0c28e6cfb1...*\n\n**Price:** 14.95 EUR (-21%)\n**Category:** Keychains\n**Type:** Physical Product\n\n*Listed by BitPopArt*",
      tags: [
        ["d", "bitpopart-product-1753683992900-jsvyv2"],
        ["title", "Sun Smile Joy "],
        [
          "summary",
          "Sun Smile Joy Fluffy Pluche\n\n 14.95 EUR\n pluche\n Physical Product\n\n*Listed by [BitPopArt](https://bitpopart.com) -- Nostr pubkey: 43baaf0c28e6cfb1...*",
        ],
        ["price", "14.95", "EUR"],
        ["type", "simple", "physical"],
        ["t", "keychains"],
        ["client", "www.bitpopart.com"],
      ],
    })

    expect(parsed.title).toBe("Sun Smile Joy ")
    expect(parsed.summary).toBe("Sun Smile Joy Fluffy Pluche")
    expect(parsed.price).toBe(14.95)
    expect(parsed.currency).toBe("EUR")
    expect(parsed.sourcePrice).toEqual({
      amount: 14.95,
      currency: "EUR",
      normalizedCurrency: "EUR",
    })
  })

  it("keeps merchant-authored labeled summary lines that do not match listing metadata", () => {
    const parsed = parseProductEvent({
      id: "merchant-authored-labeled-summary-event",
      pubkey: "merchant",
      created_at: 1_779_762_725,
      content: "Fallback content",
      tags: [
        ["d", "labeled-summary"],
        ["title", "Woodcut Edition"],
        [
          "summary",
          [
            "Category: woodcut prints",
            "Type: handmade paper",
            "Price: varies by edition",
          ].join("\n"),
        ],
        ["price", "1000", "SATS"],
        ["type", "simple", "physical"],
        ["t", "prints"],
      ],
    })

    expect(parsed.summary).toBe(
      [
        "Category: woodcut prints",
        "Type: handmade paper",
        "Price: varies by edition",
      ].join("\n")
    )
  })
})
