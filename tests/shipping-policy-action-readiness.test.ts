import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  __resetShippingTestOverrides,
  __setShippingTestOverrides,
  admitPublicEvent,
  buildShippingPolicyEventDraft,
  buildProductListingEventDraft,
  fetchMerchantShippingPolicy,
  getMerchantShippingPolicyCoordinate,
  getShippingOptionsByCoordinates,
  parseProductEvent,
  shippingPolicyQuoteSchema,
  type CachedShippingOptionFrontier,
  type Product,
  type ShippingPolicy,
} from "@conduit/core"
import {
  setTestAccountSigner,
  removeTestAccountSigner,
} from "./helpers/plain-signer"
import { authorizeCurrentCheckoutItems } from "../apps/market/src/lib/checkout-authorization"
import { createCartItemFromProduct } from "../apps/market/src/lib/cart-model"
import {
  getCartShippingOptionsAvailable,
  prepareCartFulfillment,
} from "../apps/market/src/lib/cart-shipping-options"
import {
  prepareProductPublicationListings,
  applyProductFulfillmentIntentForPublication,
  signAndPublishProductWriteBundle,
} from "../apps/merchant/src/lib/product-publishing"

const secret = generateSecretKey()
const merchant = getPublicKey(secret)
const coordinate = getMerchantShippingPolicyCoordinate(merchant)
const destination = { country: "US", postalCode: "98101" }
const policy: ShippingPolicy = {
  version: 2,
  title: "Rates",
  originCountry: "US",
  currency: "SATS",
  domestic: {
    rules: [
      { country: "US", bands: [{ maxWeightGrams: 1000, priceMinor: 100 }] },
    ],
  },
  international: null,
}
const policyEvent = (created_at = 1, terms: ShippingPolicy = policy) =>
  finalizeEvent(
    {
      ...buildShippingPolicyEventDraft({ policy: terms }),
      created_at,
    },
    secret
  )
const event = finalizeEvent(
  {
    kind: 30402,
    created_at: 2,
    content: "Synthetic listing",
    tags: [
      ["d", "one"],
      ["title", "One"],
      ["price", "1000", "SATS"],
      ["type", "simple", "physical"],
      ["weight", "250", "g"],
      ["shipping_option", coordinate],
    ],
  },
  secret
)
async function admittedProduct(signed: typeof event) {
  const result = await admitPublicEvent(signed)
  if (result.status !== "verified") throw new Error("Invalid product fixture")
  return parseProductEvent(result.event)
}
const product = await admittedProduct(event)
const raw = { ...createCartItemFromProduct(product), quantity: 1 }
const listing = {
  product,
  dTag: "one",
  fulfillmentIntent: {
    kind: "weight_table" as const,
    policyCoordinate: coordinate,
    policyEventId: policyEvent().id,
  },
}

