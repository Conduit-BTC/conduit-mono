import { afterEach, describe, expect, it } from "bun:test"
import { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  __resetShippingTestOverrides,
  __setShippingTestOverrides,
  buildProductListingEventDraft,
  parseProductEvent,
  buildShippingPolicyEventDraft,
  fetchMerchantShippingPolicy,
  getMerchantShippingPolicyCoordinate,
  hasSameShippingPolicyQuote,
  parseShippingPolicy,
  previewShippingPolicy,
  quoteShippingPolicy,
  shippingAmountToMinor,
  shippingMinorToAmount,
  shippingPolicyQuoteSchema,
  publishMerchantShippingPolicy,
  withdrawMerchantShippingPolicy,
  parseShippingOptionEvent,
  resolveProductFulfillment,
  resolveCartShippingCost,
  selectLatestShippingOptions,
  orderSchema,
  type ShippingPolicy,
  type ShippingPolicyQuote,
  type SignedPublicNostrEvent,
  type CachedProductTombstone,
  type CachedShippingOptionFrontier,
  type FetchEventsFanoutOptions,
  type ProductSchema,
  type MerchantShippingPolicyReadResult,
} from "@conduit/core"
import type { publishWithPlanner } from "../packages/core/src/protocol/relay-publish"

const secret = generateSecretKey()
const merchant = getPublicKey(secret)
const coordinate = getMerchantShippingPolicyCoordinate(merchant)
const productId = `30402:${merchant}:one`
function signedProduct(currency = "USD"): SignedPublicNostrEvent {
  return finalizeEvent(
    {
      kind: 30402,
      created_at: 2,
      content: "Product",
      tags: [
        ["d", "one"],
        ["title", "One"],
        ["price", "20", currency],
        ["type", "simple", "physical"],
        ["weight", "200", "g"],
        ["shipping_option", coordinate],
      ],
    },
    secret
  )
}
const policy: ShippingPolicy = {
  version: 1,
  title: "Shipping",
  originCountry: "US",
  currency: "USD",
  weightAllowanceGrams: 100,
  handlingMinor: 50,
  domestic: {
    freeShippingThresholdMinor: 10_000,
    rules: [
      {
        country: "US",
        bands: [
          { maxWeightGrams: 500, priceMinor: 500 },
          { maxWeightGrams: 1000, priceMinor: 700 },
        ],
      },
      {
        country: "US",
        subdivision: "USCA",
        bands: [{ maxWeightGrams: 1000, priceMinor: 600 }],
      },
      {
        country: "US",
        postalPrefix: "94",
        bands: [{ maxWeightGrams: 1000, priceMinor: 800 }],
      },
      {
        country: "US",
        subdivision: "USCA",
        postalPrefix: "941",
        bands: [{ maxWeightGrams: 1000, priceMinor: 900 }],
      },
    ],
  },
  international: {
    rules: [
      { country: "CA", bands: [{ maxWeightGrams: 1000, priceMinor: 1200 }] },
    ],
  },
}
function signedPolicy(value = policy, created_at = 10): SignedPublicNostrEvent {
  return finalizeEvent(
    { ...buildShippingPolicyEventDraft({ policy: value }), created_at },
    secret
  )
}
function quote(
  value = policy,
  overrides: Record<string, unknown> = {}
): ShippingPolicyQuote {
  const event = signedPolicy(value)
  const result = quoteShippingPolicy({
    policy: value,
    policyCoordinate: coordinate,
    policyEventId: event.id,
    policyCreatedAt: event.created_at,
    merchantPubkey: merchant,
    policyEvent: event,
    items: [
      {
        productId,
        productEventId: signedProduct(value.currency).id,
        productCreatedAt: 2,
        productEvent: signedProduct(value.currency),
        quantity: 2,
        weightGrams: 200,
        currency: value.currency,
        subtotalMinor: 4000,
      },
    ],
    destination: { country: "US", subdivision: "NY", postalCode: "10001" },
    ...overrides,
  })
  if (result.status !== "quoted") throw new Error(result.status)
  return result.quote
}
function preview(overrides: Record<string, unknown> = {}) {
  return previewShippingPolicy({
    policy,
    items: [
      { weightGrams: 200, quantity: 2, currency: "USD", subtotalMinor: 4000 },
    ],
    destination: { country: "US", subdivision: "NY", postalCode: "10001" },
    ...overrides,
  })
}
function cacheOverrides() {
  const frontiers = new Map<string, CachedShippingOptionFrontier>()
  const tombstones = new Map<string, CachedProductTombstone>()
  __setShippingTestOverrides({
    getCachedOptionFrontiers: async (coordinates) =>
      coordinates.flatMap((id) =>
        frontiers.has(id) ? [frontiers.get(id)!] : []
      ),
    putCachedOptionFrontiers: async (rows) => {
      for (const row of rows) frontiers.set(row.coordinate, row)
    },
    getCachedDeletionTombstones: async (ids) =>
      ids.flatMap((id) => (tombstones.has(id) ? [tombstones.get(id)!] : [])),
    putCachedDeletionTombstones: async (rows) => {
      for (const row of rows) tombstones.set(row.id, row)
    },
    deletionFallbackStorage: null,
    getRelayLists: async () =>
      new Map([
        [
          merchant,
          {
            pubkey: merchant,
            readRelayUrls: ["wss://shipping.example"],
            writeRelayUrls: ["wss://shipping.example"],
            eventCreatedAt: 1,
            cachedAt: 1,
          },
        ],
      ]),
  })
}
function fanoutResult(
  events: SignedPublicNostrEvent[],
  options: FetchEventsFanoutOptions,
  complete = true
) {
  return {
    events: events.map((event) => new NDKEvent(undefined, event)),
    eventsVerified: true,
    eventSourceRelayUrls: {},
    relays: (options.relayUrls ?? []).map((relayUrl) => ({
      relayUrl,
      status: complete ? ("success" as const) : ("error" as const),
      eventCount: events.length,
    })),
  }
}
afterEach(() => __resetShippingTestOverrides())

