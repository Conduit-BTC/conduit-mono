import { describe, expect, it } from "bun:test"
import {
  buildFixedShippingOptionEventDraft,
  buildProductListingEventDraft,
  compileProductFulfillmentIntent,
  getProductShippingOptionAddress,
  isBuyerCountryEligible,
  parseProductEvent,
  parseShippingOptionEvent,
  resolveProductFulfillment,
  selectLatestShippingOptions,
  type ParsedShippingOption,
  type ProductSchema,
} from "@conduit/core"

const MERCHANT = "a".repeat(64)
const OTHER_MERCHANT = "b".repeat(64)
const PRODUCT_D_TAG = "field-notes"
const SHIPPING_COORDINATE = getProductShippingOptionAddress(
  MERCHANT,
  PRODUCT_D_TAG
)

function product(overrides: Partial<ProductSchema> = {}): ProductSchema {
  return {
    id: `30402:${MERCHANT}:${PRODUCT_D_TAG}`,
    pubkey: MERCHANT,
    title: "Field Notes",
    price: 20,
    currency: "USD",
    sourcePrice: {
      amount: 20,
      currency: "USD",
      normalizedCurrency: "USD",
    },
    type: "simple",
    format: "physical",
    shippingOptionId: SHIPPING_COORDINATE,
    shippingOptionDTag: `${PRODUCT_D_TAG}-shipping-standard`,
    visibility: "public",
    images: [{ url: "https://example.com/field-notes.png" }],
    tags: ["stationery"],
    publicZapEnabled: true,
    zapMessagePolicy: "generic_only",
    publicZapPolicyKnown: true,
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  }
}

function shippingOption(
  overrides: Partial<ParsedShippingOption> = {}
): ParsedShippingOption {
  return {
    eventId: "shipping-event",
    id: SHIPPING_COORDINATE,
    pubkey: MERCHANT,
    dTag: `${PRODUCT_D_TAG}-shipping-standard`,
    title: "Standard Shipping",
    currency: "USD",
    price: 5,
    countries: ["US", "CA"],
    countryRules: [
      { code: "US", name: "US", restrictTo: [], exclude: [] },
      { code: "CA", name: "CA", restrictTo: [], exclude: [] },
    ],
    service: "standard",
    createdAt: 1_000,
    launchUnsupportedTags: [],
    ...overrides,
  }
}

