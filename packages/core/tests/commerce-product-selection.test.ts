import { describe, expect, it } from "bun:test"
import {
  filterExactProductRecordsForRead,
  filterProductRecordsForRead,
  getProductLookupIds,
  mergeProductRecordSources,
  reconcileProductRecordsWithDeletions,
  reconcileProductRecordsWithRevisions,
  type CommerceProductRecord,
} from "../src/protocol/commerce-product-selection"
import type { Product } from "../src/types"

const author = "a".repeat(64)
const clock = () => 123_456
let eventSequence = 0

// Already-projected records exercise selection, not signature admission or I/O.
function record(
  name: string,
  changes: Partial<Product> = {},
  revision = 10
): CommerceProductRecord {
  const addressId = `30402:${author}:${name}`
  return {
    addressId,
    dTag: name,
    eventId: (++eventSequence).toString(16).padStart(64, "0"),
    eventCreatedAt: revision,
    product: {
      id: addressId,
      pubkey: author,
      title: name,
      price: 10,
      currency: "SATS",
      type: "simple",
      format: "digital",
      specifications: [],
      visibility: "public",
      images: [{ url: "https://images.unsplash.com/product.png" }],
      tags: [],
      publicZapEnabled: false,
      publicZapPolicyKnown: true,
      zapMessagePolicy: "generic_only",
      createdAt: revision,
      updatedAt: revision,
      ...changes,
    },
  }
}

function family() {
  const parent = record("parent", { type: "variable" })
  const red = record("red", {
    type: "variation",
    parentProductId: parent.addressId,
    specifications: [{ key: "Color", value: "Red" }],
  })
  const blue = record("blue", {
    type: "variation",
    parentProductId: parent.addressId,
    specifications: [{ key: "Color", value: "Blue" }],
  })
  return { parent, red, blue, records: [parent, red, blue] }
}

