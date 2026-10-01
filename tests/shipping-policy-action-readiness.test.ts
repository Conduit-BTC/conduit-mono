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
  buildShippingPolicyEventDraft,
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
const policyEvent = (created_at = 1) =>
  finalizeEvent(
    {
      ...buildShippingPolicyEventDraft({ policy }),
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
const product = parseProductEvent(new NDKEvent(undefined, event))!
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

function reader() {
  const frontiers = new Map<string, CachedShippingOptionFrontier>()
  let mode:
    | "live"
    | "unavailable"
    | "partial_empty"
    | "complete_empty"
    | "partial_live"
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
    fetchEventsFanoutDetailed: async (filter, options = {}) => {
      if (mode === "unavailable") throw new Error("Synthetic relay outage")
      const events = filter.kinds?.includes(30406)
        ? mode === "partial_empty" ||
          mode === "complete_empty" ||
          mode === "withdrawn"
          ? []
          : [policyEvent(mode === "older" ? 0 : 1)]
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
        eventsVerified: true,
        eventSourceRelayUrls: {},
        relays: (options.relayUrls ?? []).map((relayUrl, index) => ({
          relayUrl,
          status:
            (mode === "deletion_unavailable" &&
              !filter.kinds?.includes(30406)) ||
            (mode.startsWith("partial") && index !== 0)
              ? ("error" as const)
              : ("success" as const),
          eventCount: events.length,
        })),
      }
    },
  })
  return {
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

  for (const mode of ["partial_live", "deletion_unavailable"] as const) {
    it(`allows current positive policy evidence with ${mode}`, async () => {
      const source = reader()
      source.setMode(mode)
      const live = await source.read()
      expect(live[0]).toMatchObject({
        readSource: "relay",
        readCoverage: mode === "partial_live" ? "partial" : "unavailable",
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
