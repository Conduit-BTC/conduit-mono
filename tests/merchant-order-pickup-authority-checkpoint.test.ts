import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import type { OrderPickupFulfillmentSchema, OrderSummary } from "@conduit/core"
import {
  buildEventMarketCalendarDraft,
  buildEventMarketCollectionDraft,
  buildEventMarketPickupDraft,
  EVENT_KINDS,
} from "@conduit/core"
import {
  buildVerifiedPickupOrderAuthorityCheckpoint,
  checkpointMatchesPickupOrder,
  loadMatchingPickupOrderAuthorityCheckpoint,
  saveVerifiedPickupOrderAuthorityCheckpoint,
  verifyAndCheckpointMerchantPickupOrderAuthorization,
} from "../apps/merchant/src/lib/order-pickup-authority-checkpoint"

const organizerSecret = generateSecretKey()
const merchantSecret = generateSecretKey()
const organizer = getPublicKey(organizerSecret)
const merchant = getPublicKey(merchantSecret)
const product = `30402:${merchant}:coffee`
const collection = `30405:${organizer}:market`
const calendar = `31923:${organizer}:market`
const option = `30406:${merchant}:market-booth`

function sign(
  secret: Uint8Array,
  draft: { kind: number; content: string; tags: string[][] },
  createdAt: number
) {
  return finalizeEvent(
    {
      kind: draft.kind,
      content: draft.content,
      tags: draft.tags,
      created_at: createdAt,
    },
    secret
  )
}

const calendarEvent = sign(
  organizerSecret,
  buildEventMarketCalendarDraft({
    kind: EVENT_KINDS.CALENDAR_TIME,
    dTag: "market",
    title: "Market",
    start: 1_800_000_000,
    end: 1_800_003_600,
    startTzid: "UTC",
    endTzid: "UTC",
  }),
  101
)
const collectionEvent = sign(
  organizerSecret,
  buildEventMarketCollectionDraft({
    dTag: "market",
    title: "Market",
    eventCoordinate: calendar,
    productCoordinates: [product],
  }),
  102
)
const optionEvent = sign(
  merchantSecret,
  buildEventMarketPickupDraft({
    dTag: "market-booth",
    title: "Merchant booth",
    price: 0,
    currency: "SATS",
    countries: ["US"],
    location: "North aisle",
  }),
  103
)
const productEvent = sign(
  merchantSecret,
  {
    kind: EVENT_KINDS.PRODUCT,
    content: "Coffee",
    tags: [
      ["d", "coffee"],
      ["title", "Coffee"],
      ["price", "1200", "SATS"],
      ["a", collection],
      ["shipping_option", option],
    ],
  },
  104
)
const signedEvidence = [
  calendarEvent,
  collectionEvent,
  optionEvent,
  productEvent,
]

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
  }
}

function fulfillment(
  overrides: Partial<OrderPickupFulfillmentSchema> = {}
): OrderPickupFulfillmentSchema {
  return {
    type: "pickup",
    organizerPubkey: organizer,
    handoffMode: "merchant_handoff",
    handlerPubkey: merchant,
    product: {
      coordinate: product,
      merchantPubkey: merchant,
      eventId: productEvent.id,
      createdAt: productEvent.created_at * 1_000,
    },
    calendar: {
      coordinate: calendar,
      eventId: calendarEvent.id,
      createdAt: calendarEvent.created_at * 1_000,
    },
    collection: {
      coordinate: collection,
      eventId: collectionEvent.id,
      createdAt: collectionEvent.created_at * 1_000,
    },
    option: {
      coordinate: option,
      eventId: optionEvent.id,
      createdAt: optionEvent.created_at * 1_000,
      title: "Merchant booth",
      location: "North aisle",
    },
    costSats: 0,
    sourceCost: {
      amount: 0,
      currency: "SATS",
      normalizedCurrency: "SATS",
    },
    ...overrides,
  }
}

function items(
  pickup: OrderPickupFulfillmentSchema = fulfillment()
): OrderSummary["items"] {
  return [
    {
      productId: pickup.product.coordinate,
      title: "Coffee",
      format: "physical",
      fulfillment: pickup,
      quantity: 2,
      priceAtPurchase: 1_200,
      currency: "SATS",
      sourcePrice: {
        amount: 1_200,
        currency: "SATS",
        normalizedCurrency: "SATS",
      },
      shippingOptionId: pickup.option.coordinate,
      shippingOptionDTag: "market-booth",
      shippingCostSats: 0,
      sourceShippingCost: { ...pickup.sourceCost },
    },
  ]
}