describe("shipping policy arithmetic", () => {
  it("normalizes identifiers and rejects duplicate rules after normalization", () => {
    const normalized = parseShippingPolicy({
      ...policy,
      originCountry: " us ",
      domestic: {
        rules: [
          {
            country: "us",
            subdivision: "us-ca",
            postalPrefix: "94 1-",
            bands: [{ maxWeightGrams: 1000, priceMinor: 10 }],
          },
        ],
      },
    })
    expect(normalized.domestic!.rules[0]).toMatchObject({
      country: "US",
      subdivision: "USCA",
      postalPrefix: "941",
    })
    expect(() =>
      parseShippingPolicy({
        ...policy,
        domestic: {
          rules: [normalized.domestic!.rules[0], normalized.domestic!.rules[0]],
        },
      })
    ).toThrow()
  })
  it("requires increasing positive safe-integer weight bounds and nonnegative money", () => {
    for (const bands of [
      [{ maxWeightGrams: 0, priceMinor: 1 }],
      [{ maxWeightGrams: 1.1, priceMinor: 1 }],
      [{ maxWeightGrams: 100, priceMinor: -1 }],
      [
        { maxWeightGrams: 100, priceMinor: 1 },
        { maxWeightGrams: 100, priceMinor: 2 },
      ],
    ])
      expect(() =>
        parseShippingPolicy({
          ...policy,
          domestic: { rules: [{ country: "US", bands }] },
        })
      ).toThrow()
    expect(() =>
      parseShippingPolicy({ ...policy, domestic: null, international: null })
    ).toThrow()
  })
  it("keeps domestic and international countries in their correct table", () => {
    expect(() =>
      parseShippingPolicy({ ...policy, domestic: policy.international })
    ).toThrow()
    expect(() =>
      parseShippingPolicy({ ...policy, international: policy.domestic })
    ).toThrow()
  })
  it("charges the inclusive band and handling once for combined weight", () => {
    expect(preview()).toMatchObject({
      status: "quoted",
      combinedWeightGrams: 500,
      amountMinor: 550,
      freeShippingApplied: false,
    })
    expect(
      preview({
        items: [
          {
            weightGrams: 201,
            quantity: 2,
            currency: "USD",
            subtotalMinor: 4000,
          },
        ],
      })
    ).toMatchObject({
      status: "quoted",
      combinedWeightGrams: 502,
      amountMinor: 750,
    })
    expect(
      preview({
        items: [
          {
            weightGrams: 400,
            quantity: 1,
            currency: "USD",
            subtotalMinor: 2000,
          },
          {
            weightGrams: 100,
            quantity: 1,
            currency: "USD",
            subtotalMinor: 2000,
          },
        ],
      })
    ).toMatchObject({
      status: "quoted",
      combinedWeightGrams: 600,
      amountMinor: 750,
    })
  })
  it("uses longest postal prefix before subdivision before country", () => {
    expect(
      preview({
        destination: {
          country: "us",
          subdivision: "CA",
          postalCode: "94 1-09",
        },
      })
    ).toMatchObject({
      status: "quoted",
      amountMinor: 950,
      destination: { country: "US", subdivision: "USCA", postalCode: "94109" },
    })
    expect(
      preview({
        destination: { country: "US", subdivision: "CA", postalCode: "94000" },
      })
    ).toMatchObject({ amountMinor: 850 })
    expect(
      preview({
        destination: { country: "US", subdivision: "CA", postalCode: "90000" },
      })
    ).toMatchObject({ amountMinor: 650 })
    expect(
      preview({ destination: { country: "CA", postalCode: "K1A" } })
    ).toMatchObject({ amountMinor: 1250 })
  })
  it("applies the shipped subtotal threshold only after destination and weight eligibility", () => {
    expect(
      preview({
        items: [
          {
            weightGrams: 200,
            quantity: 2,
            currency: "USD",
            subtotalMinor: 10_000,
          },
        ],
      })
    ).toMatchObject({
      status: "quoted",
      amountMinor: 0,
      freeShippingApplied: true,
    })
    expect(
      preview({
        destination: { country: "GB" },
        items: [
          {
            weightGrams: 200,
            quantity: 2,
            currency: "USD",
            subtotalMinor: 10_000,
          },
        ],
      })
    ).toEqual({ status: "unsupported_destination" })
    expect(
      preview({
        items: [
          {
            weightGrams: 1000,
            quantity: 2,
            currency: "USD",
            subtotalMinor: 10_000,
          },
        ],
      })
    ).toEqual({ status: "overweight" })
    expect(
      preview({
        items: [{ quantity: 2, currency: "USD", subtotalMinor: 10_000 }],
      })
    ).toEqual({ status: "missing_weight" })
  })
  it("excludes digital and pickup value and weight from shipment", () => {
    expect(
      preview({
        items: [
          {
            weightGrams: 200,
            quantity: 2,
            currency: "USD",
            subtotalMinor: 4000,
          },
          {
            quantity: 1,
            currency: "SATS",
            subtotalMinor: 100_000,
            format: "digital",
          },
          {
            quantity: 1,
            currency: "SATS",
            subtotalMinor: 100_000,
            fulfillmentType: "pickup",
          },
        ],
      })
    ).toMatchObject({
      amountMinor: 550,
      shippedSubtotalMinor: 4000,
      combinedWeightGrams: 500,
    })
    expect(
      preview({
        items: [
          { quantity: 1, currency: "USD", subtotalMinor: 0, format: "digital" },
        ],
      })
    ).toEqual({ status: "not_required" })
  })
  it("never substitutes zero for missing, fractional, unsafe, or excess weight", () => {
    for (const weightGrams of [
      undefined,
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ])
      expect(
        preview({
          items: [
            { weightGrams, quantity: 1, currency: "USD", subtotalMinor: 4000 },
          ],
        })
      ).toEqual({ status: "missing_weight" })
    expect(
      preview({
        items: [
          {
            weightGrams: Number.MAX_SAFE_INTEGER,
            quantity: 2,
            currency: "USD",
            subtotalMinor: 4000,
          },
        ],
      })
    ).toEqual({ status: "invalid_items" })
  })
  it("rejects invalid quantities and foreign currency instead of performing FX", () => {
    expect(
      preview({
        items: [
          {
            weightGrams: 100,
            quantity: 0,
            currency: "USD",
            subtotalMinor: 100,
          },
        ],
      })
    ).toEqual({ status: "invalid_items" })
    expect(
      preview({
        items: [
          {
            weightGrams: 100,
            quantity: 1,
            currency: "EUR",
            subtotalMinor: 100,
          },
        ],
      })
    ).toEqual({ status: "currency_mismatch" })
  })
  it("converts fiat, sats, and tiny BTC amounts with currency precision", () => {
    expect(shippingAmountToMinor("1.23", "USD")).toBe(123)
    expect(shippingAmountToMinor(0.00000001, "BTC")).toBe(1)
    expect(shippingAmountToMinor("10", "SATS")).toBe(10)
    expect(shippingAmountToMinor("10", "JPY")).toBe(10)
    expect(shippingMinorToAmount(1, "BTC")).toBe(0.00000001)
    expect(() => shippingAmountToMinor("1.234", "USD")).toThrow()
    expect(() => shippingAmountToMinor("1.1", "SATS")).toThrow()
  })
})

