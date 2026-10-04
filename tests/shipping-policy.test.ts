import { afterEach, describe, expect, it } from "bun:test"
import {
  clearTestAccountSigner,
  setTestAccountSigner,
} from "./helpers/plain-signer"
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
  shippingMoneyToMinorUnits,
  shippingMinorUnitsToAmount,
  convertShippingMinor,
  type ShippingPolicyV2,
  type BtcUsdRateQuote,
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
        ["price", currency === "MSATS" ? "20000" : "20", currency],
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
        subtotalMinor:
          shippingMoneyToMinorUnits(
            value.currency === "MSATS" ? 20000 : 20,
            value.currency
          ) * 2,
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
afterEach(() => {
  __resetShippingTestOverrides()
  clearTestAccountSigner()
})

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
  it("matches supported address region names and ISO codes to the same rate", () => {
    for (const [country, name, code] of [
      ["US", "California", "CA"],
      ["CA", "British Columbia", "BC"],
      ["AU", "New South Wales", "NSW"],
      ["NZ", "Canterbury", "CAN"],
    ]) {
      const tablePolicy: ShippingPolicyV2 = {
        version: 2,
        title: "Regional rates",
        originCountry: country!,
        currency: "SATS",
        domestic: {
          rules: [
            {
              country: country!,
              bands: [{ maxWeightGrams: 1000, priceMinor: 500 }],
            },
            {
              country: country!,
              subdivision: `${country}${code}`,
              bands: [{ maxWeightGrams: 1000, priceMinor: 2000 }],
            },
          ],
        },
        international: null,
      }
      for (const subdivision of [
        name,
        code,
        `${country}-${code}`,
        `${country}${code}`,
      ]) {
        expect(
          previewShippingPolicy({
            policy: tablePolicy,
            items: [
              {
                weightGrams: 100,
                quantity: 1,
                currency: "SATS",
                subtotalMinor: 100,
              },
            ],
            destination: { country: country!, subdivision },
          })
        ).toMatchObject({
          status: "quoted",
          amountSats: 2000,
          destination: { subdivision: `${country}${code}` },
        })
      }
    }
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
    expect(shippingMoneyToMinorUnits("1.23", "USD")).toBe(123)
    expect(shippingMoneyToMinorUnits(0.00000001, "BTC")).toBe(1)
    expect(shippingMoneyToMinorUnits("10", "SATS")).toBe(10)
    expect(shippingMoneyToMinorUnits("10", "JPY")).toBe(10)
    expect(shippingMinorUnitsToAmount(1, "BTC")).toBe(0.00000001)
    expect(() => shippingMoneyToMinorUnits("1.234", "USD")).toThrow()
    expect(() => shippingMoneyToMinorUnits("1.1", "SATS")).toThrow()
  })
})