describe("verified pickup order authority checkpoints", () => {
  it("stores only the exact verified public authority and commerce terms", () => {
    const checkpoint = buildVerifiedPickupOrderAuthorityCheckpoint({
      orderId: "order-1",
      merchantPubkey: merchant,
      items: items(),
      signedEvidence,
      verifiedAt: 500,
    })

    expect(checkpoint).toMatchObject({
      version: 1,
      orderId: "order-1",
      merchantPubkey: merchant,
      handoffMode: "merchant_handoff",
      handlerPubkey: merchant,
      verifiedAt: 500,
      items: [
        {
          quantity: 2,
          priceAtPurchase: 1_200,
          pickupCostSats: 0,
        },
      ],
    })
    expect(JSON.stringify(checkpoint)).not.toContain("contact")
    expect(JSON.stringify(checkpoint)).not.toContain("invoice")
    expect(JSON.stringify(checkpoint)).not.toContain("proof")
  })

  it("loads only an exact order snapshot match", () => {
    const storage = memoryStorage()
    const checkpoint = buildVerifiedPickupOrderAuthorityCheckpoint({
      orderId: "order-1",
      merchantPubkey: merchant,
      items: items(),
      signedEvidence,
      verifiedAt: 500,
    })
    saveVerifiedPickupOrderAuthorityCheckpoint(checkpoint, storage)

    expect(
      loadMatchingPickupOrderAuthorityCheckpoint(
        { orderId: "order-1", merchantPubkey: merchant, items: items() },
        storage
      )
    ).toEqual(checkpoint)

    const changedQuantity = structuredClone(items())
    changedQuantity[0]!.quantity = 3
    expect(
      loadMatchingPickupOrderAuthorityCheckpoint(
        {
          orderId: "order-1",
          merchantPubkey: merchant,
          items: changedQuantity,
        },
        storage
      )
    ).toBeNull()
    expect(
      loadMatchingPickupOrderAuthorityCheckpoint(
        { orderId: "another", merchantPubkey: merchant, items: items() },
        storage
      )
    ).toBeNull()
  })

  it("does not silently evict older order authority after 200 checkpoints", () => {
    const base = buildVerifiedPickupOrderAuthorityCheckpoint({
      orderId: "order-0",
      merchantPubkey: merchant,
      items: items(),
      signedEvidence,
      verifiedAt: 500,
    })
    let stored = JSON.stringify(
      Array.from({ length: 200 }, (_, index) => ({
        ...base,
        orderId: `order-${index}`,
        verifiedAt: 500 + index,
      }))
    )
    const storage = {
      getItem: () => stored,
      setItem: (_key: string, value: string) => {
        stored = value
      },
    }
    saveVerifiedPickupOrderAuthorityCheckpoint(
      { ...base, orderId: "order-200", verifiedAt: 700 },
      storage
    )

    expect(
      loadMatchingPickupOrderAuthorityCheckpoint(
        { orderId: "order-0", merchantPubkey: merchant, items: items() },
        storage
      )?.orderId
    ).toBe("order-0")
    expect(
      loadMatchingPickupOrderAuthorityCheckpoint(
        { orderId: "order-200", merchantPubkey: merchant, items: items() },
        storage
      )?.orderId
    ).toBe("order-200")
  }, 10_000)

  it("never upgrades a merchant-only order after the current event changes", () => {
    const original = buildVerifiedPickupOrderAuthorityCheckpoint({
      orderId: "order-1",
      merchantPubkey: merchant,
      items: items(),
      signedEvidence,
      verifiedAt: 500,
    })
    const organizerPickup = fulfillment({
      handoffMode: "organizer_handoff",
      handlerPubkey: organizer,
      option: {
        ...fulfillment().option,
        coordinate: `30406:${organizer}:organizer-pickup`,
        eventId: "5".repeat(64),
      },
    })

    expect(
      checkpointMatchesPickupOrder(original, {
        orderId: "order-1",
        merchantPubkey: merchant,
        items: items(organizerPickup),
      })
    ).toBe(false)
    expect(original.handoffMode).toBe("merchant_handoff")
    expect(original.handlerPubkey).toBe(merchant)
  })

  it("uses the exact signed snapshot for an existing order after live revisions change", async () => {
    const storage = memoryStorage()
    saveVerifiedPickupOrderAuthorityCheckpoint(
      buildVerifiedPickupOrderAuthorityCheckpoint({
        orderId: "order-1",
        merchantPubkey: merchant,
        items: items(),
        signedEvidence,
        verifiedAt: 500,
      }),
      storage
    )

    const result = await verifyAndCheckpointMerchantPickupOrderAuthorization(
      {
        orderId: "order-1",
        merchantPubkey: merchant,
        items: items(),
      },
      {
        getEventMarket: async () => {
          throw new Error("current arrangement changed")
        },
        getProductsByIds: async () => {
          throw new Error("not reached")
        },
      },
      { storage }
    )

    expect(result).toMatchObject({
      status: "verified",
      market: {
        collection: { eventId: collectionEvent.id },
        acceptedProductCoordinates: [product],
      },
    })
  })

  it("rejects legacy omitted authority and mixed fulfillment", () => {
    const legacy = fulfillment()
    delete legacy.handoffMode
    delete legacy.handlerPubkey
    expect(() =>
      buildVerifiedPickupOrderAuthorityCheckpoint({
        orderId: "legacy",
        merchantPubkey: merchant,
        items: items(legacy),
        signedEvidence,
      })
    ).toThrow("explicit reconciliation")

    const mixed = items()
    mixed.push({
      productId: `30402:${merchant}:digital`,
      format: "digital",
      fulfillment: { type: "digital" },
      quantity: 1,
      priceAtPurchase: 100,
      currency: "SATS",
    })
    expect(() =>
      buildVerifiedPickupOrderAuthorityCheckpoint({
        orderId: "mixed",
        merchantPubkey: merchant,
        items: mixed,
        signedEvidence,
      })
    ).toThrow("one coherent merchant pickup order")
  })
})