function reader(frontiers = new Map<string, CachedShippingOptionFrontier>()) {
  let observedPolicyEvents = [policyEvent()]
  let mode:
    | "live"
    | "unavailable"
    | "partial_empty"
    | "complete_empty"
    | "saturated_live"
    | "saturated_rejected"
    | "partial_live"
    | "deletion_saturated"
    | "deletion_unavailable"
    | "older"
    | "withdrawn" = "live"
  __setShippingTestOverrides({
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
    getCachedOptionFrontiers: async (coordinates) =>
      coordinates.flatMap((id) =>
        frontiers.has(id) ? [frontiers.get(id)!] : []
      ),
    putCachedOptionFrontiers: async (rows) => {
      for (const row of rows) frontiers.set(row.coordinate, row)
    },
    getCachedDeletionTombstones: async () => [],
    putCachedDeletionTombstones: async () => undefined,
    deletionFallbackStorage: null,
    fetchSignedEventsFanoutDetailed: async (filter, options = {}) => {
      if (mode === "unavailable") throw new Error("Synthetic relay outage")
      const events = filter.kinds?.includes(30406)
        ? mode === "partial_empty" ||
          mode === "complete_empty" ||
          mode === "withdrawn"
          ? []
          : mode === "older"
            ? [policyEvent(0)]
            : observedPolicyEvents
        : mode === "withdrawn" && filter["#a"]
          ? [
              finalizeEvent(
                {
                  kind: 5,
                  created_at: 3,
                  content: "",
                  tags: [
                    ["a", coordinate],
                    ["k", "30406"],
                  ],
                },
                secret
              ),
            ]
          : []
      return {
        events: events.map((event) => new NDKEvent(undefined, event)),
        eventSourceRelayUrls: {},
        relays: (options.relayUrls ?? []).map((relayUrl, index) => ({
          relayUrl,
          status:
            (mode === "deletion_unavailable" &&
              !filter.kinds?.includes(30406)) ||
            (mode.startsWith("partial") && index !== 0)
              ? ("error" as const)
              : ("success" as const),
          eventCount:
            (mode === "saturated_live" && filter.kinds?.includes(30406)) ||
            (mode === "deletion_saturated" && !filter.kinds?.includes(30406))
              ? filter.limit!
              : events.length,
          rejectedEventCount:
            mode === "saturated_rejected" && filter.kinds?.includes(30406)
              ? filter.limit! - events.length
              : 0,
        })),
      }
    },
  })
  return {
    frontiers,
    setEvents: (events: typeof observedPolicyEvents) => {
      observedPolicyEvents = events
    },
    setMode: (next: typeof mode) => {
      mode = next
    },
    read: () => getShippingOptionsByCoordinates([coordinate]),
  }
}

const resolveProductFulfillment = async (current: Product) => ({
  status: "standard" as const,
  type: "shipping" as const,
  product: current,
})
afterEach(() => __resetShippingTestOverrides())

