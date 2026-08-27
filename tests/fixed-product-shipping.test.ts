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
  type CachedShippingOptionFrontier,
  type CachedProductTombstone,
  type ShippingDeletionFallbackStorage,
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

  it("serializes fixed shipping prices as parser-compatible plain decimals", () => {
    const cases = [
      { amount: 0.00000001, currency: "BTC", wireAmount: "0.00000001" },
      { amount: 5.99, currency: "USD", wireAmount: "5.99" },
      { amount: 5, currency: "SATS", wireAmount: "5" },
    ] as const

    for (const { amount, currency, wireAmount } of cases) {
      const draft = buildFixedShippingOptionEventDraft({
        productDTag: PRODUCT_D_TAG,
        intent: {
          kind: "fixed_standard",
          amount,
          currency,
          countries: ["US"],
        },
      })

      expect(draft.tags).toContainEqual(["price", wireAmount, currency])
      expect(
        parseShippingOptionEvent({
          id: `shipping-${currency.toLowerCase()}`,
          pubkey: MERCHANT,
          created_at: 1,
          tags: draft.tags,
        })
      ).toMatchObject({ price: amount, currency })
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

  it("rejects malformed required tag shapes and non-decimal prices without reviving older state", () => {
    const valid = {
      id: "valid-required-tag-shapes",
      pubkey: MERCHANT,
      created_at: 1,
      tags: [
        ["d", `${PRODUCT_D_TAG}-shipping-standard`],
        ["title", "Standard Shipping"],
        ["price", "5.00", "USD"],
        ["country", "US"],
        ["service", "standard"],
      ],
    }
    const replaceTag = (name: string, replacement: string[]) =>
      valid.tags.map((tag) => (tag[0] === name ? replacement : tag))
    const malformedCases = [
      ["whitespace price", replaceTag("price", ["price", " ", "USD"])],
      ["hex price", replaceTag("price", ["price", "0x10", "USD"])],
      ["scientific price", replaceTag("price", ["price", "5e1", "USD"])],
      [
        "nonzero price that underflows to zero",
        replaceTag("price", ["price", `0.${"0".repeat(400)}1`, "USD"]),
      ],
      [
        "extra price component",
        replaceTag("price", ["price", "5", "USD", "ignored"]),
      ],
      [
        "extra d component",
        replaceTag("d", ["d", `${PRODUCT_D_TAG}-shipping-standard`, "ignored"]),
      ],
      [
        "d coordinate whitespace",
        replaceTag("d", ["d", ` ${PRODUCT_D_TAG}-shipping-standard`]),
      ],
      [
        "extra title component",
        replaceTag("title", ["title", "Standard Shipping", "ignored"]),
      ],
      [
        "extra service component",
        replaceTag("service", ["service", "standard", "ignored"]),
      ],
      ["service whitespace", replaceTag("service", ["service", " standard "])],
      ["currency whitespace", replaceTag("price", ["price", "5", " USD "])],
      [
        "non-canonical country whitespace",
        replaceTag("country", ["country", " US "]),
      ],
      ["country without a value", replaceTag("country", ["country"])],
      [
        "truncated client metadata",
        [...valid.tags, ["client", "Conduit Market"]],
      ],
      [
        "extended client metadata",
        [
          ...valid.tags,
          [
            "client",
            "Conduit Market",
            `31990:${MERCHANT}:market`,
            "wss://relay.conduit.market",
            "ignored",
          ],
        ],
      ],
    ] as const

    expect(parseShippingOptionEvent(valid)).not.toBeNull()
    for (const [name, tags] of malformedCases) {
      const malformedLatest = {
        ...valid,
        id: `malformed-${name}`,
        created_at: 2,
        tags,
      }
      expect(parseShippingOptionEvent(malformedLatest)).toBeNull()
      expect(selectLatestShippingOptions([valid, malformedLatest])).toEqual([])
    }
  })

  it("fails closed on every unknown launch tag while allowing client metadata", () => {
    const base = {
      id: "shipping-with-constraints",
      pubkey: MERCHANT,
      created_at: 1,
      tags: [
        ["d", `${PRODUCT_D_TAG}-shipping-standard`],
        ["title", "Standard Shipping"],
        ["price", "5", "USD"],
        ["country", "US"],
        ["service", "standard"],
        [
          "client",
          "Conduit Market",
          `31990:${MERCHANT}:market`,
          "wss://relay.conduit.market",
        ],
      ],
    }

    expect(parseShippingOptionEvent(base)?.launchUnsupportedTags).toEqual([])

    const unknownConstraint = parseShippingOptionEvent({
      ...base,
      id: "shipping-with-future-constraint",
      tags: [...base.tags, ["future_constraint", "merchant-defined"]],
    })
    expect(unknownConstraint?.launchUnsupportedTags).toEqual([
      "future_constraint",
    ])
    expect(
      resolveProductFulfillment(product(), [unknownConstraint!])
    ).toMatchObject({ status: "order_first", reason: "unsupported" })

    const draftDestinationConstraint = parseShippingOptionEvent({
      ...base,
      id: "shipping-with-draft-destination",
      tags: [
        ...base.tags,
        ["destination_schema", "1"],
        ["destination", "include", "country", "US"],
        ["destination", "exclude", "subdivision", "US-HI"],
      ],
    })
    expect(draftDestinationConstraint?.launchUnsupportedTags).toEqual([
      "destination",
      "destination_schema",
    ])
    expect(
      resolveProductFulfillment(product(), [draftDestinationConstraint!])
    ).toMatchObject({ status: "order_first", reason: "unsupported" })
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
    let cachedFrontiers: CachedShippingOptionFrontier[] = []

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
      getCachedOptionFrontiers: async (coordinates) =>
        cachedFrontiers.filter((row) => coordinates.includes(row.coordinate)),
      putCachedOptionFrontiers: async (rows) => {
        for (const row of rows) {
          cachedFrontiers = [
            ...cachedFrontiers.filter(
              (current) => current.coordinate !== row.coordinate
            ),
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
        "Fixed shipping deletion evidence could not be retained"
      )
      includeDeletion = false
      partialDeletionCoverage = false
      await expect(
        getShippingOptionsByCoordinates([coordinate])
      ).rejects.toThrow(
        "Fixed shipping deletion evidence could not be retained"
      )
      expect(cachedTombstones).toEqual([])

      failWrites = false
      expect(await getShippingOptionsByCoordinates([coordinate])).toEqual([])
      expect(cachedTombstones.length).toBeGreaterThan(0)
    } finally {
      __resetShippingTestOverrides()
      __resetRelayListTestOverrides()
    }
  }, 15_000)

  it("fails closed when an unrelated volatile withdrawal cannot cover a durable tombstone read failure", async () => {
    const secretKey = generateSecretKey()
    const pubkey = getPublicKey(secretKey)
    const dTagA = "field-notes-a-shipping-standard"
    const dTagB = "field-notes-b-shipping-standard"
    const coordinateA = `30406:${pubkey}:${dTagA}`
    const coordinateB = `30406:${pubkey}:${dTagB}`
    const makeShippingEvent = (dTag: string, createdAt: number) =>
      new NDKEvent(
        undefined,
        finalizeEvent(
          {
            kind: 30406,
            created_at: createdAt,
            content: "",
            tags: [
              ["d", dTag],
              ["title", "Standard Shipping"],
              ["price", "5", "USD"],
              ["country", "US"],
              ["service", "standard"],
            ],
          },
          secretKey
        )
      )
    const shippingA = makeShippingEvent(dTagA, 100)
    const shippingB = makeShippingEvent(dTagB, 100)
    const makeDeletion = (coordinate: string, createdAt: number) =>
      new NDKEvent(
        undefined,
        finalizeEvent(
          {
            kind: 5,
            created_at: createdAt,
            content: "",
            tags: [["a", coordinate]],
          },
          secretKey
        )
      )
    const deletionA = makeDeletion(coordinateA, 120)
    const deletionB = makeDeletion(coordinateB, 110)
    const activeAddressDeletions = new Set<string>()
    let failDeletionReads = false
    let failDeletionWrites = false
    let cachedTombstones: CachedProductTombstone[] = []
    let cachedFrontiers: CachedShippingOptionFrontier[] = []

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
        let events: NDKEvent[] = []
        if (filter.kinds?.includes(30406)) {
          const requestedDTags = new Set(filter["#d"] ?? [])
          events = [shippingA, shippingB].filter((event) =>
            requestedDTags.has(
              event.tags.find((tag) => tag[0] === "d")?.[1] ?? ""
            )
          )
        } else if (filter["#a"]) {
          const requestedCoordinates = new Set(filter["#a"])
          events = [deletionA, deletionB].filter((event) => {
            const coordinate = event.tags.find((tag) => tag[0] === "a")?.[1]
            return (
              coordinate !== undefined &&
              requestedCoordinates.has(coordinate) &&
              activeAddressDeletions.has(coordinate)
            )
          })
        }
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
      getCachedDeletionTombstones: async (targetIds) => {
        if (failDeletionReads) throw new Error("IndexedDB read unavailable")
        return cachedTombstones.filter((row) => targetIds.includes(row.id))
      },
      putCachedDeletionTombstones: async (rows) => {
        if (failDeletionWrites) throw new Error("IndexedDB write unavailable")
        for (const row of rows) {
          cachedTombstones = [
            ...cachedTombstones.filter((current) => current.id !== row.id),
            row,
          ]
        }
      },
      getCachedOptionFrontiers: async (coordinates) =>
        cachedFrontiers.filter((row) => coordinates.includes(row.coordinate)),
      putCachedOptionFrontiers: async (rows) => {
        for (const row of rows) {
          cachedFrontiers = [
            ...cachedFrontiers.filter(
              (current) => current.coordinate !== row.coordinate
            ),
            row,
          ]
        }
      },
    })

    try {
      activeAddressDeletions.add(coordinateB)
      expect(await getShippingOptionsByCoordinates([coordinateB])).toEqual([])
      expect(
        cachedTombstones.some((row) => row.addressId === coordinateB)
      ).toBe(true)

      activeAddressDeletions.clear()
      activeAddressDeletions.add(coordinateA)
      failDeletionWrites = true
      await expect(
        getShippingOptionsByCoordinates([coordinateA])
      ).rejects.toThrow(
        "Fixed shipping deletion evidence could not be retained"
      )

      activeAddressDeletions.clear()
      failDeletionWrites = false
      expect(await getShippingOptionsByCoordinates([coordinateA])).toEqual([])
      failDeletionReads = true
      await expect(
        getShippingOptionsByCoordinates([coordinateA, coordinateB])
      ).rejects.toThrow(
        "Fixed shipping deletion evidence could not be verified"
      )
    } finally {
      __resetShippingTestOverrides()
      __resetRelayListTestOverrides()
    }
  }, 15_000)

  it("retains the strongest signed shipping frontier across later relay omission", async () => {
    const secretKey = generateSecretKey()
    const pubkey = getPublicKey(secretKey)
    const dTag = "field-notes-shipping-standard"
    const coordinate = `30406:${pubkey}:${dTag}`
    const makeShippingEvent = (input: {
      createdAt: number
      price: string
      title?: string
    }) =>
      new NDKEvent(
        undefined,
        finalizeEvent(
          {
            kind: 30406,
            created_at: input.createdAt,
            content: "",
            tags: [
              ["d", dTag],
              ...(input.title === undefined ? [] : [["title", input.title]]),
              ["price", input.price, "USD"],
              ["country", "US"],
              ["service", "standard"],
            ],
          },
          secretKey
        )
      )
    const older = makeShippingEvent({
      createdAt: 100,
      price: "1",
      title: "Older Shipping",
    })
    const newer = makeShippingEvent({
      createdAt: 200,
      price: "2",
      title: "Newer Shipping",
    })
    const malformedStrongest = makeShippingEvent({
      createdAt: 300,
      price: "3",
    })
    const conflictingA = makeShippingEvent({
      createdAt: 400,
      price: "4",
      title: "Conflicting A",
    })
    const conflictingB = makeShippingEvent({
      createdAt: 400,
      price: "5",
      title: "Conflicting B",
    })
    const conflictingC = makeShippingEvent({
      createdAt: 400,
      price: "6",
      title: "Conflicting C",
    })
    const conflictingD = makeShippingEvent({
      createdAt: 400,
      price: "7",
      title: "Conflicting D",
    })
    let visibleShippingEvents = [older, newer]
    let cachedFrontiers: CachedShippingOptionFrontier[] = []

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
          ? visibleShippingEvents
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
      getCachedDeletionTombstones: async () => [],
      putCachedDeletionTombstones: async () => undefined,
      getCachedOptionFrontiers: async (coordinates) =>
        cachedFrontiers.filter((row) => coordinates.includes(row.coordinate)),
      putCachedOptionFrontiers: async (rows) => {
        for (const row of rows) {
          cachedFrontiers = [
            ...cachedFrontiers.filter(
              (current) => current.coordinate !== row.coordinate
            ),
            row,
          ]
        }
      },
    })

    try {
      expect(await getShippingOptionsByCoordinates([coordinate])).toMatchObject(
        [{ eventId: newer.id, price: 2 }]
      )

      visibleShippingEvents = [older]
      expect(await getShippingOptionsByCoordinates([coordinate])).toEqual([])

      visibleShippingEvents = [newer, malformedStrongest]
      expect(await getShippingOptionsByCoordinates([coordinate])).toEqual([])
      visibleShippingEvents = [newer]
      expect(await getShippingOptionsByCoordinates([coordinate])).toEqual([])

      visibleShippingEvents = [conflictingA, conflictingB]
      expect(await getShippingOptionsByCoordinates([coordinate])).toEqual([])
      expect(cachedFrontiers[0]?.signedEvents).toHaveLength(2)

      visibleShippingEvents = [conflictingC, conflictingD]
      expect(await getShippingOptionsByCoordinates([coordinate])).toEqual([])
      expect(cachedFrontiers[0]?.signedEvents).toHaveLength(2)

      visibleShippingEvents = [conflictingC]
      expect(await getShippingOptionsByCoordinates([coordinate])).toEqual([])
      expect(cachedFrontiers[0]?.signedEvents).toHaveLength(2)
    } finally {
      __resetShippingTestOverrides()
      __resetRelayListTestOverrides()
    }
  }, 15_000)

  it("retains a newer shipping frontier in memory when durable persistence fails", async () => {
    const secretKey = generateSecretKey()
    const pubkey = getPublicKey(secretKey)
    const dTag = "field-notes-shipping-standard"
    const coordinate = `30406:${pubkey}:${dTag}`
    const makeShippingEvent = (createdAt: number, price: string) =>
      new NDKEvent(
        undefined,
        finalizeEvent(
          {
            kind: 30406,
            created_at: createdAt,
            content: "",
            tags: [
              ["d", dTag],
              ["title", "Standard Shipping"],
              ["price", price, "USD"],
              ["country", "US"],
              ["service", "standard"],
            ],
          },
          secretKey
        )
      )
    const older = makeShippingEvent(100, "1")
    const newer = makeShippingEvent(200, "2")
    let visibleShippingEvents = [newer]
    let failFrontierReads = false
    let failFrontierWrites = true
    let cachedFrontiers: CachedShippingOptionFrontier[] = []
    const exactDeletionQueries: string[][] = []

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
        if (filter["#e"]) {
          exactDeletionQueries.push([...filter["#e"]])
        }
        const events = filter.kinds?.includes(30406)
          ? visibleShippingEvents
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
      getCachedDeletionTombstones: async () => [],
      putCachedDeletionTombstones: async () => undefined,
      getCachedOptionFrontiers: async (coordinates) => {
        if (failFrontierReads) {
          throw new Error("transient IndexedDB read failure")
        }
        return cachedFrontiers.filter((row) =>
          coordinates.includes(row.coordinate)
        )
      },
      putCachedOptionFrontiers: async (rows) => {
        if (failFrontierWrites) {
          throw new Error("transient IndexedDB write failure")
        }
        for (const row of rows) {
          cachedFrontiers = [
            ...cachedFrontiers.filter(
              (current) => current.coordinate !== row.coordinate
            ),
            row,
          ]
        }
      },
    })

    try {
      await expect(
        getShippingOptionsByCoordinates([coordinate])
      ).rejects.toThrow("Fixed shipping option evidence could not be verified")
      expect(cachedFrontiers).toEqual([])

      visibleShippingEvents = [older]
      failFrontierWrites = false
      failFrontierReads = true
      await expect(
        getShippingOptionsByCoordinates([coordinate])
      ).rejects.toThrow("Fixed shipping option evidence could not be verified")
      expect(cachedFrontiers).toEqual([])

      failFrontierReads = false
      expect(await getShippingOptionsByCoordinates([coordinate])).toEqual([])
      expect(cachedFrontiers).toMatchObject([
        {
          coordinate,
          strongestCreatedAt: 200,
          signedEvents: [{ id: newer.id }],
        },
      ])
      expect(exactDeletionQueries).toContainEqual([older.id, newer.id].sort())
    } finally {
      __resetShippingTestOverrides()
      __resetRelayListTestOverrides()
    }
  }, 15_000)

  it("blocks an overlapping read after another call observes a stronger shipping frontier", async () => {
    const secretKey = generateSecretKey()
    const pubkey = getPublicKey(secretKey)
    const dTag = "field-notes-shipping-standard"
    const coordinate = `30406:${pubkey}:${dTag}`
    const makeShippingEvent = (createdAt: number, price: string) =>
      new NDKEvent(
        undefined,
        finalizeEvent(
          {
            kind: 30406,
            created_at: createdAt,
            content: "",
            tags: [
              ["d", dTag],
              ["title", "Standard Shipping"],
              ["price", price, "USD"],
              ["country", "US"],
              ["service", "standard"],
            ],
          },
          secretKey
        )
      )
    const firstRevision = makeShippingEvent(200, "2")
    const strongerRevision = makeShippingEvent(300, "3")
    let shippingReadCount = 0
    let frontierReadCount = 0
    let cachedFrontiers: CachedShippingOptionFrontier[] = []
    let signalFirstReadStarted = () => undefined
    let releaseFirstRead = () => undefined
    let signalStrongerWriteStarted = () => undefined
    let releaseStrongerWrite = () => undefined
    const firstReadStarted = new Promise<void>((resolve) => {
      signalFirstReadStarted = resolve
    })
    const firstReadRelease = new Promise<void>((resolve) => {
      releaseFirstRead = resolve
    })
    const strongerWriteStarted = new Promise<void>((resolve) => {
      signalStrongerWriteStarted = resolve
    })
    const strongerWriteRelease = new Promise<void>((resolve) => {
      releaseStrongerWrite = resolve
    })
    let firstCall: Promise<ParsedShippingOption[]> | undefined
    let strongerCall: Promise<ParsedShippingOption[]> | undefined

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
          ? [shippingReadCount++ === 0 ? firstRevision : strongerRevision]
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
      getCachedDeletionTombstones: async () => [],
      putCachedDeletionTombstones: async () => undefined,
      getCachedOptionFrontiers: async (coordinates) => {
        const snapshot = cachedFrontiers.filter((row) =>
          coordinates.includes(row.coordinate)
        )
        frontierReadCount += 1
        if (frontierReadCount === 1) {
          signalFirstReadStarted()
          await firstReadRelease
        }
        return snapshot
      },
      putCachedOptionFrontiers: async (rows) => {
        if (rows.some((row) => row.strongestCreatedAt === 300)) {
          signalStrongerWriteStarted()
          await strongerWriteRelease
        }
        for (const row of rows) {
          cachedFrontiers = [
            ...cachedFrontiers.filter(
              (current) => current.coordinate !== row.coordinate
            ),
            row,
          ]
        }
      },
    })

    try {
      firstCall = getShippingOptionsByCoordinates([coordinate])
      await firstReadStarted

      strongerCall = getShippingOptionsByCoordinates([coordinate])
      await strongerWriteStarted

      releaseFirstRead()
      expect(await firstCall).toEqual([])

      releaseStrongerWrite()
      expect(await strongerCall).toMatchObject([
        { eventId: strongerRevision.id, price: 3 },
      ])
    } finally {
      releaseFirstRead()
      releaseStrongerWrite()
      await Promise.allSettled(
        [firstCall, strongerCall].filter(
          (call): call is Promise<ParsedShippingOption[]> => call !== undefined
        )
      )
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
    let cachedFrontiers: CachedShippingOptionFrontier[] = []

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
      getCachedOptionFrontiers: async (coordinates) =>
        cachedFrontiers.filter((row) => coordinates.includes(row.coordinate)),
      putCachedOptionFrontiers: async (rows) => {
        for (const row of rows) {
          cachedFrontiers = [
            ...cachedFrontiers.filter(
              (current) => current.coordinate !== row.coordinate
            ),
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

const FALLBACK_EVENT_PREFIX = "conduit:shipping-tombstone-fallback:v1:event:"
const FALLBACK_PENDING_PREFIX =
  "conduit:shipping-tombstone-fallback:v1:pending:"

class MemoryFallbackStorage implements ShippingDeletionFallbackStorage {
  readonly entries = new Map<string, string>()
  failWrites = false
  failEventWriteAt: number | null = null
  removeFirstKeyDuringNextEnumeration = false
  private eventWriteCount = 0
  private enumerationMutationApplied = false

  get length(): number {
    return this.entries.size
  }

  key(index: number): string | null {
    const key = Array.from(this.entries.keys()).sort()[index] ?? null
    if (
      index === 0 &&
      key !== null &&
      this.removeFirstKeyDuringNextEnumeration &&
      !this.enumerationMutationApplied
    ) {
      this.enumerationMutationApplied = true
      this.entries.delete(key)
    }
    return key
  }

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error("fallback storage unavailable")
    if (key.startsWith(FALLBACK_EVENT_PREFIX)) {
      this.eventWriteCount += 1
      if (this.eventWriteCount === this.failEventWriteAt) {
        throw new Error("interrupted fallback event batch")
      }
    }
    this.entries.set(key, value)
  }

  removeItem(key: string): void {
    this.entries.delete(key)
  }
}

function createShippingReadHarness(
  target: "address" | "event",
  options: {
    includeSecondAddress?: boolean
    includeSecondDeletionEvent?: boolean
  } = {}
) {
  const secretKey = generateSecretKey()
  const pubkey = getPublicKey(secretKey)
  const dTag = `durable-${target}-shipping-standard`
  const coordinate = `30406:${pubkey}:${dTag}`
  const secondCoordinate = `30406:${pubkey}:${dTag}-second`
  const shippingEvent = new NDKEvent(
    undefined,
    finalizeEvent(
      {
        kind: 30406,
        created_at: 100,
        content: "",
        tags: [
          ["d", dTag],
          ["title", "Standard Shipping"],
          ["price", "5", "USD"],
          ["country", "US"],
          ["service", "standard"],
        ],
      },
      secretKey
    )
  )
  const secondShippingEvent = new NDKEvent(
    undefined,
    finalizeEvent(
      {
        kind: 30406,
        created_at: 100,
        content: "",
        tags: [
          ["d", `${dTag}-second`],
          ["title", "Second Standard Shipping"],
          ["price", "7", "USD"],
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
        // Exact event deletion is intentionally older: NIP-09 exact-id
        // evidence does not have an address-replacement freshness gate.
        created_at: target === "event" ? 90 : 110,
        content: "",
        tags:
          target === "address"
            ? [
                ["a", coordinate],
                ...(options.includeSecondAddress
                  ? [["a", secondCoordinate]]
                  : []),
              ]
            : [["e", shippingEvent.id]],
      },
      secretKey
    )
  )
  const secondDeletion = new NDKEvent(
    undefined,
    finalizeEvent(
      {
        kind: 5,
        created_at: 111,
        content: "",
        tags: [["a", secondCoordinate]],
      },
      secretKey
    )
  )
  const strongerAddressDeletion = new NDKEvent(
    undefined,
    finalizeEvent(
      {
        kind: 5,
        created_at: 120,
        content: "",
        tags: [["a", coordinate]],
      },
      secretKey
    )
  )
  const fallbackStorage = new MemoryFallbackStorage()
  let includeDeletion = true
  let failPrimaryWrites = true
  let ignorePrimaryWrites = false
  let deferredPrimaryWrite: Promise<void> | null = null
  let releaseDeferredPrimaryWrite: (() => void) | null = null
  let primaryWriteStarted: Promise<void> = Promise.resolve()
  let markPrimaryWriteStarted: (() => void) | null = null
  let cachedTombstones: CachedProductTombstone[] = []
  let cachedFrontiers: CachedShippingOptionFrontier[] = []

  const install = () => {
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
      fetchEventsFanoutDetailed: async (filter, fetchOptions) => {
        let events: NDKEvent[] = []
        if (filter.kinds?.includes(30406)) {
          const requestedDTags = new Set(filter["#d"] ?? [])
          events = [
            shippingEvent,
            ...(options.includeSecondDeletionEvent
              ? [secondShippingEvent]
              : []),
          ].filter((event) =>
            requestedDTags.has(
              event.tags.find((tag) => tag[0] === "d")?.[1] ?? ""
            )
          )
        } else if (
          includeDeletion &&
          ((target === "address" && filter["#a"]) ||
            (target === "event" && filter["#e"]))
        ) {
          events = [
            deletion,
            ...(options.includeSecondDeletionEvent ? [secondDeletion] : []),
          ]
        }
        return {
          events,
          relays: (fetchOptions?.relayUrls ?? []).map((relayUrl) => ({
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
        if (failPrimaryWrites) throw new Error("IndexedDB unavailable")
        if (ignorePrimaryWrites) return
        if (deferredPrimaryWrite) {
          const gate = deferredPrimaryWrite
          deferredPrimaryWrite = null
          markPrimaryWriteStarted?.()
          markPrimaryWriteStarted = null
          await gate
        }
        for (const row of rows) {
          cachedTombstones = [
            ...cachedTombstones.filter((current) => current.id !== row.id),
            row,
          ]
        }
      },
      getCachedOptionFrontiers: async (coordinates) =>
        cachedFrontiers.filter((row) => coordinates.includes(row.coordinate)),
      putCachedOptionFrontiers: async (rows) => {
        for (const row of rows) {
          cachedFrontiers = [
            ...cachedFrontiers.filter(
              (current) => current.coordinate !== row.coordinate
            ),
            row,
          ]
        }
      },
      deletionFallbackStorage: fallbackStorage,
    })
  }

  return {
    coordinate,
    coordinates: [
      coordinate,
      ...(options.includeSecondDeletionEvent ? [secondCoordinate] : []),
    ],
    secondCoordinate,
    deletion,
    fallbackStorage,
    install,
    omitDeletion: () => {
      includeDeletion = false
    },
    restorePrimaryWrites: () => {
      failPrimaryWrites = false
    },
    ignorePrimaryWrites: () => {
      ignorePrimaryWrites = true
    },
    deferNextPrimaryWrite: () => {
      primaryWriteStarted = new Promise<void>((resolve) => {
        markPrimaryWriteStarted = resolve
      })
      deferredPrimaryWrite = new Promise<void>((resolve) => {
        releaseDeferredPrimaryWrite = resolve
      })
    },
    waitForPrimaryWrite: () => primaryWriteStarted,
    releasePrimaryWrite: () => {
      releaseDeferredPrimaryWrite?.()
      releaseDeferredPrimaryWrite = null
    },
    seedStrongerAddressTombstone: () => {
      cachedTombstones = [
        {
          id: `shipping:a:${coordinate}`,
          pubkey,
          addressId: coordinate,
          deletedAt: strongerAddressDeletion.created_at!,
          deletionEventId: strongerAddressDeletion.id,
          signedEvent: strongerAddressDeletion.rawEvent(),
          sourceRelayUrls: [],
          observedLocally: false,
          cachedAt: 1,
        },
      ]
    },
    seedInvalidAddressTombstone: () => {
      cachedTombstones = [
        {
          id: `shipping:a:${coordinate}`,
          pubkey,
          addressId: coordinate,
          deletedAt: 999,
          deletionEventId: "f".repeat(64),
          sourceRelayUrls: [],
          observedLocally: false,
          cachedAt: 1,
        },
      ]
    },
    cachedTombstones: () => cachedTombstones,
  }
}

describe("fixed shipping deletion durable fallback", () => {
  for (const target of ["address", "event"] as const) {
    it(`retains a signed ${target} withdrawal across a fresh runtime`, async () => {
      const harness = createShippingReadHarness(target)
      harness.install()

      try {
        expect(
          await getShippingOptionsByCoordinates([harness.coordinate])
        ).toEqual([])
        expect(harness.cachedTombstones()).toEqual([])
        expect(
          harness.fallbackStorage.entries.has(
            `${FALLBACK_EVENT_PREFIX}${harness.deletion.id}`
          )
        ).toBe(true)

        // Simulate a browser restart: volatile protocol state is gone, while
        // the independent journal and primary IndexedDB variables remain.
        __resetShippingTestOverrides()
        __resetRelayListTestOverrides()
        harness.omitDeletion()
        harness.install()
        expect(
          await getShippingOptionsByCoordinates([harness.coordinate])
        ).toEqual([])
        expect(harness.fallbackStorage.length).toBe(1)

        // Once IndexedDB recovers, the next read verifies durable target
        // coverage before removing the journal entry.
        harness.restorePrimaryWrites()
        expect(
          await getShippingOptionsByCoordinates([harness.coordinate])
        ).toEqual([])
        expect(harness.cachedTombstones()).toHaveLength(1)
        expect(harness.fallbackStorage.length).toBe(0)

        __resetShippingTestOverrides()
        __resetRelayListTestOverrides()
        harness.install()
        expect(
          await getShippingOptionsByCoordinates([harness.coordinate])
        ).toEqual([])
      } finally {
        __resetShippingTestOverrides()
        __resetRelayListTestOverrides()
      }
    }, 15_000)
  }

  it("blocks fixed shipping when neither durable store can retain a withdrawal", async () => {
    const harness = createShippingReadHarness("address")
    harness.fallbackStorage.failWrites = true
    harness.install()

    try {
      await expect(
        getShippingOptionsByCoordinates([harness.coordinate])
      ).rejects.toThrow(
        "Fixed shipping deletion evidence could not be retained"
      )
      expect(harness.cachedTombstones()).toEqual([])
      expect(harness.fallbackStorage.length).toBe(0)
    } finally {
      __resetShippingTestOverrides()
      __resetRelayListTestOverrides()
    }
  })

  it("journals a withdrawal before an IndexedDB write can stall", async () => {
    const harness = createShippingReadHarness("address")
    harness.restorePrimaryWrites()
    harness.deferNextPrimaryWrite()
    harness.install()

    try {
      const pendingRead = getShippingOptionsByCoordinates([harness.coordinate])
      await harness.waitForPrimaryWrite()
      expect(
        harness.fallbackStorage.entries.has(
          `${FALLBACK_EVENT_PREFIX}${harness.deletion.id}`
        )
      ).toBe(true)

      // A fresh runtime can authorize from the journal while the original
      // IndexedDB request is still pending and has not cached any tombstone.
      __resetShippingTestOverrides()
      __resetRelayListTestOverrides()
      harness.omitDeletion()
      harness.ignorePrimaryWrites()
      harness.install()
      expect(
        await getShippingOptionsByCoordinates([harness.coordinate])
      ).toEqual([])
      expect(harness.fallbackStorage.length).toBe(1)

      harness.releasePrimaryWrite()
      await expect(pendingRead).resolves.toEqual([])
      expect(harness.fallbackStorage.length).toBe(0)
    } finally {
      harness.releasePrimaryWrite()
      __resetShippingTestOverrides()
      __resetRelayListTestOverrides()
    }
  })

  it("fails closed for malformed fallback evidence", async () => {
    const harness = createShippingReadHarness("address")
    harness.omitDeletion()
    harness.fallbackStorage.entries.set(
      `${FALLBACK_EVENT_PREFIX}${harness.deletion.id}`,
      "{truncated"
    )
    harness.install()

    try {
      await expect(
        getShippingOptionsByCoordinates([harness.coordinate])
      ).rejects.toThrow(
        "Fixed shipping deletion evidence could not be verified"
      )
    } finally {
      __resetShippingTestOverrides()
      __resetRelayListTestOverrides()
    }
  })

  it("fails closed when a valid journal event is stored under the wrong key", async () => {
    const harness = createShippingReadHarness("address")
    harness.omitDeletion()
    harness.fallbackStorage.entries.set(
      `${FALLBACK_EVENT_PREFIX}${"0".repeat(64)}`,
      JSON.stringify(harness.deletion.rawEvent())
    )
    harness.install()

    try {
      await expect(
        getShippingOptionsByCoordinates([harness.coordinate])
      ).rejects.toThrow(
        "Fixed shipping deletion evidence could not be verified"
      )
    } finally {
      __resetShippingTestOverrides()
      __resetRelayListTestOverrides()
    }
  })

  it("fails closed when fallback keys change during enumeration", async () => {
    const harness = createShippingReadHarness("address")
    harness.omitDeletion()
    harness.fallbackStorage.entries.set("a-unrelated-key", "unrelated")
    harness.fallbackStorage.entries.set(
      `${FALLBACK_EVENT_PREFIX}${harness.deletion.id}`,
      JSON.stringify(harness.deletion.rawEvent())
    )
    harness.fallbackStorage.removeFirstKeyDuringNextEnumeration = true
    harness.install()

    try {
      await expect(
        getShippingOptionsByCoordinates([harness.coordinate])
      ).rejects.toThrow(
        "Fixed shipping deletion evidence could not be verified"
      )
    } finally {
      __resetShippingTestOverrides()
      __resetRelayListTestOverrides()
    }
  })

  it("keeps the journal when primary write readback does not cover the target", async () => {
    const harness = createShippingReadHarness("address")
    harness.install()

    try {
      expect(
        await getShippingOptionsByCoordinates([harness.coordinate])
      ).toEqual([])
      __resetShippingTestOverrides()
      __resetRelayListTestOverrides()

      harness.omitDeletion()
      harness.restorePrimaryWrites()
      harness.ignorePrimaryWrites()
      harness.install()
      expect(
        await getShippingOptionsByCoordinates([harness.coordinate])
      ).toEqual([])
      expect(harness.cachedTombstones()).toEqual([])
      expect(harness.fallbackStorage.length).toBe(1)
    } finally {
      __resetShippingTestOverrides()
      __resetRelayListTestOverrides()
    }
  })

  it("prefers valid fallback evidence over a corrupt newer primary row", async () => {
    const harness = createShippingReadHarness("address")
    harness.install()

    try {
      expect(
        await getShippingOptionsByCoordinates([harness.coordinate])
      ).toEqual([])
      expect(harness.fallbackStorage.length).toBe(1)

      __resetShippingTestOverrides()
      __resetRelayListTestOverrides()
      harness.omitDeletion()
      harness.seedInvalidAddressTombstone()
      harness.install()

      expect(
        await getShippingOptionsByCoordinates([harness.coordinate])
      ).toEqual([])
      expect(harness.fallbackStorage.length).toBe(1)

      harness.restorePrimaryWrites()
      expect(
        await getShippingOptionsByCoordinates([harness.coordinate])
      ).toEqual([])
      expect(harness.cachedTombstones()[0]?.deletionEventId).toBe(
        harness.deletion.id
      )
      expect(harness.cachedTombstones()[0]?.signedEvent?.id).toBe(
        harness.deletion.id
      )
      expect(harness.fallbackStorage.length).toBe(0)
    } finally {
      __resetShippingTestOverrides()
      __resetRelayListTestOverrides()
    }
  })

  it("cleans the journal when a stronger primary address cutoff covers it", async () => {
    const harness = createShippingReadHarness("address")
    harness.install()

    try {
      expect(
        await getShippingOptionsByCoordinates([harness.coordinate])
      ).toEqual([])
      __resetShippingTestOverrides()
      __resetRelayListTestOverrides()

      harness.omitDeletion()
      harness.restorePrimaryWrites()
      harness.seedStrongerAddressTombstone()
      harness.install()
      expect(
        await getShippingOptionsByCoordinates([harness.coordinate])
      ).toEqual([])
      expect(harness.cachedTombstones()[0]?.deletedAt).toBe(120)
      expect(harness.fallbackStorage.length).toBe(0)
    } finally {
      __resetShippingTestOverrides()
      __resetRelayListTestOverrides()
    }
  })

  it("persists every target in a journal event before cleaning its key", async () => {
    const harness = createShippingReadHarness("address", {
      includeSecondAddress: true,
    })
    harness.install()

    try {
      expect(
        await getShippingOptionsByCoordinates([harness.coordinate])
      ).toEqual([])
      expect(harness.fallbackStorage.length).toBe(1)
      __resetShippingTestOverrides()
      __resetRelayListTestOverrides()

      harness.omitDeletion()
      harness.restorePrimaryWrites()
      harness.install()
      expect(
        await getShippingOptionsByCoordinates([harness.coordinate])
      ).toEqual([])
      expect(
        harness
          .cachedTombstones()
          .map((row) => row.addressId)
          .sort()
      ).toEqual([harness.coordinate, harness.secondCoordinate].sort())
      expect(harness.fallbackStorage.length).toBe(0)
    } finally {
      __resetShippingTestOverrides()
      __resetRelayListTestOverrides()
    }
  })

  it("survives a fresh runtime when the second event journal write fails", async () => {
    const harness = createShippingReadHarness("address", {
      includeSecondDeletionEvent: true,
    })
    harness.fallbackStorage.failEventWriteAt = 2
    harness.install()

    try {
      await expect(
        getShippingOptionsByCoordinates(harness.coordinates)
      ).rejects.toThrow(
        "Fixed shipping deletion evidence could not be retained"
      )
      expect(
        Array.from(harness.fallbackStorage.entries.keys()).some((key) =>
          key.startsWith(FALLBACK_PENDING_PREFIX)
        )
      ).toBe(true)

      __resetShippingTestOverrides()
      __resetRelayListTestOverrides()
      harness.omitDeletion()
      harness.install()
      expect(
        await getShippingOptionsByCoordinates(harness.coordinates)
      ).toEqual([])
    } finally {
      __resetShippingTestOverrides()
      __resetRelayListTestOverrides()
    }
  })
})