describe("commerce product selection", () => {
  it("keeps browse visibility, family ordering and the caller's timestamp", () => {
    const { parent, red, blue } = family()
    const publicListing = record("public")
    const hidden = record("hidden", { visibility: "private" })
    const noImage = record("no-image", { images: [] })
    const orphan = record("orphan", {
      type: "variation",
      parentProductId: `30402:${author}:missing`,
    })
    const records = [hidden, publicListing, parent, red, noImage, blue, orphan]
    const selected = filterProductRecordsForRead(records, {}, clock)
    expect(selected.map((item) => item.addressId)).toEqual([
      publicListing.addressId,
      parent.addressId,
    ])
    expect(selected[1]?.family?.children.map((item) => item.addressId)).toEqual(
      [blue.addressId, red.addressId]
    )
    expect(selected[1]?.family?.readEvidence.fetchedAt).toBe(clock())
    expect(
      filterProductRecordsForRead(records, { includeMarketHidden: true }, clock)
    ).toBe(records)
  })

  it("does not borrow an unaccepted parent or sibling image for hidden pickup", () => {
    const { parent, red, blue } = family()
    const privateParent = {
      ...parent,
      product: { ...parent.product, visibility: "private" as const },
    }
    const privateRed = {
      ...red,
      product: { ...red.product, visibility: "private" as const, images: [] },
    }
    const options = { includeMerchantHiddenProductIds: [red.addressId] }
    const wanted = new Set([red.addressId])
    expect(
      filterExactProductRecordsForRead(
        [privateParent, privateRed, blue],
        wanted,
        options,
        clock
      )
    ).toEqual([])
    const accepted = filterExactProductRecordsForRead(
      [
        privateParent,
        {
          ...privateRed,
          product: { ...privateRed.product, images: red.product.images },
        },
        blue,
      ],
      wanted,
      options,
      clock
    )
    expect(accepted.map((item) => item.addressId)).toEqual([red.addressId])
    expect(
      accepted[0]?.exactReadContext?.includeMerchantHiddenProductIds
    ).toEqual([red.addressId])
    expect(
      filterExactProductRecordsForRead(
        [privateParent, privateRed, blue],
        wanted,
        {},
        clock
      )
    ).toEqual([])
  })

  it("shares exact-family context and preserves no-op reconciliation identity", () => {
    const { parent, red, blue, records } = family()
    const selected = filterExactProductRecordsForRead(
      records,
      new Set([parent.addressId, red.addressId, blue.addressId]),
      {},
      clock
    )
    const context = selected[0]?.exactReadContext
    expect(context).toBeDefined()
    expect(selected.every((item) => item.exactReadContext === context)).toBe(
      true
    )
    expect(
      context?.records.every((item) => !item.family && !item.exactReadContext)
    ).toBe(true)
    expect(reconcileProductRecordsWithRevisions(selected, [red], clock)).toBe(
      selected
    )
    expect(reconcileProductRecordsWithDeletions(selected, [], clock)).toBe(
      selected
    )

    const revisedRed = record("red", { ...red.product, price: 7 }, 11)
    const revised = reconcileProductRecordsWithRevisions(
      selected,
      [revisedRed],
      clock
    )
    expect(
      revised.find((item) => item.addressId === red.addressId)?.eventId
    ).toBe(revisedRed.eventId)
    const revisedParent = revised.find(
      (item) => item.addressId === parent.addressId
    )
    expect(revisedParent?.family?.priceSummary.minimum?.product.price).toBe(7)
    expect(revisedParent?.family?.readEvidence).toMatchObject({
      fetchedAt: clock(),
      stale: true,
      degraded: true,
    })
    expect(selected[0]?.family?.priceSummary.minimum?.product.price).toBe(10)
  })

  it("rebuilds families only for exact-author deletion evidence", () => {
    const { parent, red, blue, records } = family()
    const selected = filterExactProductRecordsForRead(
      records,
      new Set(records.map((item) => item.addressId)),
      {},
      clock
    )
    const readEvidence = selected[0]!.family!.readEvidence
    const deletion = {
      target: "event" as const,
      deletionEventId: "d".repeat(64),
      authorPubkey: author,
      eventId: red.eventId,
      deletedAt: 11,
    }
    expect(
      reconcileProductRecordsWithDeletions(
        selected,
        [{ ...deletion, authorPubkey: "b".repeat(64) }],
        clock
      )
    ).toBe(selected)
    const remaining = reconcileProductRecordsWithDeletions(
      selected,
      [deletion],
      clock
    )
    expect(remaining.map((item) => item.addressId)).toEqual([
      parent.addressId,
      blue.addressId,
    ])
    expect(
      remaining[0]?.family?.children.map((item) => item.addressId)
    ).toEqual([blue.addressId])
    expect(remaining[0]?.family?.readEvidence).toBe(readEvidence)
    expect(
      reconcileProductRecordsWithDeletions(
        [red],
        [
          {
            target: "address",
            deletionEventId: "e".repeat(64),
            authorPubkey: author,
            addressId: red.addressId,
            deletedAt: 9,
          },
        ],
        clock
      )[0]
    ).toBe(red)
  })

  it("retains deterministic revision winners and normalized source provenance", () => {
    const older = {
      ...record("simple"),
      eventId: "2".repeat(64),
      sourceRelayUrls: [" wss://one.example "],
    }
    const winner = {
      ...record("simple"),
      eventId: "1".repeat(64),
      sourceRelayUrls: ["wss://two.example", "wss://one.example"],
    }
    const merged = mergeProductRecordSources(older, winner)
    expect(merged.eventId).toBe(winner.eventId)
    expect(merged.sourceRelayUrls).toEqual([
      "wss://two.example",
      "wss://one.example",
    ])
    expect(mergeProductRecordSources(winner, older).eventId).toBe(
      winner.eventId
    )
    expect(
      mergeProductRecordSources(winner, { ...older, eventCreatedAt: 11 })
        .eventId
    ).toBe(older.eventId)
    expect(
      getProductLookupIds(encodeURIComponent(winner.addressId)).addressId
    ).toBe(winner.addressId)
    expect(getProductLookupIds("%invalid").address).toBeNull()
  })
})
