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

  it("emits Gamma stock tag when stock tracking is set", () => {
    const trackedDraft = buildProductListingEventDraft({
      product: baseProduct({ stock: 12 }),
      dTag: "tracked-stock-product",
    })
    const untrackedDraft = buildProductListingEventDraft({
      product: baseProduct({ stock: undefined }),
      dTag: "untracked-stock-product",
    })

    expectTag(trackedDraft.tags, ["stock", "12"])
    expect(untrackedDraft.tags.some((tag) => tag[0] === "stock")).toBe(false)
  })

  it("round-trips stock through emitted kind 30402 tags", () => {
    const draft = buildProductListingEventDraft({
      product: baseProduct({ stock: 12 }),
      dTag: "stock-round-trip",
    })

    const parsed = parseProductEvent({
      id: "stock-round-trip-event",
      pubkey: "merchant",
      created_at: 1_779_762_725,
      content: draft.content,
      tags: draft.tags,
    })

    expect(parsed.id).toBe("30402:merchant:stock-round-trip")
    expect(parsed.stock).toBe(12)
  })

  it("round-trips independent stock values through variation listing drafts", () => {
    const largeDraft = buildProductListingEventDraft({
      product: baseProduct({
        type: "variation",
        title: "Large Shirt",
        stock: 2,
      }),
      dTag: "large-shirt",
    })
    const mediumDraft = buildProductListingEventDraft({
      product: baseProduct({
        type: "variation",
        title: "Medium Shirt",
        stock: 7,
      }),
      dTag: "medium-shirt",
    })

    const large = parseProductEvent({
      id: "large-shirt-event",
      pubkey: "merchant",
      created_at: 1_779_762_725,
      content: largeDraft.content,
      tags: largeDraft.tags,
    })
    const medium = parseProductEvent({
      id: "medium-shirt-event",
      pubkey: "merchant",
      created_at: 1_779_762_725,
      content: mediumDraft.content,
      tags: mediumDraft.tags,
    })

    expect(large.type).toBe("variation")
    expect(large.stock).toBe(2)
    expect(medium.type).toBe("variation")
    expect(medium.stock).toBe(7)
  })

  it("distinguishes included shipping from post-order coordination", () => {
    const includedDraft = buildProductListingEventDraft({
      product: baseProduct({
        shippingCostSats: 0,
        sourceShippingCost: undefined,
        shippingOptionId: undefined,
        shippingOptionDTag: undefined,
      }),
      dTag: "included-shipping-product",
    })
    const coordinatedDraft = buildProductListingEventDraft({
      product: baseProduct({
        shippingCostSats: undefined,
        sourceShippingCost: undefined,
        shippingOptionId: undefined,
        shippingOptionDTag: undefined,
        shippingCountries: undefined,
        shippingCountryRules: undefined,
      }),
      dTag: "coordinated-shipping-product",
    })

    expectTag(includedDraft.tags, ["shipping_cost", "0"])
    expect(includedDraft.tags.some((tag) => tag[0] === "shipping_option")).toBe(
      false
    )
    expect(
      coordinatedDraft.tags.some((tag) => tag[0] === "shipping_cost")
    ).toBe(false)
    expect(
      coordinatedDraft.tags.some((tag) => tag[0] === "shipping_option")
    ).toBe(false)
    expect(
      coordinatedDraft.tags.some((tag) => tag[0] === "shipping_country")
    ).toBe(false)
  })

  it("emits Gamma shipping option extra cost when it matches the product currency", () => {
    const draft = buildProductListingEventDraft({
      product: baseProduct({
        price: 25_000,
        currency: "SATS",
        shippingCostSats: 500,
        shippingOptionId: "30406:merchant:standard",
        shippingOptionDTag: "standard",
      }),
      dTag: "sats-shipping-product",
    })

    expectTag(draft.tags, ["shipping_cost", "500"])
    expectTag(draft.tags, ["shipping_option", "30406:merchant:standard", "500"])
  })

  it("keeps fiat shipping option extra cost in the source product currency", () => {
    const product = canonicalizeProductPrice({
      ...baseProduct({
        price: 15,
        currency: "USD",
        shippingCostSats: undefined,
        shippingOptionId: "30406:merchant:standard",
        shippingOptionDTag: "standard",
      }),
      ...canonicalizeShippingCost(5, "USD"),
    })

    const draft = buildProductListingEventDraft({
      product,
      dTag: "usd-shipping-option-product",
    })

    expectTag(draft.tags, ["shipping_cost", "5", "USD"])
    expectTag(draft.tags, ["shipping_option", "30406:merchant:standard", "5"])
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

  it("normalizes the removed product-reference policy to generic-only when emitting", () => {
    const product = {
      ...baseProduct(),
      zapMessagePolicy: "product_reference",
    } as unknown as ProductSchema

    const draft = buildProductListingEventDraft({
      product,
      dTag: "product-reference-policy",
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

  it("uses signed event identity and time over legacy JSON fields", () => {
    const parsed = parseProductEvent({
      id: "signed-event",
      pubkey: "signed-merchant",
      created_at: 1_779_762_725,
      content: JSON.stringify(
        baseProduct({
          id: "content-controlled-id",
          pubkey: "content-controlled-merchant",
          createdAt: 9_999_999_999_999,
          updatedAt: 9_999_999_999_999,
        })
      ),
      tags: [["d", "signed-product"]],
    })

    expect(parsed.id).toBe("30402:signed-merchant:signed-product")
    expect(parsed.pubkey).toBe("signed-merchant")
    expect(parsed.createdAt).toBe(1_779_762_725_000)
    expect(parsed.updatedAt).toBe(1_779_762_725_000)
  })

  it("normalizes JSON-shaped summaries in legacy Conduit listings", () => {
    const product = baseProduct({
      summary: JSON.stringify({ description: "Legacy display copy" }),
    })
    const parsed = parseProductEvent({
      id: "legacy-json-summary-event",
      pubkey: product.pubkey,
      created_at: 1_779_762_725,
      content: JSON.stringify(product),
      tags: [["d", "legacy-json-summary"]],
    })

    expect(parsed.summary).toBe("Legacy display copy")
  })

  it("suppresses nested JSON-shaped summaries in legacy listings", () => {
    const product = baseProduct({
      summary: JSON.stringify({
        description: JSON.stringify({ material: "linen" }),
      }),
    })
    const parsed = parseProductEvent({
      id: "legacy-nested-json-summary-event",
      pubkey: product.pubkey,
      created_at: 1_779_762_725,
      content: JSON.stringify(product),
      tags: [["d", "legacy-nested-json-summary"]],
    })

    expect(parsed.summary).toBeUndefined()
  })

  it("keeps legacy JSON-content stock distinct from untracked products", () => {
    const trackedProduct = baseProduct({ stock: 4 })
    const untrackedProduct = baseProduct({ stock: undefined })
    const tracked = parseProductEvent({
      id: "legacy-tracked-stock-event",
      pubkey: trackedProduct.pubkey,
      created_at: 1_779_762_725,
      content: JSON.stringify(trackedProduct),
      tags: [["d", "legacy-tracked-stock"]],
    })
    const untracked = parseProductEvent({
      id: "legacy-untracked-stock-event",
      pubkey: untrackedProduct.pubkey,
      created_at: 1_779_762_725,
      content: JSON.stringify(untrackedProduct),
      tags: [["d", "legacy-untracked-stock"]],
    })

    expect(tracked.stock).toBe(4)
    expect(untracked.stock).toBeUndefined()
  })

  it("lets valid stock tags override legacy JSON-content stock", () => {
    const parsed = parseProductEvent({
      id: "legacy-stock-tag-event",
      pubkey: "merchant",
      created_at: 1_779_762_725,
      content: JSON.stringify(baseProduct({ stock: 9 })),
      tags: [
        ["d", "legacy-stock-tag"],
        ["stock", "0"],
      ],
    })

    expect(parsed.stock).toBe(0)
  })

  it("lets shipping tags override stale legacy JSON shipping fields", () => {
    const parsed = parseProductEvent({
      id: "legacy-shipping-tag-event",
      pubkey: "merchant",
      created_at: 1_779_762_725,
      content: JSON.stringify(
        baseProduct({
          shippingCostSats: undefined,
          sourceShippingCost: undefined,
          shippingOptionId: undefined,
          shippingOptionDTag: undefined,
        })
      ),
      tags: [
        ["d", "legacy-shipping-tag"],
        ["shipping_option", "30406:merchant:standard", "5"],
      ],
    })

    expect(parsed.shippingOptionId).toBe("30406:merchant:standard")
    expect(parsed.shippingOptionDTag).toBe("standard")
    expect(parsed.sourceShippingCost).toEqual({
      amount: 5,
      currency: "USD",
      normalizedCurrency: "USD",
    })
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

  it("parses Gamma shipping option extra cost from product listings", () => {
    const parsed = parseProductEvent({
      id: "spec-event-with-shipping-extra-cost",
      pubkey: "merchant",
      created_at: 1_779_762_725,
      content: "A shippable product.",
      tags: [
        ["d", "extra-cost-product"],
        ["title", "Extra Cost Product"],
        ["price", "25000", "SATS"],
        ["type", "simple", "physical"],
        ["shipping_option", "30406:merchant:standard", "500"],
      ],
    })

    expect(parsed.shippingOptionId).toBe("30406:merchant:standard")
    expect(parsed.shippingOptionDTag).toBe("standard")
    expect(parsed.shippingCostSats).toBe(500)
    expect(parsed.sourceShippingCost).toEqual({
      amount: 500,
      currency: "SATS",
      normalizedCurrency: "SATS",
    })
  })

  it("keeps Gamma fiat shipping option extra cost in the product currency", () => {
    const parsed = parseProductEvent({
      id: "spec-event-with-fiat-shipping-extra-cost",
      pubkey: "merchant",
      created_at: 1_779_762_725,
      content: "A fiat-priced shippable product.",
      tags: [
        ["d", "fiat-extra-cost-product"],
        ["title", "Fiat Extra Cost Product"],
        ["price", "25", "USD"],
        ["type", "simple", "physical"],
        ["shipping_option", "30406:merchant:standard", "5"],
      ],
    })

    expect(parsed.shippingOptionId).toBe("30406:merchant:standard")
    expect(parsed.shippingCostSats).toBeUndefined()
    expect(parsed.sourceShippingCost).toEqual({
      amount: 5,
      currency: "USD",
      normalizedCurrency: "USD",
    })
  })

  it("keeps explicit shipping_cost tags ahead of shipping option extra cost", () => {
    const parsed = parseProductEvent({
      id: "spec-event-with-legacy-shipping-cost",
      pubkey: "merchant",
      created_at: 1_779_762_725,
      content: "A shippable product.",
      tags: [
        ["d", "legacy-shipping-cost-product"],
        ["title", "Legacy Shipping Cost Product"],
        ["price", "25000", "SATS"],
        ["type", "simple", "physical"],
        ["shipping_cost", "250"],
        ["shipping_option", "30406:merchant:standard", "500"],
      ],
    })

    expect(parsed.shippingOptionId).toBe("30406:merchant:standard")
    expect(parsed.shippingCostSats).toBe(250)
  })

  it("parses Gamma stock tags and keeps zero distinct from missing stock", () => {
    const zero = parseProductEvent({
      id: "zero-stock-event",
      pubkey: "merchant",
      created_at: 1_779_762_725,
      content: "Sold out for now.",
      tags: [
        ["d", "zero-stock"],
        ["title", "Zero Stock Product"],
        ["price", "25000", "SATS"],
        ["stock", "0"],
      ],
    })
    const untracked = parseProductEvent({
      id: "untracked-stock-event",
      pubkey: "merchant",
      created_at: 1_779_762_725,
      content: "Inventory is not tracked.",
      tags: [
        ["d", "untracked-stock"],
        ["title", "Untracked Product"],
        ["price", "25000", "SATS"],
      ],
    })
    const malformed = parseProductEvent({
      id: "malformed-stock-event",
      pubkey: "merchant",
      created_at: 1_779_762_725,
      content: "Malformed stock should degrade to untracked.",
      tags: [
        ["d", "malformed-stock"],
        ["title", "Malformed Stock Product"],
        ["price", "25000", "SATS"],
        ["stock", "-1"],
      ],
    })

    expect(zero.stock).toBe(0)
    expect(untracked.stock).toBeUndefined()
    expect(malformed.stock).toBeUndefined()
  })

  it("skips malformed duplicate stock tags before a valid stock value", () => {
    const parsed = parseProductEvent({
      id: "duplicate-stock-event",
      pubkey: "merchant",
      created_at: 1_779_762_725,
      content: "Duplicate stock tags from an external client.",
      tags: [
        ["d", "duplicate-stock"],
        ["title", "Duplicate Stock Product"],
        ["price", "25000", "SATS"],
        ["stock", "-1"],
        ["stock", "5"],
      ],
    })

    expect(parsed.stock).toBe(5)
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

  it("maps the legacy product policy alias to generic-only compatibility", () => {
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

  it("parses independent stock values for variation listings", () => {
    const large = parseProductEvent({
      id: "large-variation-event",
      pubkey: "merchant",
      created_at: 1_779_762_725,
      content: "Large size option.",
      tags: [
        ["d", "large-variation"],
        ["title", "Large Shirt"],
        ["price", "25000", "SATS"],
        ["type", "variation", "physical"],
        ["stock", "2"],
      ],
    })
    const medium = parseProductEvent({
      id: "medium-variation-event",
      pubkey: "merchant",
      created_at: 1_779_762_725,
      content: "Medium size option.",
      tags: [
        ["d", "medium-variation"],
        ["title", "Medium Shirt"],
        ["price", "25000", "SATS"],
        ["type", "variation", "physical"],
        ["stock", "7"],
      ],
    })

    expect(large.type).toBe("variation")
    expect(large.stock).toBe(2)
    expect(medium.type).toBe("variation")
    expect(medium.stock).toBe(7)
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

  it("projects screenshot-shaped JSON from a non-standard summary tag", () => {
    const rawSummary = JSON.stringify({
      title: "Love, Love, Love",
      description: "Nutti loves Ecash",
      category: "Ecash",
      pricing: "free",
      images: [
        "https://blossom.primal.net/d1d66d4b20e2b094fcaba33d6b6d9442a4ec34d7719c66865dc0710da2bec7cc.png",
      ],
      created_at: "2025-07-25T13:44:41.029Z",
    })
    const parsed = parseProductEvent({
      id: "love-love-love-event",
      pubkey: "merchant",
      created_at: 1_753_451_081,
      content: rawSummary,
      tags: [
        ["d", "love-love-love"],
        ["summary", rawSummary],
        ["price", "0", "SATS"],
        ["t", "Ecard"],
        ["t", "Ecash"],
        ["t", "Bitpopart"],
        ["t", "Bitcoin-Art"],
      ],
    })

    expect(parsed.title).toBe("Love, Love, Love")
    expect(parsed.summary).toBe("Nutti loves Ecash")
    expect(parsed.summary).not.toContain('{"title"')
  })

  it("suppresses JSON summary tags without display copy", () => {
    const parsed = parseProductEvent({
      id: "json-summary-metadata-event",
      pubkey: "merchant",
      created_at: 1_779_762_725,
      content: "",
      tags: [
        ["d", "json-summary-metadata"],
        ["title", "Metadata-only JSON"],
        ["summary", '{"material":"linen","care":"cold wash"}'],
        ["price", "42000", "SATS"],
      ],
    })

    expect(parsed.summary).toBeUndefined()
  })

  it("falls back to Markdown content when a JSON summary tag has no display copy", () => {
    const parsed = parseProductEvent({
      id: "json-summary-with-markdown-content-event",
      pubkey: "merchant",
      created_at: 1_779_762_725,
      content: "Merchant-authored **Markdown** description.",
      tags: [
        ["d", "json-summary-with-markdown-content"],
        ["title", "Markdown fallback"],
        ["summary", '{"material":"linen","care":"cold wash"}'],
        ["price", "42000", "SATS"],
      ],
    })

    expect(parsed.summary).toBe("Merchant-authored **Markdown** description.")
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

  it("keeps prose between generated-looking price and format lines", () => {
    const parsed = parseProductEvent({
      id: "merchant-prose-between-metadata-event",
      pubkey: "merchant",
      created_at: 1_779_762_725,
      content: "Fallback content",
      tags: [
        ["d", "merchant-prose-between-metadata"],
        ["title", "Carved Cedar"],
        [
          "summary",
          "1000 SATS\nHand-carved cedar with a natural finish.\nPhysical Product",
        ],
        ["price", "1000", "SATS"],
        ["type", "simple", "physical"],
      ],
    })

    expect(parsed.summary).toBe(
      "1000 SATS\nHand-carved cedar with a natural finish.\nPhysical Product"
    )
  })

  it("keeps merchant-authored prose that starts with listed by", () => {
    const parsed = parseProductEvent({
      id: "merchant-listed-by-prose-event",
      pubkey: "merchant",
      created_at: 1_779_762_725,
      content: "Fallback content",
      tags: [
        ["d", "merchant-listed-by-prose"],
        ["title", "Handmade Print"],
        ["summary", "Listed by hand and signed by the artist."],
        ["price", "1000", "SATS"],
      ],
    })

    expect(parsed.summary).toBe("Listed by hand and signed by the artist.")
  })
})