describe("canonical fixed product shipping", () => {
  it("compiles the three shared fulfillment intents", () => {
    expect(
      compileProductFulfillmentIntent({
        format: "digital",
        shippingPricingMode: "fixed",
        amount: 5,
        currency: "USD",
        destinations: [],
      })
    ).toEqual({ kind: "digital" })
    expect(
      compileProductFulfillmentIntent({
        format: "physical",
        shippingPricingMode: "coordinate_after_order",
        currency: "USD",
        destinations: [],
      })
    ).toEqual({ kind: "coordinate_after_order" })
    expect(
      compileProductFulfillmentIntent({
        format: "physical",
        shippingPricingMode: "fixed",
        amount: 5,
        currency: "usd",
        destinations: [
          {
            code: "us",
            name: "United States",
            restrictTo: [],
            exclude: [],
          },
        ],
      })
    ).toEqual({
      kind: "fixed_standard",
      amount: 5,
      currency: "USD",
      countries: ["US"],
    })
  })

  it("canonicalizes equivalent destination sets to one wire order", () => {
    const presetIntent = compileProductFulfillmentIntent({
      format: "physical",
      shippingPricingMode: "fixed",
      amount: 5,
      currency: "usd",
      destinations: [
        {
          code: "US",
          name: "United States",
          restrictTo: [],
          exclude: [],
        },
        {
          code: "CA",
          name: "Canada",
          restrictTo: [],
          exclude: [],
        },
      ],
    })
    const customIntent = compileProductFulfillmentIntent({
      format: "physical",
      shippingPricingMode: "fixed",
      amount: 5,
      currency: "USD",
      destinations: [
        {
          code: "ca",
          name: "Canada",
          restrictTo: [],
          exclude: [],
        },
        {
          code: "us",
          name: "United States",
          restrictTo: [],
          exclude: [],
        },
        {
          code: "CA",
          name: "Canada",
          restrictTo: [],
          exclude: [],
        },
      ],
    })

    expect(presetIntent).toEqual(customIntent)
    expect(presetIntent).toMatchObject({ countries: ["CA", "US"] })
    if (
      presetIntent.kind !== "fixed_standard" ||
      customIntent.kind !== "fixed_standard"
    ) {
      throw new Error("Expected fixed shipping intents")
    }
    expect(
      buildFixedShippingOptionEventDraft({
        productDTag: PRODUCT_D_TAG,
        intent: presetIntent,
      })
    ).toEqual(
      buildFixedShippingOptionEventDraft({
        productDTag: PRODUCT_D_TAG,
        intent: customIntent,
      })
    )
  })

  it("emits one complete Gamma option and one exact two-field product reference", () => {
    const intent = {
      kind: "fixed_standard" as const,
      amount: 5,
      currency: "USD",
      countries: ["US", "CA"],
    }
    const shippingDraft = buildFixedShippingOptionEventDraft({
      productDTag: PRODUCT_D_TAG,
      intent,
    })
    const productDraft = buildProductListingEventDraft({
      product: product(),
      dTag: PRODUCT_D_TAG,
    })

    expect(shippingDraft.tags).toEqual([
      ["d", `${PRODUCT_D_TAG}-shipping-standard`],
      ["title", "Standard Shipping"],
      ["price", "5", "USD"],
      ["country", "US", "CA"],
      ["service", "standard"],
    ])
    expect(productDraft.tags).toContainEqual([
      "shipping_option",
      SHIPPING_COORDINATE,
    ])
    expect(
      productDraft.tags.find((tag) => tag[0] === "shipping_option")
    ).toHaveLength(2)
    for (const legacyTag of [
      "shipping_cost",
      "shipping_country",
      "shipping_restrict",
      "shipping_exclude",
    ]) {
      expect(productDraft.tags.some((tag) => tag[0] === legacyTag)).toBe(false)
    }
  })

  it("resolves only an exact merchant-owned, supported, current option", () => {
    expect(resolveProductFulfillment(product(), [shippingOption()])).toEqual({
      intent: "fixed_standard",
      status: "ready",
      option: shippingOption(),
    })

    expect(
      resolveProductFulfillment(
        product({ shippingOptionId: "not-a-coordinate" }),
        [shippingOption()]
      )
    ).toMatchObject({ status: "order_first", reason: "invalid_reference" })
    expect(
      resolveProductFulfillment(
        product({
          shippingOptionId: getProductShippingOptionAddress(
            OTHER_MERCHANT,
            PRODUCT_D_TAG
          ),
        }),
        [shippingOption()]
      )
    ).toMatchObject({ status: "order_first", reason: "provider_unsupported" })
    expect(resolveProductFulfillment(product(), [])).toMatchObject({
      status: "order_first",
      reason: "unresolved",
    })
    expect(
      resolveProductFulfillment(product(), [
        shippingOption({ launchUnsupportedTags: ["carrier"] }),
      ])
    ).toMatchObject({ status: "order_first", reason: "unsupported" })
    expect(
      resolveProductFulfillment(product(), [
        shippingOption({ currency: "CAD" }),
      ])
    ).toMatchObject({ status: "order_first", reason: "currency_mismatch" })
    expect(
      resolveProductFulfillment(product(), [
        shippingOption({ createdAt: 2_001 }),
      ])
    ).toMatchObject({ status: "order_first", reason: "stale" })
    expect(
      resolveProductFulfillment(product(), [
        shippingOption({ eventId: "one" }),
        shippingOption({ eventId: "two" }),
      ])
    ).toMatchObject({ status: "order_first", reason: "conflicting" })
  })

  it("fails closed for product extra-cost and multiple option references", () => {
    const extraCostProduct = parseProductEvent({
      id: "extra-cost-product",
      pubkey: MERCHANT,
      created_at: 2,
      content: "Extra-cost listing",
      tags: [
        ["d", PRODUCT_D_TAG],
        ["title", "Field Notes"],
        ["price", "20", "USD"],
        ["type", "simple", "physical"],
        ["shipping_option", SHIPPING_COORDINATE, "3"],
      ],
    })
    const multipleOptionsProduct = parseProductEvent({
      id: "multiple-options-product",
      pubkey: MERCHANT,
      created_at: 2,
      content: "Multiple-option listing",
      tags: [
        ["d", PRODUCT_D_TAG],
        ["title", "Field Notes"],
        ["price", "20", "USD"],
        ["type", "simple", "physical"],
        ["shipping_option", SHIPPING_COORDINATE],
        [
          "shipping_option",
          getProductShippingOptionAddress(MERCHANT, "express"),
        ],
      ],
    })

    expect(extraCostProduct.shippingOptionLaunchUnsupported).toBe(true)
    expect(multipleOptionsProduct.shippingOptionLaunchUnsupported).toBe(true)
    expect(
      resolveProductFulfillment(extraCostProduct, [shippingOption()])
    ).toMatchObject({ status: "order_first", reason: "unsupported" })
    expect(
      resolveProductFulfillment(multipleOptionsProduct, [shippingOption()])
    ).toMatchObject({ status: "order_first", reason: "unsupported" })
  })

  it("requires all Gamma launch fields and lets malformed latest events mask older state", () => {
    const valid = {
      id: "valid",
      pubkey: MERCHANT,
      created_at: 1,
      tags: [
        ["d", `${PRODUCT_D_TAG}-shipping-standard`],
        ["title", "Standard Shipping"],
        ["price", "5", "USD"],
        ["country", "US"],
        ["service", "standard"],
      ],
    }
    const malformedLatest = {
      ...valid,
      id: "malformed",
      created_at: 2,
      tags: valid.tags.filter((tag) => tag[0] !== "service"),
    }

    expect(parseShippingOptionEvent(valid)).not.toBeNull()
    expect(parseShippingOptionEvent(malformedLatest)).toBeNull()
    expect(selectLatestShippingOptions([valid, malformedLatest])).toEqual([])
    expect(
      parseShippingOptionEvent({
        ...valid,
        id: "ambiguous-price",
        tags: [...valid.tags, ["price", "6", "USD"]],
      })
    ).toBeNull()
  })

  it("keeps legacy inline listings readable but fail-closed for direct payment", () => {
    const legacy = parseProductEvent({
      id: "legacy-event",
      pubkey: MERCHANT,
      created_at: 1,
      content: "Legacy listing",
      tags: [
        ["d", PRODUCT_D_TAG],
        ["title", "Field Notes"],
        ["price", "20", "USD"],
        ["type", "simple", "physical"],
        ["shipping_cost", "5", "USD"],
        ["shipping_country", "US"],
      ],
    })
    const resolution = resolveProductFulfillment(legacy, [])
    const republished = buildProductListingEventDraft({
      product: legacy,
      dTag: PRODUCT_D_TAG,
    })

    expect(legacy).toMatchObject({
      sourceShippingCost: {
        amount: 5,
        currency: "USD",
        normalizedCurrency: "USD",
      },
      shippingCountries: ["US"],
    })
    expect(resolution).toMatchObject({
      intent: "fixed_standard",
      status: "order_first",
      reason: "legacy_inline",
    })
    expect(republished.tags.some((tag) => tag[0].startsWith("shipping_"))).toBe(
      false
    )
  })

  it("rejects postal restrictions in new fixed-shipping authoring", () => {
    expect(() =>
      compileProductFulfillmentIntent({
        format: "physical",
        shippingPricingMode: "fixed",
        amount: 5,
        currency: "USD",
        destinations: [
          {
            code: "US",
            name: "United States",
            restrictTo: ["787**"],
            exclude: [],
          },
        ],
      })
    ).toThrow("Fixed checkout supports country destinations only.")
  })

  it("does not infer country eligibility when no option resolved", () => {
    expect(isBuyerCountryEligible("US", [])).toBe(false)
  })
})