describe("shipping signed terms and product wire tags", () => {
  it("uses human content, canonical summary tags, and an explicit versioned tag", () => {
    const draft = buildShippingPolicyEventDraft({ policy })
    expect(draft.content.startsWith("{")).toBe(false)
    expect(draft.tags).toContainEqual(["d", "conduit-shipping-policy"])
    expect(draft.tags).toContainEqual(["price", "5.00", "USD"])
    const event = signedPolicy()
    const parsed = parseShippingOptionEvent(new NDKEvent(undefined, event))!
    expect(parsed.shippingPolicy).toEqual(policy)
    expect(parsed.signedEvent).toEqual(JSON.parse(JSON.stringify(event)))
    // The old fixed-only supported-tag set rejects this marker.
    expect(parsed.launchUnsupportedTags).toContain("conduit_shipping_table")
  })
  it("rejects missing, duplicated, unsupported, and contradictory extension metadata", () => {
    const event = signedPolicy()
    for (const tags of [
      event.tags.map((tag) =>
        tag[0] === "price" ? ["price", "0", "USD"] : tag
      ),
      [...event.tags, ["conduit_shipping_table", "1", JSON.stringify(policy)]],
      event.tags.map((tag) =>
        tag[0] === "conduit_shipping_table"
          ? ["conduit_shipping_table", "2", JSON.stringify(policy)]
          : tag
      ),
      [...event.tags, ["restrict", "US", "94"]],
    ])
      expect(
        parseShippingOptionEvent(
          new NDKEvent(undefined, finalizeEvent({ ...event, tags }, secret))
        )
      ).toBeNull()
  })
  it("retains exact policy and product revisions and rejects forged result fields", () => {
    const snapshot = quote()
    expect(shippingPolicyQuoteSchema.safeParse(snapshot).success).toBe(true)
    expect(
      hasSameShippingPolicyQuote(
        snapshot,
        shippingPolicyQuoteSchema.parse(snapshot)
      )
    ).toBe(true)
    for (const changed of [
      { amountMinor: 0 },
      { freeShippingApplied: true },
      { combinedWeightGrams: 100 },
      { bandPriceMinor: 0 },
      { policyEventId: "0".repeat(64) },
      { items: [{ ...snapshot.items[0]!, quantity: 1 }] },
    ])
      expect(
        shippingPolicyQuoteSchema.safeParse({ ...snapshot, ...changed }).success
      ).toBe(false)
    expect(
      quoteShippingPolicy({
        policy,
        policyCoordinate: coordinate,
        policyEventId: snapshot.policyEventId,
        policyCreatedAt: 10,
        merchantPubkey: merchant,
        policyEvent: { ...snapshot.policyEvent, sig: "0".repeat(128) },
        items: snapshot.items,
        destination: snapshot.destination,
      })
    ).toEqual({ status: "invalid_policy" })
  })
  it("round-trips weight and advisory dimensions and ignores malformed duplicated weight", () => {
    const product: ProductSchema = {
      id: productId,
      pubkey: merchant,
      title: "One",
      price: 20,
      currency: "USD",
      type: "simple",
      format: "physical",
      specifications: [],
      shippingOptionId: coordinate,
      shippingWeightGrams: 200,
      shippingDimensionsCm: { length: 10, width: 20, height: 30 },
      visibility: "public",
      images: [],
      tags: [],
      publicZapEnabled: true,
      zapMessagePolicy: "generic_only",
      publicZapPolicyKnown: true,
      createdAt: 2000,
      updatedAt: 2000,
    }
    const draft = buildProductListingEventDraft({ product, dTag: "one" })
    expect(draft.tags).toContainEqual(["weight", "200", "g"])
    expect(draft.tags).toContainEqual(["dim", "10x20x30", "cm"])
    const event = finalizeEvent({ ...draft, created_at: 2 }, secret)
    expect(parseProductEvent(new NDKEvent(undefined, event))).toMatchObject({
      sourceEventId: event.id,
      shippingWeightGrams: 200,
      shippingDimensionsCm: product.shippingDimensionsCm,
    })
    expect(
      parseProductEvent(
        new NDKEvent(
          undefined,
          finalizeEvent(
            { ...event, tags: [...event.tags, ["weight", "500", "g"]] },
            secret
          )
        )
      )?.shippingWeightGrams
    ).toBeUndefined()
    expect(
      resolveProductFulfillment(product, [
        parseShippingOptionEvent(new NDKEvent(undefined, signedPolicy()))!,
      ])
    ).toMatchObject({ intent: "weight_table", status: "ready" })
  })
  it("adds allocated line shipping once and treats missing allocation as manual", () => {
    const snapshot = quote()
    expect(
      resolveCartShippingCost([
        {
          productId,
          quantity: 2,
          shippingPolicyQuote: snapshot,
          shippingAllocatedCostSats: 550,
        },
      ])
    ).toMatchObject({ totalSats: 550, status: "priced" })
    expect(
      resolveCartShippingCost([
        { productId, quantity: 2, shippingPolicyQuote: snapshot },
      ])
    ).toMatchObject({ totalSats: 0, status: "manual" })
  })
  it("binds immutable quote groups to order items, destination, and totals", () => {
    const snapshot = quote()
    const order = {
      id: "order",
      merchantPubkey: merchant,
      buyerPubkey: "2".repeat(64),
      items: [
        {
          productId,
          format: "physical",
          quantity: 2,
          priceAtPurchase: 1000,
          currency: "SATS",
          sourcePrice: {
            amount: 20,
            currency: "USD",
            normalizedCurrency: "USD",
          },
          shippingOptionId: coordinate,
          shippingPolicyQuote: snapshot,
          shippingAllocatedCostSats: 550,
        },
      ],
      subtotal: 2000,
      currency: "SATS",
      shippingCostSats: 550,
      shippingAddress: {
        name: "Buyer",
        street: "1 Test",
        city: "New York",
        state: "NY",
        postalCode: "10001",
        country: "US",
      },
      createdAt: 20,
    }
    expect(orderSchema.safeParse(order).success).toBe(true)
    expect(
      orderSchema.safeParse({
        ...order,
        shippingAddress: { ...order.shippingAddress, country: "CA" },
      }).success
    ).toBe(false)
    expect(
      orderSchema.safeParse({ ...order, shippingCostSats: 0 }).success
    ).toBe(false)
    expect(
      orderSchema.safeParse({
        ...order,
        items: [{ ...order.items[0], quantity: 1 }],
      }).success
    ).toBe(false)
  })
})

