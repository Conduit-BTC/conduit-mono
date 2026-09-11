import { describe, expect, it } from "bun:test"
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools"
import { acceptOwnEventProduct } from "../apps/merchant/src/lib/event-product-acceptance"
import type {
  MerchantOrganizerEventMarket,
  MerchantOrganizerRecordDelivery,
} from "../apps/merchant/src/lib/event-market"

const OWNER_SECRET = generateSecretKey()
const OWNER = getPublicKey(OWNER_SECRET)
const OTHER = "b".repeat(64)
const COLLECTION = `30405:${OWNER}:event`
const PRODUCT = `30402:${OWNER}:own-product`
const PRIOR_PRODUCT = `30402:${OWNER}:prior-product`
const OTHER_PRIOR_PRODUCT = `30402:${OWNER}:other-prior-product`
const PICKUP = `30406:${OWNER}:booth`
const CALENDAR = `31923:${OWNER}:calendar`

function signedCollection(
  productCoordinates: string[],
  createdAt = 12,
  title = "Test event"
) {
  return finalizeEvent(
    {
      kind: 30405,
      created_at: createdAt,
      content: "Retained collection content",
      tags: [
        ["d", "event"],
        ["title", title],
        ["a", CALENDAR],
        ["shipping_option", PICKUP],
        ...productCoordinates.map((coordinate) => ["a", coordinate]),
      ],
    },
    OWNER_SECRET
  )
}
const market = {
  state: "partial",
  organizerPubkey: OWNER,
  collectionCoordinate: COLLECTION,
  productCoordinates: [],
  collectionCreatedAt: 10_000,
  participation: [
    {
      productCoordinate: PRODUCT,
      merchantPubkey: OWNER,
      eventId: "product-id",
      createdAt: 11,
      status: "pending",
      fulfillmentStatus: "resolved",
      handoffMode: "merchant_handoff",
      handlerPubkey: OWNER,
      pickupCoordinate: PICKUP,
      pickupAuthorPubkey: OWNER,
      productPreview: {
        coordinate: PRODUCT,
        eventId: "product-id",
        createdAt: 11,
        priceStatus: "resolved",
        title: "Own product",
        price: 10,
        currency: "SAT",
      },
    },
  ],
} as MerchantOrganizerEventMarket
const record = {
  record: "collection",
  acknowledgedCount: 1,
  rejectedCount: 0,
  timedOutCount: 0,
  signedEvent: signedCollection([PRODUCT]),
} as MerchantOrganizerRecordDelivery

function harness(
  current = market,
  savedCollection: MerchantOrganizerRecordDelivery | null = null
) {
  const published: unknown[] = []
  const retried: unknown[] = []
  const resolved: unknown[][] = []
  const saved: unknown[] = []
  let reads = 0
  const deps = {
    resolve: async (...input: unknown[]) => {
      resolved.push(input)
      reads++
      return current
    },
    publish: async (input: {
      onSignedEvent?: (
        record: MerchantOrganizerRecordDelivery,
        coordinate: string
      ) => void | Promise<void>
    }) => {
      published.push(input)
      await input.onSignedEvent?.(record, COLLECTION)
      return record
    },
    retry: async (input: unknown) => {
      retried.push(input)
      return record
    },
    save: (...input: unknown[]) => {
      saved.push(input)
    },
    load: () => (savedCollection ? { [COLLECTION]: [savedCollection] } : {}),
  }
  return { deps, published, retried, resolved, saved, reads: () => reads }
}
const input = {
  merchantPubkey: OWNER,
  authenticatedPubkey: OWNER,
  marketReference: COLLECTION,
  productCoordinate: PRODUCT,
}

