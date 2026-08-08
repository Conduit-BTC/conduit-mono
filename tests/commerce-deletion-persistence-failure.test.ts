import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { NDKEvent } from "@nostr-dev-kit/ndk"
import { finalizeEvent, getPublicKey } from "nostr-tools/pure"

import {
  __resetCommerceTestOverrides,
  __resetRelayListTestOverrides,
  __setCommerceTestOverrides,
  __setRelayListTestOverrides,
  cacheSignedProductListingEvent,
  EVENT_KINDS,
  getMarketplaceProducts,
  type CachedProduct,
  type CachedProductTombstone,
} from "@conduit/core"

const FIXED_NOW = 1_700_000_000_000
const MERCHANT_SECRET = new Uint8Array(32).fill(31)
const MERCHANT_PUBKEY = getPublicKey(MERCHANT_SECRET)
const PRODUCT_ADDRESS = `${EVENT_KINDS.PRODUCT}:${MERCHANT_PUBKEY}:persistence-failure`

let cachedProducts: CachedProduct[] = []
let cachedTombstones: CachedProductTombstone[] = []

function makeProduct(): NDKEvent {
  return new NDKEvent(
    undefined,
    finalizeEvent(
      {
        kind: EVENT_KINDS.PRODUCT,
        created_at: 100,
        content: "A product deleted while local persistence is unavailable.",
        tags: [
          ["d", "persistence-failure"],
          ["title", "Persistence failure product"],
          ["price", "25", "USD"],
          ["type", "simple", "physical"],
          ["image", "https://example.com/persistence-failure.png"],
        ],
      },
      MERCHANT_SECRET
    )
  )
}

describe("remote product deletion persistence failures", () => {
  beforeEach(() => {
    __resetCommerceTestOverrides()
    __resetRelayListTestOverrides()
    cachedProducts = []
    cachedTombstones = []
  })

  afterEach(() => {
    __resetCommerceTestOverrides()
    __resetRelayListTestOverrides()
    cachedProducts = []
    cachedTombstones = []
  })

  it("retains validated tombstone evidence for the session when persistence fails", async () => {
    const product = makeProduct()
    const deletion = new NDKEvent(
      undefined,
      finalizeEvent(
        {
          kind: EVENT_KINDS.DELETION,
          created_at: 110,
          content: "",
          tags: [
            ["e", product.id],
            ["a", PRODUCT_ADDRESS],
          ],
        },
        MERCHANT_SECRET
      )
    )
    let tombstoneWriteAttempts = 0
    let deletionReadAttempts = 0
    let failTombstoneWrites = true
    let omitDeletionFromRelay = false

    __setRelayListTestOverrides({
      loadCached: async (pubkey) => ({
        pubkey,
        readRelayUrls: ["wss://merchant-read.example"],
        writeRelayUrls: ["wss://merchant-write.example"],
        eventCreatedAt: 1,
        cachedAt: FIXED_NOW,
      }),
    })
    __setCommerceTestOverrides({
      now: () => FIXED_NOW,
      getCachedProducts: async (merchantPubkey, authorPubkeys) =>
        cachedProducts.filter(
          (row) =>
            (!merchantPubkey || row.pubkey === merchantPubkey) &&
            (!authorPubkeys || authorPubkeys.includes(row.pubkey))
        ),
      putCachedProducts: async (rows) => {
        for (const row of rows) {
          cachedProducts = [
            ...cachedProducts.filter((existing) => existing.id !== row.id),
            row,
          ]
        }
      },
      getCachedProductTombstones: async () => cachedTombstones,
      putCachedProductTombstones: async (rows) => {
        tombstoneWriteAttempts += 1
        if (failTombstoneWrites) {
          throw new Error("simulated IndexedDB write failure")
        }
        cachedTombstones = rows
      },
    })
    await cacheSignedProductListingEvent(product)
    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) => {
        if (filter.kinds?.includes(EVENT_KINDS.PRODUCT)) return [product]
        if (filter.kinds?.includes(EVENT_KINDS.DELETION)) {
          deletionReadAttempts += 1
          return omitDeletionFromRelay ? [] : [deletion]
        }
        return []
      },
    })

    const initialResult = await getMarketplaceProducts({
      merchantPubkey: MERCHANT_PUBKEY,
    })
    const writeAttemptsAfterObservation = tombstoneWriteAttempts
    const deletionReadsAfterObservation = deletionReadAttempts
    failTombstoneWrites = false
    omitDeletionFromRelay = true
    const subsequentResult = await getMarketplaceProducts({
      merchantPubkey: MERCHANT_PUBKEY,
    })

    expect(writeAttemptsAfterObservation).toBeGreaterThan(0)
    expect(tombstoneWriteAttempts).toBeGreaterThan(
      writeAttemptsAfterObservation
    )
    expect(deletionReadAttempts).toBeGreaterThan(deletionReadsAfterObservation)
    expect(cachedTombstones).toHaveLength(2)
    expect(
      cachedTombstones.every(
        (row) => row.deletionEventId === deletion.id && !row.observedLocally
      )
    ).toBe(true)
    expect(cachedProducts.map((row) => row.id)).toEqual([PRODUCT_ADDRESS])
    expect(initialResult.data).toEqual([])
    expect(subsequentResult.data).toEqual([])
  })
})