describe("shipping policy read evidence", () => {
  it("retains signed positive policy through partial omission and reports coverage", async () => {
    cacheOverrides()
    let events = [signedPolicy()]
    let complete = true
    __setShippingTestOverrides({
      fetchEventsFanoutDetailed: async (filter, options = {}) =>
        fanoutResult(
          filter.kinds?.includes(30406) ? events : [],
          options,
          complete
        ),
    })
    expect(await fetchMerchantShippingPolicy(merchant)).toMatchObject({
      state: "found",
      coverageComplete: true,
      source: "relay",
    })
    events = []
    complete = false
    expect(await fetchMerchantShippingPolicy(merchant)).toMatchObject({
      state: "found",
      coverageComplete: false,
      source: "retained",
      revision: { eventId: signedPolicy().id },
    })
  })
  it("distinguishes complete empty from unavailable empty", async () => {
    cacheOverrides()
    __setShippingTestOverrides({
      fetchEventsFanoutDetailed: async (_filter, options = {}) =>
        fanoutResult([], options),
    })
    expect(await fetchMerchantShippingPolicy(merchant)).toEqual({
      state: "not_found",
      coverageComplete: true,
    })
    __setShippingTestOverrides({
      fetchEventsFanoutDetailed: async (_filter, options = {}) =>
        fanoutResult([], options, false),
    })
    expect(await fetchMerchantShippingPolicy(merchant)).toMatchObject({
      state: "unavailable",
      reason: "relay_read",
      coverageComplete: false,
    })
  })
  it("never exposes older valid policy behind a newer malformed revision", async () => {
    cacheOverrides()
    const newer = finalizeEvent(
      {
        ...buildShippingPolicyEventDraft({ policy }),
        created_at: 11,
        tags: [
          ["d", "conduit-shipping-policy"],
          ["conduit_shipping_table", "1", "bad"],
        ],
      },
      secret
    )
    let events = [signedPolicy(), newer]
    __setShippingTestOverrides({
      fetchEventsFanoutDetailed: async (filter, options = {}) =>
        fanoutResult(filter.kinds?.includes(30406) ? events : [], options),
    })
    expect(await fetchMerchantShippingPolicy(merchant)).toMatchObject({
      state: "unavailable",
      reason: "invalid_policy",
      revision: { eventId: newer.id },
    })
    events = [signedPolicy()]
    expect(await fetchMerchantShippingPolicy(merchant)).toMatchObject({
      state: "unavailable",
      reason: "invalid_policy",
      revision: { eventId: newer.id },
    })
  })
  it("preserves signed same-author withdrawals across later omission", async () => {
    cacheOverrides()
    const event = signedPolicy()
    let deletions = [
      finalizeEvent(
        {
          kind: 5,
          created_at: 11,
          content: "",
          tags: [
            ["a", coordinate],
            ["e", event.id],
          ],
        },
        secret
      ),
    ]
    __setShippingTestOverrides({
      fetchEventsFanoutDetailed: async (filter, options = {}) =>
        fanoutResult(
          filter.kinds?.includes(30406) ? [event] : deletions,
          options
        ),
    })
    expect(await fetchMerchantShippingPolicy(merchant)).toMatchObject({
      state: "withdrawn",
      revision: { eventId: deletions[0]!.id, createdAt: 11 },
    })
    deletions = []
    expect(await fetchMerchantShippingPolicy(merchant)).toMatchObject({
      state: "withdrawn",
    })
  })
  it("retains coordinate withdrawal without any option event across fresh runtime and failed reads", async () => {
    const tombstones = new Map<string, CachedProductTombstone>()
    const deletion = finalizeEvent(
      { kind: 5, created_at: 11, content: "", tags: [["a", coordinate]] },
      secret
    )
    const install = (withDeletion: boolean, fail = false) => {
      cacheOverrides()
      __setShippingTestOverrides({
        getCachedDeletionTombstones: async (ids) =>
          ids.flatMap((id) =>
            tombstones.has(id) ? [tombstones.get(id)!] : []
          ),
        putCachedDeletionTombstones: async (rows) => {
          for (const row of rows) tombstones.set(row.id, row)
        },
        fetchEventsFanoutDetailed: async (filter, options = {}) => {
          if (fail) throw new Error("Relay unavailable")
          return fanoutResult(
            withDeletion && filter.kinds?.includes(5) ? [deletion] : [],
            options
          )
        },
      })
    }
    install(true)
    expect(await fetchMerchantShippingPolicy(merchant)).toMatchObject({
      state: "withdrawn",
      revision: { eventId: deletion.id, createdAt: 11 },
    })
    __resetShippingTestOverrides()
    install(false)
    expect(await fetchMerchantShippingPolicy(merchant)).toMatchObject({
      state: "withdrawn",
      coverageComplete: true,
    })
    __resetShippingTestOverrides()
    install(false, true)
    expect(await fetchMerchantShippingPolicy(merchant)).toMatchObject({
      state: "withdrawn",
      coverageComplete: false,
    })
  })

  it("uses NIP-01 lowest id tie and ignores foreign-author deletion", () => {
    const first = signedPolicy(policy, 10)
    const second = signedPolicy({ ...policy, handlingMinor: 0 }, 10)
    const expected = [first, second].sort((a, b) =>
      a.id.localeCompare(b.id)
    )[0]!
    const foreign = finalizeEvent(
      { kind: 5, created_at: 11, content: "", tags: [["a", coordinate]] },
      generateSecretKey()
    )
    expect(
      selectLatestShippingOptions([first, second], [foreign])[0]?.eventId
    ).toBe(expected.id)
  })
})

