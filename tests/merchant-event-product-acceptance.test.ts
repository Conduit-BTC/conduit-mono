import { describe, expect, it } from "bun:test"
import { acceptOwnEventProduct } from "../apps/merchant/src/lib/event-product-acceptance"
import type {
  MerchantOrganizerEventMarket,
  MerchantOrganizerRecordDelivery,
} from "../apps/merchant/src/lib/event-market"

const OWNER = "a".repeat(64)
const OTHER = "b".repeat(64)
const COLLECTION = `30405:${OWNER}:event`
const PRODUCT = `30402:${OWNER}:own-product`
const PICKUP = `30406:${OWNER}:booth`
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
  signedEvent: {
    kind: 30405,
    pubkey: OWNER,
    created_at: 12,
    tags: [
      ["d", "event"],
      ["a", PRODUCT],
    ],
    id: "same-signed-acceptance",
  },
} as MerchantOrganizerRecordDelivery

function harness(current = market) {
  const published: unknown[] = []
  const retried: unknown[] = []
  const saved: unknown[] = []
  let reads = 0
  const deps = {
    resolve: async () => {
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
  }
  return { deps, published, retried, saved, reads: () => reads }
}
const input = {
  merchantPubkey: OWNER,
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
    expect(h.published).toHaveLength(1)
    expect(h.saved).toHaveLength(2)
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
    expect(
      await acceptOwnEventProduct(
        { ...input, signedAcceptance: record },
        h.deps
      )
    ).toBe(true)
    expect(h.published).toHaveLength(0)
    expect(h.retried).toEqual([{ organizerPubkey: OWNER, record }])
  })
  it("does not overwrite a newer collection decision with an old retry", async () => {
    const h = harness({ ...market, collectionCreatedAt: 13_000 })
    await expect(
      acceptOwnEventProduct({ ...input, signedAcceptance: record }, h.deps)
    ).rejects.toThrow("changed")
    expect(h.retried).toHaveLength(0)
    expect(h.published).toHaveLength(0)
  })
  it("does not sign again when current verified membership already includes it", async () => {
    const h = harness({
      ...market,
      participation: [{ ...market.participation[0]!, status: "accepted" }],
    })
    expect(await acceptOwnEventProduct(input, h.deps)).toBe(true)
    expect(h.published).toHaveLength(0)
  })
})