describe("current policy evidence at commerce action gates", () => {
  for (const type of ["simple", "variation"] as const) {
    for (const adjustments of [
      [["conduit_shipping_adjustments", "1", "{"]],
      [
        ["conduit_shipping_adjustments", "1", '{"weightAllowanceGrams":50}'],
        ["conduit_shipping_adjustments", "1", '{"weightAllowanceGrams":50}'],
      ],
    ]) {
      it(`blocks malformed ${type} adjustments before any family signing (${adjustments.length} tags)`, async () => {
        const source = reader()
        const malformed = finalizeEvent(
          {
            ...event,
            tags: [
              ...event.tags.filter(([name]) => name !== "type"),
              ["type", type, "physical"],
              ...(type === "variation"
                ? [
                    ["a", `30402:${merchant}:parent`],
                    ["spec", "Size", "Small"],
                  ]
                : []),
              ...adjustments,
            ],
          },
          secret
        )
        const baseline = await admittedProduct(malformed)
        expect(baseline.shippingAdjustmentsMalformed).toBe(true)
        expect(
          prepareCartFulfillment(
            [{ ...createCartItemFromProduct(baseline), quantity: 1 }],
            await source.read(),
            destination
          ).items[0]!.shippingPolicyQuote
        ).toBeUndefined()
        const lease = setTestAccountSigner(new NDKPrivateKeySigner(secret))
        const sign = spyOn(lease, "signEvent").mockImplementation(async () => {
          throw new Error("Unexpected product signing")
        })
        let localWrites = 0
        try {
          await expect(
            signAndPublishProductWriteBundle(
              {
                merchantPubkey: merchant,
                listings: [
                  {
                    ...listing,
                    product: { ...product, id: `30402:${merchant}:two` },
                    dTag: "two",
                  },
                  {
                    product: { ...baseline, title: "Title-only edit" },
                    dTag: "one",
                    fulfillmentIntent: { kind: "preserve_existing", baseline },
                  },
                ],
                onSignedLocal: async () => {
                  localWrites++
                },
              },
              {
                getShippingOptions: source.read,
                getEventMarketPickups: async () => [],
              }
            )
          ).rejects.toThrow("repair or remove")
          expect(sign).not.toHaveBeenCalled()
          expect(localWrites).toBe(0)
          expect(() =>
            buildProductListingEventDraft({ product: baseline, dTag: "one" })
          ).toThrow("repair or remove")
        } finally {
          sign.mockRestore()
          removeTestAccountSigner(lease)
        }
      })
    }
  }
  const legacyPolicy: ShippingPolicy = {
    ...policy,
    version: 1,
    weightAllowanceGrams: 0,
    handlingMinor: 0,
  }
  const incompatibleLegacyTerms = [
    { name: "different currency", currency: "USD" },
    {
      name: "different signed price currency",
      sourcePrice: { amount: 10, currency: "USD", normalizedCurrency: "USD" },
    },
    { name: "packing allowance", shippingWeightAllowanceGrams: 50 },
    {
      name: "explicit zero packing allowance",
      shippingWeightAllowanceGrams: 0,
    },
    {
      name: "handling charge",
      shippingHandling: {
        amount: 25,
        currency: "SATS",
        normalizedCurrency: "SATS",
      },
    },
    {
      name: "explicit zero handling",
      shippingHandling: {
        amount: 0,
        currency: "SATS",
        normalizedCurrency: "SATS",
      },
    },
  ]
  for (const changes of incompatibleLegacyTerms) {
    it(`blocks legacy v1 ${changes.name} before signing new or preserved table listings`, async () => {
      const source = reader()
      const legacyEvent = policyEvent(1, legacyPolicy)
      source.setEvents([legacyEvent])
      const { name: _name, ...fields } = changes
      const incompatible = { ...product, sourcePrice: undefined, ...fields }
      const signed = finalizeEvent(
        {
          ...buildProductListingEventDraft({
            product: incompatible,
            dTag: "one",
          }),
          created_at: 2,
        },
        secret
      )
      const parsed = await admittedProduct(signed)
      expect(
        prepareCartFulfillment(
          [{ ...createCartItemFromProduct(parsed), quantity: 1 }],
          await source.read(),
          destination
        ).items[0]!.shippingPolicyQuote
      ).toBeUndefined()
      const lease = setTestAccountSigner(new NDKPrivateKeySigner(secret))
      const sign = spyOn(lease, "signEvent").mockImplementation(async () => {
        throw new Error("Unexpected product signing")
      })
      let localWrites = 0
      try {
        for (const intent of [
          { ...listing.fulfillmentIntent, policyEventId: legacyEvent.id },
          { kind: "preserve_existing" as const, baseline: parsed },
        ]) {
          await expect(
            signAndPublishProductWriteBundle(
              {
                merchantPubkey: merchant,
                listings: [
                  {
                    product: incompatible,
                    dTag: "one",
                    fulfillmentIntent: intent,
                  },
                ],
                onSignedLocal: async () => {
                  localWrites++
                },
              },
              {
                getShippingOptions: source.read,
                getEventMarketPickups: async () => [],
              }
            )
          ).rejects.toThrow("Save Shipping to upgrade your rates")
        }
        expect(sign).not.toHaveBeenCalled()
        expect(localWrites).toBe(0)
      } finally {
        sign.mockRestore()
        removeTestAccountSigner(lease)
      }
    })
  }
  it("publishes automatically quoteable compatible v1 and adjusted mixed-currency v2 terms", async () => {
    for (const terms of [legacyPolicy, policy]) {
      const source = reader()
      const current = policyEvent(terms.version, terms)
      source.setEvents([current])
      const candidate =
        terms.version === 1
          ? product
          : {
              ...product,
              currency: "MSATS",
              sourcePrice: undefined,
              shippingWeightAllowanceGrams: 50,
              shippingHandling: {
                amount: 25000,
                currency: "MSATS",
                normalizedCurrency: "MSATS",
              },
            }
      const prepared = await prepareProductPublicationListings(
        [
          {
            product: candidate,
            dTag: "one",
            fulfillmentIntent: {
              ...listing.fulfillmentIntent,
              policyEventId: current.id,
            },
          },
        ],
        { merchantPubkey: merchant },
        {
          getShippingOptions: source.read,
          getEventMarketPickups: async () => [],
        }
      )
      const target = prepared[0]!
      const signed = finalizeEvent(
        {
          ...buildProductListingEventDraft({
            product: applyProductFulfillmentIntentForPublication({
              product: target.product,
              merchantPubkey: merchant,
              productDTag: target.dTag,
              intent: target.fulfillmentIntent,
            }),
            dTag: target.dTag,
          }),
          created_at: 2,
        },
        secret
      )
      const parsed = await admittedProduct(signed)
      const items = [{ ...createCartItemFromProduct(parsed), quantity: 1 }]
      const reviewed = prepareCartFulfillment(
        items,
        await source.read(),
        destination
      ).items
      expect(reviewed[0]!.shippingPolicyQuote).toMatchObject({
        version: terms.version,
        amountSats: terms.version === 1 ? 100 : 125,
      })
      await expect(
        authorizeCurrentCheckoutItems({
          mode: "direct_payment",
          rawItems: items,
          reviewedItems: reviewed,
          refreshedProducts: [parsed],
          destination,
          readShippingOptions: source.read,
          resolveProductFulfillment,
          authorizePickupHandlers: async () => {},
        })
      ).resolves.toBeDefined()
    }
  })
  for (const mode of ["live", "partial_live"] as const) {
    it(`blocks conflicting policy revisions through ${mode}, subset reads and restart until a newer revision`, async () => {
      let source = reader()
      const first = policyEvent()
      const otherTerms: ShippingPolicy = {
        ...policy,
        domestic: {
          rules: [
            {
              country: "US",
              bands: [{ maxWeightGrams: 1000, priceMinor: 900 }],
            },
          ],
        },
      }
      const second = policyEvent(1, otherTerms)
      const reviewed = prepareCartFulfillment(
        [raw],
        await source.read(),
        destination
      ).items
      expect(reviewed[0]!.shippingPolicyQuote?.amountSats).toBe(100)
      source.setMode(mode)
      source.setEvents([first, second])
      expect(await source.read()).toEqual([])
      expect(source.frontiers.get(coordinate)?.signedEvents).toHaveLength(2)
      expect(await fetchMerchantShippingPolicy(merchant)).toMatchObject({
        state: "unavailable",
        reason: "conflicting",
        coverageComplete: mode === "live",
      })
      const conflicted = prepareCartFulfillment(
        [raw],
        await source.read(),
        destination
      ).items
      expect(conflicted[0]!.shippingPolicyQuote).toBeUndefined()
      expect(getCartShippingOptionsAvailable(conflicted)).toBe(false)
      await expect(
        authorizeCurrentCheckoutItems({
          mode: "direct_payment",
          rawItems: [raw],
          reviewedItems: reviewed,
          refreshedProducts: [product],
          destination,
          readShippingOptions: source.read,
          resolveProductFulfillment,
          authorizePickupHandlers: async () => {},
        })
      ).resolves.toEqual({ status: "changed" })
      await expect(
        prepareProductPublicationListings(
          [listing],
          { merchantPubkey: merchant },
          {
            getShippingOptions: source.read,
            getEventMarketPickups: async () => [],
          }
        )
      ).rejects.toThrow("could not be verified")
      for (const subset of [[first], [second], []]) {
        source.setEvents(subset)
        expect(await source.read()).toEqual([])
      }
      source.setMode("unavailable")
      expect(await fetchMerchantShippingPolicy(merchant)).toMatchObject({
        state: "unavailable",
        reason: "conflicting",
        coverageComplete: false,
      })
      const retained = source.frontiers
      __resetShippingTestOverrides()
      source = reader(retained)
      source.setEvents([first])
      expect(await source.read()).toEqual([])
      source.setMode("partial_live")
      const newer = policyEvent(2, otherTerms)
      source.setEvents([first, second, newer])
      const recovered = await source.read()
      expect(recovered).toHaveLength(1)
      expect(recovered[0]?.eventId).toBe(newer.id)
      expect(source.frontiers.get(coordinate)?.signedEvents).toHaveLength(1)
      const ready = prepareCartFulfillment([raw], recovered, destination).items
      expect(ready[0]!.shippingPolicyQuote?.amountSats).toBe(900)
      await expect(
        authorizeCurrentCheckoutItems({
          mode: "direct_payment",
          rawItems: [raw],
          reviewedItems: ready,
          refreshedProducts: [product],
          destination,
          readShippingOptions: source.read,
          resolveProductFulfillment,
          authorizePickupHandlers: async () => {},
        })
      ).resolves.toMatchObject({ status: "ok" })
    })
  }
  for (const mode of [
    "unavailable",
    "partial_empty",
    "complete_empty",
    "older",
  ] as const) {
    it(`keeps retained policy readable but rejects new terms after ${mode}`, async () => {
      const source = reader()
      const live = await source.read()
      expect(live[0]).toMatchObject({
        readSource: "relay",
        readCoverage: "complete",
      })
      const reviewed = prepareCartFulfillment([raw], live, destination).items
      const historicalQuote = reviewed[0]!.shippingPolicyQuote!
      expect(historicalQuote).toBeDefined()
      source.setMode(mode)
      const retained = await source.read()
      expect(retained[0]).toMatchObject({
        readSource: "retained",
        eventId: policyEvent().id,
      })
      const newCart = prepareCartFulfillment([raw], retained, destination).items
      expect(newCart[0]!.shippingPolicyQuote).toBeUndefined()
      expect(getCartShippingOptionsAvailable(newCart)).toBe(false)
      const authorize = (mode: "direct_payment" | "order_first") =>
        authorizeCurrentCheckoutItems({
          mode,
          rawItems: [raw],
          reviewedItems: reviewed,
          refreshedProducts: [product],
          destination,
          readShippingOptions: source.read,
          resolveProductFulfillment,
          authorizePickupHandlers: async () => {},
        })
      await expect(authorize("direct_payment")).rejects.toThrow(
        "current shipping rates"
      )
      const fallback = await authorize("order_first")
      expect(fallback).toMatchObject({
        status: "ok",
        shippingOptionEvidence: {
          status: "unavailable_order_first",
          options: [],
        },
      })
      if (fallback.status !== "ok")
        throw new Error("Expected safe order-first fallback")
      expect(fallback.items[0]!.shippingPolicyQuote).toBeUndefined()
      expect(fallback.items[0]!.shippingOptionId).toBeUndefined()
      for (const target of [
        listing,
        {
          ...listing,
          fulfillmentIntent: {
            kind: "preserve_existing" as const,
            baseline: product,
          },
        },
      ]) {
        await expect(
          prepareProductPublicationListings(
            [target],
            { merchantPubkey: merchant },
            {
              getShippingOptions: source.read,
              getEventMarketPickups: async () => [],
            }
          )
        ).rejects.toThrow("could not be verified")
      }
      expect(shippingPolicyQuoteSchema.safeParse(historicalQuote).success).toBe(
        true
      )
    })
  }

  for (const mode of ["saturated_live", "saturated_rejected"] as const) {
    it(`blocks new terms after ${mode} until an uncapped option read`, async () => {
      const source = reader()
      const reviewed = prepareCartFulfillment(
        [raw],
        await source.read(),
        destination
      ).items
      const historicalQuote = reviewed[0]!.shippingPolicyQuote!
      source.setMode(mode)
      const capped = await source.read()
      expect(capped[0]).toMatchObject({
        readSource: "relay",
        readCoverage: "partial",
      })
      const cart = prepareCartFulfillment([raw], capped, destination).items
      expect(cart[0]!.shippingPolicyQuote).toBeUndefined()
      expect(getCartShippingOptionsAvailable(cart)).toBe(false)
      const authorize = () =>
        authorizeCurrentCheckoutItems({
          mode: "direct_payment",
          rawItems: [raw],
          reviewedItems: reviewed,
          refreshedProducts: [product],
          destination,
          readShippingOptions: source.read,
          resolveProductFulfillment,
          authorizePickupHandlers: async () => {},
        })
      await expect(authorize()).rejects.toThrow("current shipping rates")
      const signer = new NDKPrivateKeySigner(secret)
      const lease = setTestAccountSigner(signer)
      const sign = spyOn(lease, "signEvent")
      let localWrites = 0
      try {
        await expect(
          signAndPublishProductWriteBundle(
            {
              merchantPubkey: merchant,
              listings: [listing],
              onSignedLocal: async () => {
                localWrites++
              },
            },
            {
              getShippingOptions: source.read,
              getEventMarketPickups: async () => [],
            }
          )
        ).rejects.toThrow("could not be verified")
        expect(sign).not.toHaveBeenCalled()
        expect(localWrites).toBe(0)
      } finally {
        sign.mockRestore()
        removeTestAccountSigner(lease)
      }
      expect(shippingPolicyQuoteSchema.safeParse(historicalQuote).success).toBe(
        true
      )
      source.setMode("live")
      const recovered = prepareCartFulfillment(
        [raw],
        await source.read(),
        destination
      ).items
      expect(recovered[0]!.shippingPolicyQuote?.amountSats).toBe(100)
      await expect(authorize()).resolves.toMatchObject({ status: "ok" })
      await expect(
        prepareProductPublicationListings(
          [listing],
          { merchantPubkey: merchant },
          {
            getShippingOptions: source.read,
            getEventMarketPickups: async () => [],
          }
        )
      ).resolves.toHaveLength(1)
    })
  }

  for (const mode of [
    "partial_live",
    "deletion_unavailable",
    "deletion_saturated",
  ] as const) {
    it(`allows current positive policy evidence with ${mode}`, async () => {
      const source = reader()
      source.setMode(mode)
      const live = await source.read()
      expect(live[0]).toMatchObject({
        readSource: "relay",
        readCoverage:
          mode === "deletion_unavailable" ? "unavailable" : "partial",
      })
      const reviewed = prepareCartFulfillment([raw], live, destination).items
      expect(getCartShippingOptionsAvailable(reviewed)).toBe(true)
      await expect(
        authorizeCurrentCheckoutItems({
          mode: "direct_payment",
          rawItems: [raw],
          reviewedItems: reviewed,
          refreshedProducts: [product],
          destination,
          readShippingOptions: source.read,
          resolveProductFulfillment,
          authorizePickupHandlers: async () => {},
        })
      ).resolves.toMatchObject({
        status: "ok",
        shippingOptionEvidence: { status: "verified" },
      })
      await expect(
        prepareProductPublicationListings(
          [listing],
          { merchantPubkey: merchant },
          {
            getShippingOptions: source.read,
            getEventMarketPickups: async () => [],
          }
        )
      ).resolves.toHaveLength(1)
    })
  }

  it("stops a retained-only table publish before signing or local persistence", async () => {
    const source = reader()
    await source.read()
    source.setMode("unavailable")
    const signer = new NDKPrivateKeySigner(secret)
    const lease = setTestAccountSigner(signer)
    const sign = spyOn(lease, "signEvent")
    let localWrites = 0
    try {
      await expect(
        signAndPublishProductWriteBundle(
          {
            merchantPubkey: merchant,
            listings: [listing],
            onSignedLocal: async () => {
              localWrites++
            },
          },
          {
            getShippingOptions: source.read,
            getEventMarketPickups: async () => [],
          }
        )
      ).rejects.toThrow("could not be verified")
      expect(sign).not.toHaveBeenCalled()
      expect(localWrites).toBe(0)
    } finally {
      sign.mockRestore()
      removeTestAccountSigner(lease)
    }
  })

  it("does not recover an action-ready policy after an observed withdrawal", async () => {
    const source = reader()
    const observed = await source.read()
    const reviewedItems = prepareCartFulfillment(
      [raw],
      observed,
      destination
    ).items
    source.setMode("withdrawn")
    expect(await source.read()).toEqual([])
    await expect(
      authorizeCurrentCheckoutItems({
        mode: "direct_payment",
        rawItems: [raw],
        reviewedItems,
        refreshedProducts: [product],
        destination,
        readShippingOptions: source.read,
        resolveProductFulfillment,
        authorizePickupHandlers: async () => {},
      })
    ).resolves.toEqual({ status: "changed" })
    source.setMode("unavailable")
    expect(await source.read()).toEqual([])
    await expect(
      prepareProductPublicationListings(
        [listing],
        { merchantPubkey: merchant },
        {
          getShippingOptions: source.read,
          getEventMarketPickups: async () => [],
        }
      )
    ).rejects.toThrow("could not be verified")
  })
})