describe("shipping policy publication", () => {
  it("checks current revision, signer authority and ACK before returning signed terms", async () => {
    cacheOverrides()
    const signer = NDKPrivateKeySigner.generate()
    const pubkey = (await signer.user()).pubkey
    let published: NDKEvent | undefined
    const publishEvent = (async (event: NDKEvent) => {
      published = event
      return { successfulRelayUrls: ["wss://shipping.example"] }
    }) as typeof publishWithPlanner
    const revision = await publishMerchantShippingPolicy({
      pubkey,
      policy,
      dependencies: {
        signer,
        fetchPolicy: async () => ({
          state: "not_found",
          coverageComplete: true,
        }),
        publishEvent,
        now: () => 20_000,
      },
    })
    expect(published?.kind).toBe(30406)
    expect(revision).toEqual({ eventId: published!.id, createdAt: 20 })
    expect(parseShippingOptionEvent(published!)?.shippingPolicy).toEqual(policy)
  })
  it("rejects revision changes, incomplete reads, wrong signer, and zero ACK", async () => {
    cacheOverrides()
    const signer = NDKPrivateKeySigner.generate()
    const pubkey = (await signer.user()).pubkey
    const foreignEvent = signedPolicy()
    const found: MerchantShippingPolicyReadResult = {
      state: "found",
      policy,
      revision: { eventId: foreignEvent.id, createdAt: 10 },
      signedEvent: foreignEvent,
      source: "relay",
      coverageComplete: true,
    }
    const publishEvent = (async () => ({
      successfulRelayUrls: [],
    })) as typeof publishWithPlanner
    for (const current of [found, { ...found, coverageComplete: false }])
      await expect(
        publishMerchantShippingPolicy({
          pubkey,
          policy,
          dependencies: {
            signer,
            fetchPolicy: async () => current,
            publishEvent,
          },
        })
      ).rejects.toThrow()
    await expect(
      publishMerchantShippingPolicy({
        pubkey: merchant,
        policy,
        dependencies: { signer },
      })
    ).rejects.toThrow()
    await expect(
      publishMerchantShippingPolicy({
        pubkey,
        policy,
        dependencies: {
          signer,
          fetchPolicy: async () => ({
            state: "not_found",
            coverageComplete: true,
          }),
          publishEvent,
        },
      })
    ).rejects.toThrow("No relay accepted")
  })
  it("publishes replacement strictly after an accepted withdrawal cutoff", async () => {
    cacheOverrides()
    const signer = NDKPrivateKeySigner.generate()
    const pubkey = (await signer.user()).pubkey
    const deletion = new NDKEvent(undefined, {
      kind: 5,
      pubkey,
      created_at: 30,
      content: "",
      tags: [["a", getMerchantShippingPolicyCoordinate(pubkey)]],
    })
    await deletion.sign(signer)
    const revision = { eventId: deletion.id, createdAt: 30 }
    let published: NDKEvent | undefined
    await publishMerchantShippingPolicy({
      pubkey,
      policy,
      acceptedRevision: revision,
      dependencies: {
        signer,
        now: () => 10_000,
        fetchPolicy: async () => ({
          state: "withdrawn",
          revision,
          coverageComplete: true,
        }),
        publishEvent: (async (event: NDKEvent) => {
          published = event
          return { successfulRelayUrls: ["wss://shipping.example"] }
        }) as typeof publishWithPlanner,
      },
    })
    expect(published?.created_at).toBe(31)
    expect(
      selectLatestShippingOptions([published!], [deletion])[0]?.eventId
    ).toBe(published!.id)
  })

  it("fences auth changes before signing or relay publication", async () => {
    const signer = NDKPrivateKeySigner.generate()
    const pubkey = (await signer.user()).pubkey
    let active = true
    await expect(
      publishMerchantShippingPolicy({
        pubkey,
        policy,
        dependencies: {
          signer,
          shouldContinue: () => active,
          fetchPolicy: async () => {
            active = false
            return { state: "not_found", coverageComplete: true }
          },
        },
      })
    ).rejects.toThrow("session changed")
  })
  it("withdraws the exact event and address using a later signed deletion", async () => {
    cacheOverrides()
    const signer = NDKPrivateKeySigner.generate()
    const pubkey = (await signer.user()).pubkey
    const event = new NDKEvent(undefined, {
      ...buildShippingPolicyEventDraft({ policy }),
      pubkey,
      created_at: 10,
    })
    await event.sign(signer)
    const revision = { eventId: event.id, createdAt: 10 }
    let deletion: NDKEvent | undefined
    await withdrawMerchantShippingPolicy({
      pubkey,
      acceptedRevision: revision,
      dependencies: {
        signer,
        now: () => 10_000,
        fetchPolicy: async () => ({
          state: "found",
          policy,
          revision,
          signedEvent: event.rawEvent() as SignedPublicNostrEvent,
          source: "relay",
          coverageComplete: true,
        }),
        publishEvent: (async (published: NDKEvent) => {
          deletion = published
          return { successfulRelayUrls: ["wss://shipping.example"] }
        }) as typeof publishWithPlanner,
      },
    })
    expect(deletion?.kind).toBe(5)
    expect(deletion?.created_at).toBe(11)
    expect(deletion?.tags).toContainEqual([
      "a",
      getMerchantShippingPolicyCoordinate(pubkey),
    ])
    expect(deletion?.tags).toContainEqual(["e", event.id])
  })
})
