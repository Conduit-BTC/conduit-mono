import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { NDKEvent } from "@nostr-dev-kit/ndk"
import { finalizeEvent, getPublicKey } from "nostr-tools/pure"
import {
  __resetCommerceTestOverrides,
  __resetRelayListTestOverrides,
  __setCommerceTestOverrides,
  __setRelayListTestOverrides,
  EVENT_KINDS,
  getMerchantStorefront,
  planProductDeletionRelays,
} from "@conduit/core"
import { attachEventSourceRelayUrl } from "@conduit/core/protocol/ndk"
import type { CachedProduct, CachedProductTombstone } from "@conduit/core"

const FIXED_NOW = 1_700_000_000_000
const MERCHANT_SECRET = new Uint8Array(32).fill(21)
const MERCHANT_PUBKEY = getPublicKey(MERCHANT_SECRET)

let cachedProducts: CachedProduct[] = []
let cachedProductTombstones: CachedProductTombstone[] = []
let relayProducts: NDKEvent[] = []

function makeSignedProduct(params: {
  dTag: string
  createdAt: number
  title: string
}): NDKEvent {
  const event = finalizeEvent(
    {
      kind: EVENT_KINDS.PRODUCT,
      created_at: params.createdAt,
      content: JSON.stringify({
        id: `${EVENT_KINDS.PRODUCT}:${MERCHANT_PUBKEY}:${params.dTag}`,
        pubkey: MERCHANT_PUBKEY,
        title: params.title,
        price: 25,
        currency: "USD",
        type: "simple",
        visibility: "public",
        images: [{ url: "https://example.com/product.png" }],
        tags: ["regression"],
        createdAt: params.createdAt * 1000,
        updatedAt: params.createdAt * 1000,
      }),
      tags: [
        ["d", params.dTag],
        ["title", params.title],
        ["price", "25", "USD"],
        ["t", "regression"],
      ],
    },
    MERCHANT_SECRET
  )

  return new NDKEvent(undefined, event)
}

beforeEach(() => {
  __resetCommerceTestOverrides()
  __resetRelayListTestOverrides()
  cachedProducts = []
  cachedProductTombstones = []
  relayProducts = []

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
    fetchEventsFanout: async (filter) =>
      filter.kinds?.includes(EVENT_KINDS.PRODUCT)
        ? (relayProducts as never)
        : [],
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
    getCachedProductTombstones: async (merchantPubkey, authorPubkeys) =>
      cachedProductTombstones.filter(
        (row) =>
          (!merchantPubkey || row.pubkey === merchantPubkey) &&
          (!authorPubkeys || authorPubkeys.includes(row.pubkey))
      ),
    putCachedProductTombstones: async (rows) => {
      for (const row of rows) {
        cachedProductTombstones = [
          ...cachedProductTombstones.filter(
            (existing) => existing.id !== row.id
          ),
          row,
        ]
      }
    },
  })
})

afterEach(() => {
  __resetCommerceTestOverrides()
  __resetRelayListTestOverrides()
})

describe("product deletion source fanout", () => {
  it("preserves source observations across reads and listing versions", async () => {
    const older = makeSignedProduct({
      dTag: "source-union",
      createdAt: 100,
      title: "Older source copy",
    })
    attachEventSourceRelayUrl(older, "wss://old-source.example")
    relayProducts = [older]

    const firstRead = await getMerchantStorefront({
      merchantPubkey: MERCHANT_PUBKEY,
      includeMarketHidden: true,
    })
    expect(firstRead.data[0]?.sourceRelayUrls).toEqual([
      "wss://old-source.example",
    ])

    const newer = makeSignedProduct({
      dTag: "source-union",
      createdAt: 200,
      title: "Newer source copy",
    })
    attachEventSourceRelayUrl(newer, "wss://new-source.example")
    relayProducts = [newer]

    const secondRead = await getMerchantStorefront({
      merchantPubkey: MERCHANT_PUBKEY,
      includeMarketHidden: true,
    })
    expect(secondRead.data).toHaveLength(1)
    expect(secondRead.data[0]?.eventId).toBe(newer.id)
    expect([...(secondRead.data[0]?.sourceRelayUrls ?? [])].sort()).toEqual([
      "wss://new-source.example",
      "wss://old-source.example",
    ])
    expect(cachedProducts).toHaveLength(1)
    expect([...(cachedProducts[0]?.sourceRelayUrls ?? [])].sort()).toEqual([
      "wss://new-source.example",
      "wss://old-source.example",
    ])

    const plan = planProductDeletionRelays({
      currentWriteRelayUrls: ["wss://current-write.example"],
      sourceRelayUrls: secondRead.data[0]?.sourceRelayUrls ?? [],
      canonicalConduitRelayUrl: "wss://relay.conduit.market",
    })
    expect(plan.map(({ relayUrl }) => relayUrl)).toEqual([
      "wss://current-write.example",
      "wss://new-source.example",
      "wss://old-source.example",
      "wss://relay.conduit.market",
    ])
  })
})