describe("organizer own-product acceptance", () => {
  it("rejects a different merchant's product even in your own market", async () => {
    const h = harness()
    await expect(
      acceptOwnEventProduct(
        { ...input, productCoordinate: `30402:${OTHER}:other-product` },
        h.deps
      )
    ).rejects.toThrow("Only your own product")
    expect(h.reads()).toBe(0)
  })
  it("keeps ambiguous handoff evidence unaccepted", async () => {
    const h = harness({
      ...market,
      participation: [
        { ...market.participation[0]!, fulfillmentStatus: "ambiguous" },
      ],
    })
    await expect(acceptOwnEventProduct(input, h.deps)).rejects.toThrow(
      "current signed product"
    )
    expect(h.published).toHaveLength(0)
  })
  it("does not call a zero-ACK collection publication accepted", async () => {
    const h = harness()
    h.deps.publish = async () => ({ ...record, acknowledgedCount: 0 })
    await expect(acceptOwnEventProduct(input, h.deps)).rejects.toThrow(
      "not delivered yet"
    )
  })
  it("stops when signed acceptance cannot be saved for exact retry", async () => {
    const h = harness()
    h.deps.save = () => {
      throw new Error("Storage unavailable")
    }
    await expect(acceptOwnEventProduct(input, h.deps)).rejects.toThrow(
      "Storage unavailable"
    )
    expect(h.retried).toHaveLength(0)
  })
  it("never signs acceptance for another organizer's market", async () => {
    const h = harness()
    expect(
      await acceptOwnEventProduct({ ...input, merchantPubkey: OTHER }, h.deps)
    ).toBe(false)
    expect(h.reads()).toBe(0)
    expect(h.published).toHaveLength(0)
  })
  it("accepts verified own pickup with a separate saved collection signature", async () => {
    const h = harness()
    expect(await acceptOwnEventProduct(input, h.deps)).toBe(true)
    expect(h.resolved).toEqual([
      [COLLECTION, OWNER, OWNER, undefined, undefined],
    ])
    expect(h.published).toHaveLength(1)
    expect(h.published[0]).toEqual(
      expect.objectContaining({
        organizerPubkey: OWNER,
        authenticatedPubkey: OWNER,
      })
    )
    expect(h.saved).toHaveLength(2)
  })
  it("keeps authentication distinct from the organizer at read and publish seams", async () => {
    const h = harness()
    expect(
      await acceptOwnEventProduct(
        { ...input, authenticatedPubkey: OTHER },
        h.deps
      )
    ).toBe(true)
    expect(h.resolved).toEqual([
      [COLLECTION, OWNER, OTHER, undefined, undefined],
    ])
    expect(h.published[0]).toEqual(
      expect.objectContaining({
        organizerPubkey: OWNER,
        authenticatedPubkey: OTHER,
      })
    )
  })
  it("does not accept merely because the form was published", async () => {
    const h = harness({ ...market, participation: [] })
    await expect(acceptOwnEventProduct(input, h.deps)).rejects.toThrow(
      "current signed product"
    )
    expect(h.published).toHaveLength(0)
  })
  it("retries the same signed acceptance instead of creating a new revision", async () => {
    const h = harness()
    const shouldContinue = () => true
    expect(
      await acceptOwnEventProduct(
        { ...input, signedAcceptance: record, shouldContinue },
        h.deps
      )
    ).toBe(true)
    expect(h.published).toHaveLength(0)
    expect(h.retried).toEqual([
      {
        organizerPubkey: OWNER,
        authenticatedPubkey: OWNER,
        shouldContinue,
        record,
      },
    ])
  })

  it("keeps live session authority on the read and acceptance publish", async () => {
    const h = harness()
    const shouldContinue = () => true

    expect(
      await acceptOwnEventProduct({ ...input, shouldContinue }, h.deps)
    ).toBe(true)
    expect(h.resolved).toEqual([
      [COLLECTION, OWNER, OWNER, undefined, shouldContinue],
    ])
    expect(h.published[0]).toEqual(expect.objectContaining({ shouldContinue }))
  })
  it("publishes from a newer collection instead of retrying an old acceptance", async () => {
    const h = harness({
      ...market,
      collectionCreatedAt: 13_000,
      source: {
        collection: { eventId: "current", createdAt: 13_000 },
      },
    } as MerchantOrganizerEventMarket)
    expect(
      await acceptOwnEventProduct(
        { ...input, signedAcceptance: record },
        h.deps
      )
    ).toBe(true)
    expect(h.retried).toHaveLength(0)
    expect(h.published).toHaveLength(1)
    const publishInput = h.published[0] as {
      market: MerchantOrganizerEventMarket
    }
    expect(publishInput.market.productCoordinates).toEqual([])
    expect(publishInput.market.collectionCreatedAt).toBe(13_000)
  })
  it("retries a prior zero-ACK collection instead of signing over it", async () => {
    const pending = { ...record, acknowledgedCount: 0 }
    const h = harness(market, pending)
    expect(await acceptOwnEventProduct(input, h.deps)).toBe(true)
    expect(h.published).toHaveLength(0)
    expect(h.retried).toEqual([
      {
        organizerPubkey: OWNER,
        authenticatedPubkey: OWNER,
        shouldContinue: undefined,
        record: pending,
      },
    ])
  })
  it("publishes the next own product over a partially acknowledged current collection", async () => {
    const partialEvent = signedCollection([PRIOR_PRODUCT])
    const partial = {
      ...record,
      rejectedCount: 1,
      signedEvent: partialEvent,
    }
    const h = harness(
      {
        ...market,
        productCoordinates: [PRIOR_PRODUCT],
        source: {
          collection: {
            eventId: partial.signedEvent.id,
            createdAt: partial.signedEvent.created_at * 1_000,
          },
        },
      } as MerchantOrganizerEventMarket,
      partial
    )

    expect(await acceptOwnEventProduct(input, h.deps)).toBe(true)
    expect(h.retried).toHaveLength(0)
    expect(h.published).toHaveLength(1)
    expect(
      (h.published[0] as { market: MerchantOrganizerEventMarket }).market
        .productCoordinates
    ).toEqual([PRIOR_PRODUCT])
  })
  it("preserves a newer acknowledged retained collection over an older partial relay read", async () => {
    const relayEvent = signedCollection([PRIOR_PRODUCT], 12, "Relay event")
    const retainedEvent = signedCollection(
      [PRIOR_PRODUCT, OTHER_PRIOR_PRODUCT],
      13,
      "Retained event"
    )
    const retained = {
      ...record,
      rejectedCount: 1,
      signedEvent: retainedEvent,
    }
    const h = harness(
      {
        ...market,
        title: "Relay event",
        productCoordinates: [PRIOR_PRODUCT],
        collectionCreatedAt: relayEvent.created_at * 1_000,
        source: {
          collection: {
            eventId: relayEvent.id,
            createdAt: relayEvent.created_at * 1_000,
          },
        },
      } as MerchantOrganizerEventMarket,
      retained
    )

    expect(await acceptOwnEventProduct(input, h.deps)).toBe(true)
    expect(h.retried).toHaveLength(0)
    expect(h.published).toHaveLength(1)
    const publishInput = h.published[0] as {
      market: MerchantOrganizerEventMarket
      retainedCollection: MerchantOrganizerRecordDelivery
    }
    expect(publishInput.market.productCoordinates).toEqual([
      PRIOR_PRODUCT,
      OTHER_PRIOR_PRODUCT,
    ])
    expect(publishInput.market.pickupCoordinates).toEqual([PICKUP])
    expect(publishInput.market.calendarCoordinate).toBe(CALENDAR)
    expect(publishInput.market.title).toBe("Retained event")
    expect(publishInput.market.collectionCreatedAt).toBe(13_000)
    expect(publishInput.retainedCollection).toBe(retained)
  })
  it("does not report an older relay acceptance after a newer retained removal", async () => {
    const relayEvent = signedCollection([PRODUCT], 12, "Relay event")
    const retainedRemoval = {
      ...record,
      signedEvent: signedCollection([], 13, "Retained removal"),
    }
    const h = harness(
      {
        ...market,
        productCoordinates: [PRODUCT],
        collectionCreatedAt: relayEvent.created_at * 1_000,
        participation: [{ ...market.participation[0]!, status: "accepted" }],
        source: {
          collection: {
            eventId: relayEvent.id,
            createdAt: relayEvent.created_at * 1_000,
          },
        },
      } as MerchantOrganizerEventMarket,
      retainedRemoval
    )

    expect(await acceptOwnEventProduct(input, h.deps)).toBe(true)
    expect(h.retried).toHaveLength(0)
    expect(h.published).toHaveLength(1)
    const publishInput = h.published[0] as {
      market: MerchantOrganizerEventMarket
      retainedCollection: MerchantOrganizerRecordDelivery
    }
    expect(publishInput.market.productCoordinates).toEqual([])
    expect(publishInput.market.collectionCreatedAt).toBe(13_000)
    expect(publishInput.retainedCollection).toBe(retainedRemoval)
  })
  it("ignores an older zero-ACK collection once a newer relay frontier is known", async () => {
    const retained = {
      ...record,
      acknowledgedCount: 0,
      signedEvent: signedCollection([PRIOR_PRODUCT], 12, "Old retained event"),
    }
    const relayEvent = signedCollection(
      [OTHER_PRIOR_PRODUCT],
      13,
      "Current relay event"
    )
    const h = harness(
      {
        ...market,
        title: "Current relay event",
        productCoordinates: [OTHER_PRIOR_PRODUCT],
        collectionCreatedAt: relayEvent.created_at * 1_000,
        source: {
          collection: {
            eventId: relayEvent.id,
            createdAt: relayEvent.created_at * 1_000,
          },
        },
      } as MerchantOrganizerEventMarket,
      retained
    )

    expect(await acceptOwnEventProduct(input, h.deps)).toBe(true)
    expect(h.retried).toHaveLength(0)
    expect(h.published).toHaveLength(1)
    const publishInput = h.published[0] as {
      market: MerchantOrganizerEventMarket
      retainedCollection: MerchantOrganizerRecordDelivery
    }
    expect(publishInput.market.productCoordinates).toEqual([
      OTHER_PRIOR_PRODUCT,
    ])
    expect(publishInput.market.collectionCreatedAt).toBe(13_000)
    expect(publishInput.retainedCollection).toBe(retained)
  })
  it("does not supersede a NIP-01-newer same-second collection", async () => {
    const currentId = "0".repeat(64)
    const pending = {
      ...record,
      acknowledgedCount: 0,
    }
    const h = harness(
      {
        ...market,
        collectionCreatedAt: 12_000,
        source: {
          collection: { eventId: currentId, createdAt: 12_000 },
        },
      } as MerchantOrganizerEventMarket,
      pending
    )
    expect(await acceptOwnEventProduct(input, h.deps)).toBe(true)
    expect(h.retried).toHaveLength(0)
    expect(h.published).toHaveLength(1)
    expect(
      (h.published[0] as { market: MerchantOrganizerEventMarket }).market
        .collectionCreatedAt
    ).toBe(12_000)
  })
  it("does not ignore a newer unresolved saved collection", async () => {
    const pending = {
      ...record,
      acknowledgedCount: 0,
      signedEvent: signedCollection([], 13, "Newer pending"),
    }
    const h = harness(market, pending)
    await expect(
      acceptOwnEventProduct({ ...input, signedAcceptance: record }, h.deps)
    ).rejects.toThrow("changed")
    expect(h.retried).toHaveLength(0)
    expect(h.published).toHaveLength(0)
  })
  it("does not sign again when current verified membership already includes it", async () => {
    const h = harness({
      ...market,
      productCoordinates: [PRODUCT],
      participation: [{ ...market.participation[0]!, status: "accepted" }],
    })
    expect(await acceptOwnEventProduct(input, h.deps)).toBe(true)
    expect(h.published).toHaveLength(0)
  })
})
