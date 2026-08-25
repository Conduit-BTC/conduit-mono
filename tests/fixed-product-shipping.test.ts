import { NDKEvent } from "@nostr-dev-kit/ndk"
import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  __resetRelayListTestOverrides,
  __resetShippingTestOverrides,
  __setRelayListTestOverrides,
  __setShippingTestOverrides,
  buildFixedShippingOptionEventDraft,
  buildProductListingEventDraft,
  buildShippingOptionDeletionEventDraft,
  buildShippingOptionReadBatches,
  compileProductFulfillmentIntent,
  getShippingOptionsByCoordinates,
  getProductShippingOptionAddress,
  isBuyerCountryEligible,
  parseProductEvent,
  parseShippingOptionEvent,
  resolveProductFulfillment,
  selectLatestShippingOptions,
  type ParsedShippingOption,
  type ProductSchema,
  type CachedProductTombstone,
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
        ]
      )
    ).toHaveLength(1)
    expect(
      selectLatestShippingOptions(
        [latest],
        [
          {
            id: "older-delete",
            pubkey: MERCHANT,
            created_at: 1,
            tags: [["e", latest.id]],
          },
        ]
      )
    ).toEqual([])
  })

  it("applies address deletions only to revisions at or before their cutoff", () => {
    const option = {
      id: "latest",
      pubkey: MERCHANT,
      created_at: 2,
      tags: [
        ["d", `${PRODUCT_D_TAG}-shipping-standard`],
        ["title", "Standard Shipping"],
        ["price", "5", "USD"],
        ["country", "US"],
        ["service", "standard"],
      ],
    }

    expect(
      selectLatestShippingOptions(
        [option],
        [
          {
            id: "older-address-delete",
            pubkey: MERCHANT,
            created_at: 1,
            tags: [["a", SHIPPING_COORDINATE]],
          },
        ]
      )
    ).toHaveLength(1)
    expect(
      selectLatestShippingOptions(
        [option],
        [
          {
            id: "equal-address-delete",
            pubkey: MERCHANT,
            created_at: 2,
            tags: [["a", SHIPPING_COORDINATE]],
          },
        ]
      )
    ).toEqual([])
  })

  it("keeps an omitted exact-id-deleted revision withdrawn by canonical address provenance", () => {
    const older = {
      id: "1".repeat(64),
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
    const deletedLatestEventId = "2".repeat(64)
    const deletion = buildShippingOptionDeletionEventDraft({
      merchantPubkey: MERCHANT,
      coordinate: SHIPPING_COORDINATE,
      eventId: deletedLatestEventId,
    })

    expect(deletion).toEqual({
      kind: 5,
      content: "",
      tags: [
        ["e", deletedLatestEventId],
        ["a", SHIPPING_COORDINATE],
        ["k", "30406"],
      ],
    })
    expect(
      selectLatestShippingOptions(
        [older],
        [
          {
            id: "3".repeat(64),
            pubkey: MERCHANT,
            created_at: 3,
            tags: deletion.tags,
          },
        ]
      )
    ).toEqual([])
    expect(() =>
      buildShippingOptionDeletionEventDraft({
        merchantPubkey: OTHER_MERCHANT,
        coordinate: SHIPPING_COORDINATE,
        eventId: deletedLatestEventId,
      })
    ).toThrow("same-author kind-30406 coordinate")
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

  it("fails closed for unverified or saturated authoritative relay reads", async () => {
    let mode: "unverified" | "saturated" = "unverified"
    __setRelayListTestOverrides({
      loadCached: async (author) => ({
        pubkey: author,
        readRelayUrls: ["wss://read.example"],
        writeRelayUrls: ["wss://write.example"],
        eventCreatedAt: 1,
        cachedAt: 1,
      }),
    })
    __setShippingTestOverrides({
      fetchEventsFanoutDetailed: async (_filter, options) => ({
        events: [],
        relays: (options?.relayUrls ?? []).map((relayUrl) => ({
          relayUrl,
          status: "success" as const,
          eventCount: mode === "saturated" ? 100 : 0,
        })),
        eventsVerified: mode !== "unverified",
      }),
    })

    try {
      await expect(
        getShippingOptionsByCoordinates([SHIPPING_COORDINATE])
      ).rejects.toThrow(
        "Fixed shipping could not be verified across the planned relays"
      )

      mode = "saturated"
      await expect(
        getShippingOptionsByCoordinates([SHIPPING_COORDINATE])
      ).rejects.toThrow(
        "Fixed shipping could not be verified across the planned relays"
      )
    } finally {
      __resetShippingTestOverrides()
      __resetRelayListTestOverrides()
    }
  })

  it("retains only validated shipping deletion evidence across relay omission and persistence retry", async () => {
    const secretKey = generateSecretKey()
    const pubkey = getPublicKey(secretKey)
    const coordinate = `30406:${pubkey}:field-notes-shipping-standard`
    const shippingEvent = new NDKEvent(
      undefined,
      finalizeEvent(
        {
          kind: 30406,
          created_at: 100,
          content: "",
          tags: [
            ["d", "field-notes-shipping-standard"],
            ["title", "Standard Shipping"],
            ["price", "5", "USD"],
            ["country", "US"],
            ["service", "standard"],
          ],
        },
        secretKey
      )
    )
    const deletion = new NDKEvent(
      undefined,
      finalizeEvent(
        {
          kind: 5,
          created_at: 110,
          content: "",
          tags: [["a", coordinate]],
        },
        secretKey
      )
    )
    let includeDeletion = true
    let partialDeletionCoverage = false
    let failWrites = false
    let cachedTombstones: CachedProductTombstone[] = []

    __setRelayListTestOverrides({
      loadCached: async (author) => ({
        pubkey: author,
        readRelayUrls: ["wss://read.example"],
        writeRelayUrls: ["wss://write.example"],
        eventCreatedAt: 1,
        cachedAt: 1,
      }),
    })
    __setShippingTestOverrides({
      fetchEventsFanoutDetailed: async (filter, options) => {
        const events = filter.kinds?.includes(30406)
          ? [shippingEvent]
          : filter["#a"] && includeDeletion
            ? [deletion]
            : []
        const relayUrls = options?.relayUrls ?? []
        const observedRelayUrls =
          filter["#a"] && partialDeletionCoverage
            ? relayUrls.slice(1)
            : relayUrls
        return {
          events,
          relays: observedRelayUrls.map((relayUrl) => ({
            relayUrl,
            status: "success" as const,
            eventCount: events.length,
          })),
          eventsVerified: true,
        }
      },
      getCachedDeletionTombstones: async (targetIds) =>
        cachedTombstones.filter((row) => targetIds.includes(row.id)),
      putCachedDeletionTombstones: async (rows) => {
        if (failWrites) throw new Error("IndexedDB unavailable")
        for (const row of rows) {
          cachedTombstones = [
            ...cachedTombstones.filter((current) => current.id !== row.id),
            row,
          ]
        }
      },
    })

    try {
      const validSignature = deletion.sig
      deletion.sig = "0".repeat(128)
      expect(await getShippingOptionsByCoordinates([coordinate])).toHaveLength(
        1
      )
      expect(cachedTombstones).toEqual([])

      deletion.sig = validSignature
      failWrites = true
      partialDeletionCoverage = true
      await expect(
        getShippingOptionsByCoordinates([coordinate])
      ).rejects.toThrow(
        "Fixed shipping could not be verified across the planned relays"
      )
      includeDeletion = false
      partialDeletionCoverage = false
      expect(await getShippingOptionsByCoordinates([coordinate])).toEqual([])
      expect(cachedTombstones).toEqual([])

      failWrites = false
      expect(await getShippingOptionsByCoordinates([coordinate])).toEqual([])
      expect(cachedTombstones.length).toBeGreaterThan(0)
    } finally {
      __resetShippingTestOverrides()
      __resetRelayListTestOverrides()
    }
  }, 15_000)

  it("retains an exact-event deletion even when its timestamp predates the shipping event", async () => {
    const secretKey = generateSecretKey()
    const pubkey = getPublicKey(secretKey)
    const coordinate = `30406:${pubkey}:field-notes-shipping-standard`
    const shippingEvent = new NDKEvent(
      undefined,
      finalizeEvent(
        {
          kind: 30406,
          created_at: 100,
          content: "",
          tags: [
            ["d", "field-notes-shipping-standard"],
            ["title", "Standard Shipping"],
            ["price", "5", "USD"],
            ["country", "US"],
            ["service", "standard"],
          ],
        },
        secretKey
      )
    )
    const deletion = new NDKEvent(
      undefined,
      finalizeEvent(
        {
          kind: 5,
          created_at: 90,
          content: "",
          tags: [["e", shippingEvent.id]],
        },
        secretKey
      )
    )
    let includeDeletion = true
    let cachedTombstones: CachedProductTombstone[] = []

    __setRelayListTestOverrides({
      loadCached: async (author) => ({
        pubkey: author,
        readRelayUrls: ["wss://read.example"],
        writeRelayUrls: ["wss://write.example"],
        eventCreatedAt: 1,
        cachedAt: 1,
      }),
    })
    __setShippingTestOverrides({
      fetchEventsFanoutDetailed: async (filter, options) => {
        const events = filter.kinds?.includes(30406)
          ? [shippingEvent]
          : filter["#e"] && includeDeletion
            ? [deletion]
            : []
        return {
          events,
          relays: (options?.relayUrls ?? []).map((relayUrl) => ({
            relayUrl,
            status: "success" as const,
            eventCount: events.length,
          })),
          eventsVerified: true,
        }
      },
      getCachedDeletionTombstones: async (targetIds) =>
        cachedTombstones.filter((row) => targetIds.includes(row.id)),
      putCachedDeletionTombstones: async (rows) => {
        for (const row of rows) {
          cachedTombstones = [
            ...cachedTombstones.filter((current) => current.id !== row.id),
            row,
          ]
        }
      },
    })

    try {
      expect(await getShippingOptionsByCoordinates([coordinate])).toEqual([])
      expect(cachedTombstones).toHaveLength(1)

      includeDeletion = false
      expect(await getShippingOptionsByCoordinates([coordinate])).toEqual([])
      expect(cachedTombstones[0]?.id).toContain(shippingEvent.id)
    } finally {
      __resetShippingTestOverrides()
      __resetRelayListTestOverrides()
    }
  }, 15_000)

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
