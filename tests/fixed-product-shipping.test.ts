import { describe, expect, it } from "bun:test"
import {
  buildFixedShippingOptionEventDraft,
  buildFixedShippingOptionEventDrafts,
  buildProductListingEventDraft,
  buildShippingOptionReadBatches,
  compileProductFulfillmentIntent,
  getProductShippingOptionAddress,
  getProductShippingZoneAddress,
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
  it("compiles and emits one priced Gamma option per country-rate zone", () => {
    const intent = compileProductFulfillmentIntent({
      format: "physical",
      shippingPricingMode: "fixed",
      currency: "SATS",
      destinations: [
        {
          code: "US",
          name: "United States",
          restrictTo: [],
          exclude: [],
          rate: { amount: 5_000, currency: "SATS" },
        },
        {
          code: "DE",
          name: "Germany",
          restrictTo: [],
          exclude: [],
          rate: { amount: 9_000, currency: "SATS" },
        },
        {
          code: "FR",
          name: "France",
          restrictTo: [],
          exclude: [],
          rate: { amount: 9_000, currency: "SATS" },
        },
      ],
    })

    expect(intent).toEqual({
      kind: "fixed_standard",
      zones: [
        {
          amount: 9_000,
          currency: "SATS",
          countries: ["DE", "FR"],
          usesProductFallback: false,
        },
        {
          amount: 5_000,
          currency: "SATS",
          countries: ["US"],
          usesProductFallback: false,
        },
      ],
    })

    if (intent.kind !== "fixed_standard") {
      throw new Error("Expected fixed shipping intent")
    }
    const drafts = buildFixedShippingOptionEventDrafts({
      productDTag: PRODUCT_D_TAG,
      intent,
    })

    expect(drafts.map((draft) => draft.tags)).toEqual([
      [
        ["d", `${PRODUCT_D_TAG}-shipping-standard-de-fr`],
        ["title", "Standard Shipping (DE, FR)"],
        ["price", "9000", "SATS"],
        ["country", "DE", "FR"],
        ["service", "standard"],
      ],
      [
        ["d", `${PRODUCT_D_TAG}-shipping-standard-us`],
        ["title", "Standard Shipping (US)"],
        ["price", "5000", "SATS"],
        ["country", "US"],
        ["service", "standard"],
      ],
    ])
  })

  it("selects the buyer's exact priced zone and fails closed on overlap", () => {
    const usCoordinate = getProductShippingZoneAddress(
      MERCHANT,
      PRODUCT_D_TAG,
      ["US"]
    )
    const euCoordinate = getProductShippingZoneAddress(
      MERCHANT,
      PRODUCT_D_TAG,
      ["DE", "FR"]
    )
    const zonedProduct = product({
      currency: "SATS",
      sourcePrice: {
        amount: 20_000,
        currency: "SATS",
        normalizedCurrency: "SATS",
      },
      shippingOptionId: usCoordinate,
      shippingOptionDTag: `${PRODUCT_D_TAG}-shipping-standard-us`,
      shippingOptionIds: [euCoordinate, usCoordinate],
      shippingOptionDTags: [
        `${PRODUCT_D_TAG}-shipping-standard-de-fr`,
        `${PRODUCT_D_TAG}-shipping-standard-us`,
      ],
    })
    const usOption = shippingOption({
      eventId: "us-event",
      id: usCoordinate,
      dTag: `${PRODUCT_D_TAG}-shipping-standard-us`,
      currency: "SATS",
      price: 5_000,
      countries: ["US"],
      countryRules: [{ code: "US", name: "US", restrictTo: [], exclude: [] }],
    })
    const euOption = shippingOption({
      eventId: "eu-event",
      id: euCoordinate,
      dTag: `${PRODUCT_D_TAG}-shipping-standard-de-fr`,
      currency: "SATS",
      price: 9_000,
      countries: ["DE", "FR"],
      countryRules: [
        { code: "DE", name: "DE", restrictTo: [], exclude: [] },
        { code: "FR", name: "FR", restrictTo: [], exclude: [] },
      ],
    })

    expect(
      resolveProductFulfillment(zonedProduct, [usOption, euOption], {
        country: "US",
        postalCode: "02139",
      })
    ).toMatchObject({
      status: "ready",
      option: { id: usCoordinate, price: 5_000 },
    })
    expect(
      resolveProductFulfillment(zonedProduct, [usOption, euOption], {
        country: "DE",
        postalCode: "10115",
      })
    ).toMatchObject({
      status: "ready",
      option: { id: euCoordinate, price: 9_000 },
    })
    expect(
      resolveProductFulfillment(zonedProduct, [usOption, euOption], {
        country: "GB",
        postalCode: "SW1A1AA",
      })
    ).toMatchObject({
      status: "order_first",
      reason: "destination_unsupported",
    })
    expect(
      resolveProductFulfillment(
        zonedProduct,
        [
          usOption,
          shippingOption({
            eventId: "overlap",
            id: euCoordinate,
            dTag: `${PRODUCT_D_TAG}-shipping-standard-de-fr`,
            currency: "SATS",
            price: 9_000,
            countries: ["US", "DE"],
            countryRules: [
              { code: "US", name: "US", restrictTo: [], exclude: [] },
              { code: "DE", name: "DE", restrictTo: [], exclude: [] },
            ],
          }),
        ],
        { country: "US", postalCode: "02139" }
      )
    ).toMatchObject({
      status: "order_first",
      reason: "ambiguous_destination",
    })
  })

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
      zones: [
        {
          amount: 5,
          currency: "USD",
          countries: ["US"],
          usesProductFallback: true,
        },
      ],
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
    expect(presetIntent).toMatchObject({
      zones: [{ countries: ["CA", "US"] }],
    })
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
      zones: [
        {
          amount: 5,
          currency: "USD",
          countries: ["US", "CA"],
          usesProductFallback: true,
        },
      ],
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

    const usCoordinate = getProductShippingZoneAddress(
      MERCHANT,
      PRODUCT_D_TAG,
      ["US"]
    )
    const euCoordinate = getProductShippingZoneAddress(
      MERCHANT,
      PRODUCT_D_TAG,
      ["DE", "FR"]
    )
    const zonedProductDraft = buildProductListingEventDraft({
      product: product({
        shippingOptionId: usCoordinate,
        shippingOptionIds: [euCoordinate, usCoordinate],
      }),
      dTag: PRODUCT_D_TAG,
    })
    expect(
      zonedProductDraft.tags.filter((tag) => tag[0] === "shipping_option")
    ).toEqual([
      ["shipping_option", euCoordinate],
      ["shipping_option", usCoordinate],
    ])

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
    expect(
      resolveProductFulfillment(product(), [shippingOption()])
    ).toMatchObject({
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

  it("fails closed for product extra-cost while accepting multiple references", () => {
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
    expect(multipleOptionsProduct.shippingOptionLaunchUnsupported).toBe(false)
    expect(multipleOptionsProduct.shippingOptionIds).toEqual([
      SHIPPING_COORDINATE,
      getProductShippingOptionAddress(MERCHANT, "express"),
    ])
    expect(
      resolveProductFulfillment(extraCostProduct, [shippingOption()])
    ).toMatchObject({ status: "order_first", reason: "unsupported" })
    expect(
      resolveProductFulfillment(multipleOptionsProduct, [shippingOption()])
    ).toMatchObject({ status: "order_first", reason: "unresolved" })
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

  it("does not resolve a latest shipping option deleted by address or event id", () => {
    const older = {
      id: "older",
      pubkey: MERCHANT,
      created_at: 1,
      tags: [
        ["d", `${PRODUCT_D_TAG}-shipping-standard`],
        ["title", "Standard Shipping"],
        ["price", "4", "USD"],
        ["country", "US"],
        ["service", "standard"],
      ],
    }
    const latest = {
      ...older,
      id: "latest",
      created_at: 2,
      tags: older.tags.map((tag) =>
        tag[0] === "price" ? ["price", "5", "USD"] : tag
      ),
    }

    for (const target of [
      ["a", SHIPPING_COORDINATE],
      ["e", latest.id],
    ]) {
      expect(
        selectLatestShippingOptions(
          [older, latest],
          [
            {
              id: `delete-${target[0]}`,
              pubkey: MERCHANT,
              created_at: 3,
              tags: [target],
            },
          ]
        )
      ).toEqual([])
    }

    expect(
      selectLatestShippingOptions(
        [latest],
        [
          {
            id: "foreign-delete",
            pubkey: OTHER_MERCHANT,
            created_at: 3,
            tags: [["a", SHIPPING_COORDINATE]],
          },
          {
            id: "older-delete",
            pubkey: MERCHANT,
            created_at: 1,
            tags: [["e", latest.id]],
          },
        ]
      )
    ).toHaveLength(1)
  })

  it("batches exact shipping reads below the relay result limit", () => {
    const merchantCoordinates = Array.from(
      { length: 101 },
      (_, index) => `30406:${MERCHANT}:option-${index}`
    )
    const batches = buildShippingOptionReadBatches([
      ...merchantCoordinates,
      merchantCoordinates[0]!,
      `30406:${OTHER_MERCHANT}:other-option`,
      "invalid-coordinate",
    ])

    expect(batches.map((batch) => batch.coordinates.length)).toEqual([
      50, 50, 1, 1,
    ])
    expect(batches[0]).toMatchObject({
      pubkey: MERCHANT,
      dTags: Array.from({ length: 50 }, (_, index) => `option-${index}`),
    })
    expect(batches[3]).toEqual({
      pubkey: OTHER_MERCHANT,
      coordinates: [`30406:${OTHER_MERCHANT}:other-option`],
      dTags: ["other-option"],
    })
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
            restrictTo: [],
            exclude: [],
            rate: { amount: -1, currency: "USD" },
          },
        ],
      })
    ).toThrow("non-negative zone rate for US")
  })

  it("does not infer country eligibility when no option resolved", () => {
    expect(isBuyerCountryEligible("US", [])).toBe(false)
  })
})
