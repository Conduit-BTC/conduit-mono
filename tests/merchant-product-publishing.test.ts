import { describe, expect, it } from "bun:test"
import type { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  EVENT_KINDS,
  parseProductEvent,
  type PublishWithPlannerResult,
} from "@conduit/core"
import { finalizeEvent, getPublicKey } from "nostr-tools/pure"
import {
  applyProductFulfillmentIntentForPublication,
  isDeliverableMerchantProductEvent,
  publishCanonicalProductEvents,
  type CanonicalProductPublishDependencies,
} from "../apps/merchant/src/lib/product-publishing"

const MERCHANT_SECRET = new Uint8Array(32).fill(4)
const OTHER_MERCHANT_SECRET = new Uint8Array(32).fill(5)
const MERCHANT_PUBKEY = getPublicKey(MERCHANT_SECRET)

function makeSignedEvent(kind: number) {
  return finalizeEvent(
    {
      kind,
      created_at: 1_700_000_100,
      content: kind === EVENT_KINDS.DELETION ? "Listing removed" : "Listing",
      tags:
        kind === EVENT_KINDS.DELETION
          ? [["a", `${EVENT_KINDS.PRODUCT}:${MERCHANT_PUBKEY}:listing`]]
          : [["d", "listing"]],
    },
    MERCHANT_SECRET
  )
}

describe("merchant product event delivery", () => {
  it("accepts signed product listings and NIP-09 deletion events", () => {
    expect(
      isDeliverableMerchantProductEvent(
        makeSignedEvent(EVENT_KINDS.PRODUCT),
        MERCHANT_PUBKEY
      )
    ).toBe(true)
    expect(
      isDeliverableMerchantProductEvent(
        makeSignedEvent(EVENT_KINDS.DELETION),
        MERCHANT_PUBKEY
      )
    ).toBe(true)
  })

  it("rejects unsupported kinds and a different merchant identity", () => {
    expect(
      isDeliverableMerchantProductEvent(makeSignedEvent(1), MERCHANT_PUBKEY)
    ).toBe(false)
    expect(
      isDeliverableMerchantProductEvent(
        makeSignedEvent(EVENT_KINDS.PRODUCT),
        getPublicKey(OTHER_MERCHANT_SECRET)
      )
    ).toBe(false)
  })
})

function publishResult(
  successfulRelayUrls: string[]
): PublishWithPlannerResult {
  return {
    plan: {
      intent: "author_event",
      primaryRelayUrls: [],
      broadcastRelayUrls: [],
      parkedRelayUrls: [],
    },
    attemptedRelayUrls: ["wss://relay.example"],
    successfulRelayUrls,
    failedRelayUrls: [],
    relayFailureMessages: {},
  }
}

function event(kind: number): NDKEvent {
  return { kind } as NDKEvent
}

describe("canonical product publication ordering", () => {
  it("upgrades a legacy inline listing to the product-scoped coordinate", () => {
    const legacy = parseProductEvent({
      id: "legacy-event",
      pubkey: MERCHANT_PUBKEY,
      created_at: 1_700_000_100,
      content: "Legacy listing",
      tags: [
        ["d", "listing"],
        ["title", "Listing"],
        ["price", "10", "USD"],
        ["type", "simple", "physical"],
        ["shipping_cost", "5", "USD"],
        ["shipping_country", "US"],
      ],
    })

    const prepared = applyProductFulfillmentIntentForPublication({
      product: legacy,
      merchantPubkey: MERCHANT_PUBKEY,
      productDTag: "listing",
      intent: {
        kind: "fixed_standard",
        amount: 5,
        currency: "USD",
        countries: ["US"],
      },
    })

    expect(prepared).toMatchObject({
      shippingOptionId: `30406:${MERCHANT_PUBKEY}:listing-shipping-standard`,
      shippingOptionDTag: "listing-shipping-standard",
      shippingCountries: ["US"],
      shippingCountryRules: [
        { code: "US", name: "US", restrictTo: [], exclude: [] },
      ],
    })
  })

  it("requires a shipping ACK before caching or publishing the product", async () => {
    const calls: string[] = []
    const productEvent = event(30402)
    const shippingEvent = event(30406)
    const dependencies: CanonicalProductPublishDependencies = {
      publishShippingEvent: async () => {
        calls.push("shipping_ack")
        return publishResult(["wss://relay.example"])
      },
      cacheProductEvent: async () => {
        calls.push("product_cache")
      },
      deliverProductEvent: async () => {
        calls.push("product_publish")
        return publishResult(["wss://relay.example"])
      },
    }

    await publishCanonicalProductEvents(
      {
        productEvent,
        shippingEvent,
        merchantPubkey: "merchant",
        onSignedLocal: async () => {
          calls.push("product_local")
        },
      },
      dependencies
    )

    expect(calls).toEqual([
      "shipping_ack",
      "product_cache",
      "product_local",
      "product_publish",
    ])
  })

  it("stops before every product side effect when shipping has no ACK", async () => {
    const calls: string[] = []
    const dependencies: CanonicalProductPublishDependencies = {
      publishShippingEvent: async () => {
        calls.push("shipping_attempt")
        return publishResult([])
      },
      cacheProductEvent: async () => {
        calls.push("product_cache")
      },
      deliverProductEvent: async () => {
        calls.push("product_publish")
        return publishResult(["wss://relay.example"])
      },
    }

    await expect(
      publishCanonicalProductEvents(
        {
          productEvent: event(30402),
          shippingEvent: event(30406),
          merchantPubkey: "merchant",
          onSignedLocal: async () => {
            calls.push("product_local")
          },
        },
        dependencies
      )
    ).rejects.toThrow("Product publication was stopped.")
    expect(calls).toEqual(["shipping_attempt"])
  })

  it("publishes non-fixed products without a shipping event", async () => {
    const calls: string[] = []
    const dependencies: CanonicalProductPublishDependencies = {
      publishShippingEvent: async () => {
        calls.push("unexpected_shipping")
        return publishResult([])
      },
      cacheProductEvent: async () => {
        calls.push("product_cache")
      },
      deliverProductEvent: async () => {
        calls.push("product_publish")
        return publishResult(["wss://relay.example"])
      },
    }

    await publishCanonicalProductEvents(
      {
        productEvent: event(30402),
        shippingEvent: null,
        merchantPubkey: "merchant",
        onSignedLocal: async () => {
          calls.push("product_local")
        },
      },
      dependencies
    )

    expect(calls).toEqual(["product_cache", "product_local", "product_publish"])
  })

  it("removes legacy shipping fields from non-fixed publication state", () => {
    const product = parseProductEvent({
      id: "legacy-event",
      pubkey: MERCHANT_PUBKEY,
      created_at: 1_700_000_100,
      content: "Legacy listing",
      tags: [
        ["d", "listing"],
        ["title", "Listing"],
        ["price", "10", "USD"],
        ["type", "simple", "physical"],
        ["shipping_cost", "5", "USD"],
        ["shipping_country", "US"],
      ],
    })

    expect(
      applyProductFulfillmentIntentForPublication({
        product,
        merchantPubkey: MERCHANT_PUBKEY,
        productDTag: "listing",
        intent: { kind: "coordinate_after_order" },
      })
    ).toMatchObject({
      shippingCostSats: undefined,
      sourceShippingCost: undefined,
      shippingOptionId: undefined,
      shippingCountries: undefined,
      canonicalShippingResolved: false,
    })
  })
})