describe("shipping signed terms and product wire tags", () => {
  it("does not offer a fixed amount to readers that ignore table extensions", () => {
    const event = signedPolicy()
    const standardNames = new Set([
      "d",
      "title",
      "price",
      "country",
      "service",
      "client",
    ])
    // A standard-only reader ignores unknown tags rather than rejecting them.
    const standardView = parseShippingOptionEvent({
      ...event,
      tags: event.tags.filter((tag) => standardNames.has(tag[0]!)),
    } as never)
    expect(standardView).toBeNull()
    const product = parseProductEvent(new NDKEvent(undefined, signedProduct()))!
    expect(
      resolveProductFulfillment(product, standardView ? [standardView] : [])
    ).toMatchObject({
      status: "order_first",
      reason: "unresolved",
    })
    const awareView = parseShippingOptionEvent(new NDKEvent(undefined, event))!
    expect(resolveProductFulfillment(product, [awareView])).toMatchObject({
      intent: "weight_table",
      status: "ready",
    })
    expect(quote().amountMinor).toBe(550)
    expect(event.tags.some((tag) => tag[0] === "price")).toBe(false)
  })
  it("uses human content and an explicit table capability without a fixed price", () => {
    const draft = buildShippingPolicyEventDraft({ policy })
    expect(draft.content.startsWith("{")).toBe(false)
    expect(draft.tags).toContainEqual(["d", "conduit-shipping-policy"])
    expect(draft.tags.some((tag) => tag[0] === "price")).toBe(false)
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
      [...event.tags, ["price", "0", "USD"]],
      [...event.tags, ["price", "5.00", "USD"], ["price", "5.00", "USD"]],
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
  it("preserves historical signed table revisions with the old price summary", () => {
    const version2: ShippingPolicyV2 = {
      version: 2,
      title: policy.title,
      originCountry: policy.originCountry,
      currency: policy.currency,
      domestic: policy.domestic,
      international: policy.international,
    }
    for (const value of [policy, version2]) {
      const draft = buildShippingPolicyEventDraft({ policy: value })
      const event = finalizeEvent(
        {
          ...draft,
          tags: [...draft.tags, ["price", "5.00", "USD"]],
          created_at: 10,
        },
        secret
      )
      const parsed = parseShippingOptionEvent(new NDKEvent(undefined, event))!
      expect(parsed.shippingPolicy).toEqual(parseShippingPolicy(value))
      const historical = quote(value, {
        policyEvent: event,
        policyEventId: event.id,
        rateInput: 50_000,
      })
      expect(shippingPolicyQuoteSchema.safeParse(historical).success).toBe(true)
      expect(historical.policyEvent).toEqual(JSON.parse(JSON.stringify(event)))
    }
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
    const snapshot = quote(policy, { rateInput: 1_000_000 })
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
    for (const currency of ["BTC", "MSATS"]) {
      const native = quote({
        ...policy,
        currency,
        handlingMinor: 0,
        domestic: {
          rules: [
            {
              country: "US",
              bands: [{ maxWeightGrams: 1000, priceMinor: 1000 }],
            },
          ],
        },
      })
      const sats = convertShippingMinor(native.amountMinor, currency, "SATS")
      const nativeOrder = {
        ...order,
        shippingCostSats: sats,
        items: [
          {
            ...order.items[0],
            sourcePrice: {
              amount: currency === "MSATS" ? 20000 : 20,
              currency,
              normalizedCurrency: currency,
            },
            shippingPolicyQuote: native,
            shippingAllocatedCostSats: sats,
          },
        ],
      }
      expect(orderSchema.safeParse(nativeOrder).success).toBe(true)
      expect(
        orderSchema.safeParse({
          ...nativeOrder,
          shippingCostSats: sats + 1,
          items: [
            { ...nativeOrder.items[0], shippingAllocatedCostSats: sats + 1 },
          ],
        }).success
      ).toBe(false)
    }

    expect(
      orderSchema.safeParse({
        ...order,
        shippingCostSats: 1,
        items: [{ ...order.items[0], shippingAllocatedCostSats: 1 }],
      }).success
    ).toBe(false)
    const legacy = quote()
    expect(shippingPolicyQuoteSchema.safeParse(legacy).success).toBe(true)
    expect(
      orderSchema.safeParse({
        ...order,
        items: [{ ...order.items[0], shippingPolicyQuote: legacy }],
      }).success
    ).toBe(false)
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
      fetchSignedEventsFanoutDetailed: async (filter, options = {}) =>
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
      fetchSignedEventsFanoutDetailed: async (_filter, options = {}) =>
        fanoutResult([], options),
    })
    expect(await fetchMerchantShippingPolicy(merchant)).toEqual({
      state: "not_found",
      coverageComplete: true,
    })
    __setShippingTestOverrides({
      fetchSignedEventsFanoutDetailed: async (_filter, options = {}) =>
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
      fetchSignedEventsFanoutDetailed: async (filter, options = {}) =>
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
      fetchSignedEventsFanoutDetailed: async (filter, options = {}) =>
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
        fetchSignedEventsFanoutDetailed: async (filter, options = {}) => {
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

  it("rejects same-timestamp conflicts while accepting duplicate evidence and ignoring foreign-author deletion", () => {
    const first = signedPolicy(policy, 10)
    const second = signedPolicy({ ...policy, handlingMinor: 0 }, 10)
    const foreign = finalizeEvent(
      { kind: 5, created_at: 11, content: "", tags: [["a", coordinate]] },
      generateSecretKey()
    )
    expect(selectLatestShippingOptions([first, second], [foreign])).toEqual([])
    expect(selectLatestShippingOptions([second, first])).toEqual([])
    expect(
      selectLatestShippingOptions([first, first], [foreign])[0]?.eventId
    ).toBe(first.id)
  })
})

describe("shipping policy publication", () => {
  for (const reason of ["conflicting", "invalid_policy"] as const) {
    it(`replaces a reviewed complete ${reason} revision strictly later but rejects incomplete or changed evidence before signing`, async () => {
      cacheOverrides()
      const signer = setTestAccountSigner(new NDKPrivateKeySigner(secret))
      const events = [
        signedPolicy(policy, 10),
        reason === "conflicting"
          ? signedPolicy({ ...policy, handlingMinor: 0 }, 10)
          : finalizeEvent(
              {
                ...buildShippingPolicyEventDraft({ policy }),
                created_at: 11,
                tags: [
                  ["d", "conduit-shipping-policy"],
                  ["conduit_shipping_table", "2", "bad"],
                ],
              },
              secret
            ),
      ]
      let complete = true
      __setShippingTestOverrides({
        fetchSignedEventsFanoutDetailed: async (filter, options = {}) =>
          fanoutResult(
            filter.kinds?.includes(30406) ? events : [],
            options,
            complete
          ),
      })
      const conflict = await fetchMerchantShippingPolicy(merchant)
      expect(conflict).toMatchObject({
        state: "unavailable",
        reason,
        coverageComplete: true,
      })
      if (conflict.state !== "unavailable" || !conflict.revision)
        throw new Error("Expected conflict revision")
      let signCount = 0
      const sign = signer.signEvent.bind(signer)
      signer.signEvent = async (draft) => {
        signCount++
        return sign(draft)
      }
      const replace = () =>
        publishMerchantShippingPolicy({
          pubkey: merchant,
          policy,
          acceptedRevision: conflict.revision,
          dependencies: {
            signer,
            now: () => 1000,
            fetchPolicy: (pubkey) => fetchMerchantShippingPolicy(pubkey),
            publishEvent: (async (event: SignedPublicNostrEvent) => {
              events.push(event)
              return { successfulRelayUrls: ["wss://shipping.example"] }
            }) as typeof publishWithPlanner,
          },
        })
      complete = false
      await expect(replace()).rejects.toThrow("could not be read completely")
      expect(signCount).toBe(0)
      complete = true
      const replacement = await replace()
      expect(replacement.createdAt).toBe(reason === "conflicting" ? 11 : 12)
      expect(signCount).toBe(1)
      expect(await fetchMerchantShippingPolicy(merchant)).toMatchObject({
        state: "found",
        policy,
        revision: replacement,
        source: "relay",
      })
      await expect(replace()).rejects.toThrow("Shipping changed")
      expect(signCount).toBe(1)
    })
  }
  it("uses the active account signer and checks current revision and ACK before returning signed terms", async () => {
    cacheOverrides()
    const legacySigner = NDKPrivateKeySigner.generate()
    const signer = setTestAccountSigner(legacySigner)
    const pubkey = await signer.getPublicKey()
    let published: SignedPublicNostrEvent | undefined
    const publishEvent = (async (event: SignedPublicNostrEvent) => {
      published = event
      return { successfulRelayUrls: ["wss://shipping.example"] }
    }) as typeof publishWithPlanner
    const revision = await publishMerchantShippingPolicy({
      pubkey,
      policy,
      dependencies: {
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
    const legacySigner = NDKPrivateKeySigner.generate()
    const signer = setTestAccountSigner(legacySigner)
    const pubkey = await signer.getPublicKey()
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
    const legacySigner = NDKPrivateKeySigner.generate()
    const signer = setTestAccountSigner(legacySigner)
    const pubkey = await signer.getPublicKey()
    const deletion = new NDKEvent(undefined, {
      kind: 5,
      pubkey,
      created_at: 30,
      content: "",
      tags: [["a", getMerchantShippingPolicyCoordinate(pubkey)]],
    })
    await deletion.sign(legacySigner)
    const revision = { eventId: deletion.id, createdAt: 30 }
    let published: SignedPublicNostrEvent | undefined
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
        publishEvent: (async (event: SignedPublicNostrEvent) => {
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
    const legacySigner = NDKPrivateKeySigner.generate()
    const signer = setTestAccountSigner(legacySigner)
    const pubkey = await signer.getPublicKey()
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
    const legacySigner = NDKPrivateKeySigner.generate()
    const signer = setTestAccountSigner(legacySigner)
    const pubkey = await signer.getPublicKey()
    const event = new NDKEvent(undefined, {
      ...buildShippingPolicyEventDraft({ policy }),
      pubkey,
      created_at: 10,
    })
    await event.sign(legacySigner)
    const revision = { eventId: event.id, createdAt: 10 }
    let deletion: SignedPublicNostrEvent | undefined
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
        publishEvent: (async (published: SignedPublicNostrEvent) => {
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

describe("shipping policy v2 signed adjustments and currency snapshots", () => {
  const v2: ShippingPolicyV2 = {
    version: 2,
    title: "Shipping",
    originCountry: "US",
    currency: "USD",
    domestic: {
      rules: [
        { country: "US", bands: [{ maxWeightGrams: 1000, priceMinor: 500 }] },
      ],
    },
    international: null,
  }
  const rates: BtcUsdRateQuote = {
    rate: 50_000,
    fetchedAt: 1,
    source: "env",
    fiatUsdRates: { EUR: 0.5, JPY: 0.01 },
    fiatSource: "env",
  }
  function adjustedItem(
    d: string,
    currency: string,
    amount: number,
    quantity: number,
    allowance: number,
    handlingAmount: number
  ) {
    const handling = {
      amount: handlingAmount,
      currency,
      normalizedCurrency: currency,
    }
    const draft = buildProductListingEventDraft({
      product: {
        title: d,
        price: amount,
        currency,
        type: "simple",
        format: "physical",
        specifications: [],
        images: [],
        tags: [],
        shippingOptionId: coordinate,
        shippingWeightGrams: 200,
        shippingWeightAllowanceGrams: allowance,
        shippingHandling: handling,
      } as ProductSchema,
      dTag: d,
    })
    const event = finalizeEvent({ ...draft, created_at: 2 }, secret)
    return {
      productId: `30402:${merchant}:${d}`,
      productEventId: event.id,
      productCreatedAt: 2,
      productEvent: event,
      quantity,
      weightGrams: 200,
      currency,
      subtotalMinor: shippingMoneyToMinorUnits(amount, currency) * quantity,
      shippingWeightAllowanceGrams: allowance,
      shippingHandling: handling,
    }
  }
  function v2Quote(
    value = v2,
    rateInput: BtcUsdRateQuote | number | null = rates,
    items = [
      adjustedItem("eu", "EUR", 10, 3, 50, 0.01),
      adjustedItem("sat", "SATS", 1000, 2, 0, 1),
    ]
  ) {
    const event = signedPolicy(value)
    return quoteShippingPolicy({
      policy: value,
      policyCoordinate: coordinate,
      policyEventId: event.id,
      policyCreatedAt: event.created_at,
      merchantPubkey: merchant,
      policyEvent: event,
      items,
      destination: { country: "US", postalCode: "10001" },
      rateInput,
    })
  }
  it("emits v2 detection and rejects legacy buffers on v2", () => {
    const draft = buildShippingPolicyEventDraft({ policy: v2 })
    expect(
      draft.tags.find((tag) => tag[0] === "conduit_shipping_table")?.[1]
    ).toBe("2")
    expect(
      parseShippingOptionEvent({ ...signedPolicy(v2) } as never)?.shippingPolicy
        ?.version
    ).toBe(2)
    expect(() => parseShippingPolicy({ ...v2, handlingMinor: 0 })).toThrow()
    const unsupported = structuredClone(draft)
    unsupported.tags.find((tag) => tag[0] === "conduit_shipping_table")![1] =
      "3"
    expect(
      parseShippingOptionEvent({
        ...unsupported,
        id: "f".repeat(64),
        pubkey: merchant,
        created_at: 10,
      } as never)
    ).toBeNull()
  })
  it("round-trips explicit per-product adjustment metadata and refuses malformed or foreign-currency terms", () => {
    const item = adjustedItem("one", "EUR", 10, 1, 50, 0.01)
    const parsed = parseProductEvent(
      new NDKEvent(undefined, item.productEvent)
    )!
    expect(parsed).toMatchObject({
      shippingWeightAllowanceGrams: 50,
      shippingHandling: {
        amount: 0.01,
        currency: "EUR",
        normalizedCurrency: "EUR",
      },
    })
    for (const tag of [
      ["conduit_shipping_adjustments", "2", "{}"],
      [
        "conduit_shipping_adjustments",
        "1",
        JSON.stringify({
          handling: { amount: 1, currency: "USD", normalizedCurrency: "USD" },
        }),
      ],
    ]) {
      const body = structuredClone(item.productEvent)
      body.tags = body.tags.filter(
        (tag) => tag[0] !== "conduit_shipping_adjustments"
      )
      body.tags.push(tag)
      const event = finalizeEvent(body, secret)
      expect(
        parseProductEvent(new NDKEvent(undefined, event))
          ?.shippingAdjustmentsMalformed
      ).toBe(true)
      expect(
        v2Quote(v2, rates, [
          { ...item, productEvent: event, productEventId: event.id },
        ])
      ).toEqual({ status: "invalid_items" })
    }
    const duplicate = finalizeEvent(
      {
        ...item.productEvent,
        tags: [
          ...item.productEvent.tags,
          item.productEvent.tags.find(
            (tag) => tag[0] === "conduit_shipping_adjustments"
          )!,
        ],
      },
      secret
    )
    expect(
      parseProductEvent(new NDKEvent(undefined, duplicate))
        ?.shippingAdjustmentsMalformed
    ).toBe(true)
    expect(() =>
      buildProductListingEventDraft({
        product: {
          ...parsed,
          shippingHandling: {
            amount: 1,
            currency: "USD",
            normalizedCurrency: "USD",
          },
        },
        dTag: "one",
      })
    ).toThrow()
  })
  it("multiplies per-product weight and handling by quantity then converts each line once", () => {
    // 3 × (200+50) + 2 × 200 = 1150; use a matching bound.
    const value = {
      ...v2,
      domestic: {
        rules: [
          { country: "US", bands: [{ maxWeightGrams: 1150, priceMinor: 500 }] },
        ],
      },
    }
    const result = v2Quote(value)
    expect(result.status).toBe("quoted")
    if (result.status !== "quoted" || result.quote.version !== 2)
      throw new Error(result.status)
    expect(result.quote).toMatchObject({
      version: 2,
      combinedWeightGrams: 1150,
      shippedSubtotalMinor: 0,
      handlingMinor: 2,
      amountMinor: 502,
      amountSats: 10040,
      pricingRate: rates,
      items: [
        {
          currency: "EUR",
          subtotalMinor: 3000,
          convertedSubtotalMinor: 0,
          convertedHandlingMinor: 2,
        },
        {
          currency: "SATS",
          subtotalMinor: 2000,
          convertedSubtotalMinor: 0,
          convertedHandlingMinor: 0,
        },
      ],
    })
    expect(shippingPolicyQuoteSchema.safeParse(result.quote).success).toBe(true)
    const historical = {
      ...result.quote,
      shippedSubtotalMinor: 1600,
      items: result.quote.items.map((item, index) => ({
        ...item,
        convertedSubtotalMinor: index === 0 ? 1500 : 100,
      })),
    }
    expect(shippingPolicyQuoteSchema.safeParse(historical).success).toBe(true)
    expect(
      shippingPolicyQuoteSchema.safeParse({
        ...historical,
        shippedSubtotalMinor: 1,
      }).success
    ).toBe(false)
    for (const forged of [
      { ...result.quote, amountSats: 10041 },
      { ...result.quote, pricingRate: { ...rates, rate: 25_000 } },
      {
        ...result.quote,
        items: result.quote.items.map((line, index) =>
          index ? line : { ...line, subtotalMinor: 3001 }
        ),
      },
    ])
      expect(shippingPolicyQuoteSchema.safeParse(forged).success).toBe(false)
  })
  it("uses converted shipped subtotal at inclusive free threshold and waives all handling", () => {
    const value = {
      ...v2,
      domestic: {
        freeShippingThresholdMinor: 1600,
        rules: [
          { country: "US", bands: [{ maxWeightGrams: 1150, priceMinor: 500 }] },
        ],
      },
    }
    expect(v2Quote(value)).toMatchObject({
      status: "quoted",
      quote: {
        freeShippingApplied: true,
        shippedSubtotalMinor: 1600,
        handlingMinor: 2,
        amountMinor: 0,
        amountSats: 0,
      },
    })
    expect(
      v2Quote({
        ...value,
        domestic: { ...value.domestic, freeShippingThresholdMinor: 1601 },
      })
    ).toMatchObject({
      status: "quoted",
      quote: { freeShippingApplied: false, amountMinor: 502 },
    })
    expect(
      v2Quote({
        ...value,
        domestic: {
          ...value.domestic,
          rules: [
            {
              country: "US",
              bands: [{ maxWeightGrams: 1149, priceMinor: 500 }],
            },
          ],
        },
      })
    ).toEqual({ status: "overweight" })
  })
  it("requires captured exchange rates, preserves old snapshots and fails unavailable conversions", () => {
    const one = [adjustedItem("eu", "EUR", 10, 1, 50, 0.01)]
    expect(v2Quote(v2, null, one)).toEqual({ status: "rate_required" })
    expect(
      previewShippingPolicy({
        policy: v2,
        items: [
          {
            quantity: 1,
            weightGrams: 200,
            currency: "USD",
            subtotalMinor: 2000,
          },
        ],
        destination: { country: "US" },
      })
    ).toMatchObject({
      status: "quoted",
      amountMinor: 500,
      amountSats: undefined,
    })
    expect(
      v2Quote(v2, null, [adjustedItem("usd", "USD", 20, 1, 0, 1)])
    ).toEqual({ status: "rate_required" })
    expect(v2Quote(v2, 50_000, one)).toEqual({ status: "rate_required" })
    expect(v2Quote(v2, { ...rates, fiatUsdRates: {} }, one)).toEqual({
      status: "rate_required",
    })
    expect(
      v2Quote(v2, rates, [{ ...one[0]!, shippingWeightAllowanceGrams: 51 }])
    ).toEqual({ status: "invalid_items" })
    const original = v2Quote(v2, rates, one)
    if (original.status !== "quoted") throw new Error(original.status)
    expect(shippingPolicyQuoteSchema.parse(original.quote)).toEqual(
      original.quote
    )
    expect(v2Quote(v2, { ...rates, rate: 100_000 }, one)).toMatchObject({
      status: "quoted",
      quote: { amountSats: 5010 },
    })
    expect(quote()).toMatchObject({
      version: 1,
      combinedWeightGrams: 500,
      amountMinor: 550,
    })
    expect(preview({ items: one })).toEqual({ status: "currency_mismatch" })
    expect(
      preview({
        items: [
          {
            quantity: 1,
            weightGrams: 200,
            currency: "USD",
            subtotalMinor: 2000,
            shippingWeightAllowanceGrams: 0,
          },
        ],
      })
    ).toEqual({ status: "invalid_items" })
  })
  it("rounds decimal rates half up without intermediate sats rounding and omits unnecessary rate snapshots", () => {
    expect(convertShippingMinor(1, "EUR", "USD", rates)).toBe(1)
    expect(convertShippingMinor(3, "EUR", "USD", rates)).toBe(2)
    expect(convertShippingMinor(500, "MSATS", "SATS")).toBe(1)
    expect(convertShippingMinor(1, "BTC", "SATS")).toBe(1)
    expect(convertShippingMinor(1, "SATS", "USD", 500_000)).toBe(1)
    expect(convertShippingMinor(1, "USD", "JPY", rates)).toBe(1)
    const native = { ...v2, currency: "SATS" }
    const result = v2Quote(native, rates, [
      adjustedItem("sat", "SATS", 1000, 1, 0, 7),
    ])
    expect(result).toMatchObject({
      status: "quoted",
      quote: { amountMinor: 507, amountSats: 507, pricingRate: null },
    })
  })
  it("binds mixed-currency order source terms and the exact converted group allocation", () => {
    const result = v2Quote(v2, rates, [
      adjustedItem("eu", "EUR", 10, 1, 50, 0.01),
    ])
    if (result.status !== "quoted" || result.quote.version !== 2)
      throw new Error(result.status)
    const line = result.quote.items[0]!
    const payload = {
      id: "mixed",
      merchantPubkey: merchant,
      buyerPubkey: "b".repeat(64),
      items: [
        {
          productId: line.productId,
          quantity: 1,
          priceAtPurchase: 10000,
          currency: "SATS",
          sourcePrice: {
            amount: 10,
            currency: "EUR",
            normalizedCurrency: "EUR",
          },
          format: "physical",
          shippingOptionId: coordinate,
          shippingPolicyQuote: result.quote,
          shippingAllocatedCostSats: result.quote.amountSats,
        },
      ],
      subtotal: 10000,
      currency: "SATS",
      shippingCostSats: result.quote.amountSats,
      shippingAddress: {
        name: "Buyer",
        street: "1 Test",
        city: "City",
        country: "US",
        postalCode: "10001",
      },
      createdAt: 1,
    }
    expect(orderSchema.safeParse(payload).success).toBe(true)
    expect(
      orderSchema.safeParse({
        ...payload,
        shippingCostSats: result.quote.amountSats + 1,
        items: [
          {
            ...payload.items[0],
            shippingAllocatedCostSats: result.quote.amountSats + 1,
          },
        ],
      }).success
    ).toBe(false)
    expect(
      orderSchema.safeParse({
        ...payload,
        items: [
          {
            ...payload.items[0],
            sourcePrice: {
              amount: 10,
              currency: "USD",
              normalizedCurrency: "USD",
            },
          },
        ],
      }).success
    ).toBe(false)
  })
})
