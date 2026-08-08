import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { NDKEvent, nip19 } from "@nostr-dev-kit/ndk"
import { finalizeEvent, getPublicKey } from "nostr-tools/pure"
import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  cacheParsedOrderMessage,
  getBuyerConversationList,
  getCachedBuyerConversationList,
  getCachedMerchantConversationList,
  getCachedMerchantStorefront,
  getCachedMarketplaceProducts,
  cacheSignedProductDeletionEvent,
  cacheSignedProductListingEvent,
  getConversationDetail,
  getMarketplaceProducts,
  getMarketplaceProductsProgressive,
  getMerchantConversationList,
  getMerchantStorefront,
  getProductDetail,
  getProductsByIds,
  getProfiles,
  __resetRelayListTestOverrides,
  __setRelayListTestOverrides,
} from "@conduit/core"
import { EVENT_KINDS } from "@conduit/core"
import type {
  CachedOrderMessage,
  CachedProduct,
  CachedProductTombstone,
  CachedProfile,
} from "@conduit/core"

const FIXED_NOW = 1_700_000_000_000
const MERCHANT_A_SECRET = new Uint8Array(32).fill(1)
const MERCHANT_B_SECRET = new Uint8Array(32).fill(2)
const MERCHANT_A_PUBKEY = getPublicKey(MERCHANT_A_SECRET)
let cachedProducts: CachedProduct[] = []
let cachedProductTombstones: CachedProductTombstone[] = []
let cachedProfiles = new Map<string, CachedProfile>()
let cachedOrderMessages: CachedOrderMessage[] = []

function makeProductEvent(params: {
  pubkey: string
  dTag: string
  id: string
  createdAt: number
  title: string
  stock?: number
}): {
  id: string
  kind: number
  pubkey: string
  created_at: number
  content: string
  sig: string
  tags: string[][]
} {
  return {
    id: params.id,
    kind: EVENT_KINDS.PRODUCT,
    pubkey: params.pubkey,
    created_at: params.createdAt,
    content: JSON.stringify({
      id: `30402:${params.pubkey}:${params.dTag}`,
      pubkey: params.pubkey,
      title: params.title,
      price: 25,
      currency: "USD",
      type: "simple",
      visibility: "public",
      images: [{ url: "https://example.com/product.png" }],
      tags: ["test"],
      stock: params.stock,
      createdAt: params.createdAt * 1000,
      updatedAt: params.createdAt * 1000,
    }),
    sig: "signed",
    tags: [
      ["d", params.dTag],
      ["title", params.title],
      ["price", "25", "USD"],
      ["t", "test"],
      ...(typeof params.stock === "number"
        ? [["stock", String(params.stock)]]
        : []),
    ],
  }
}

function makeSignedProductEvent(params: {
  secretKey?: Uint8Array
  dTag: string
  createdAt: number
  title: string
  stock?: number
}): NDKEvent {
  const secretKey = params.secretKey ?? MERCHANT_A_SECRET
  const pubkey = getPublicKey(secretKey)
  const signed = finalizeEvent(
    {
      kind: EVENT_KINDS.PRODUCT,
      created_at: params.createdAt,
      content: JSON.stringify({
        id: `30402:${pubkey}:${params.dTag}`,
        pubkey,
        title: params.title,
        price: 25,
        currency: "USD",
        type: "simple",
        visibility: "public",
        images: [{ url: "https://example.com/product.png" }],
        tags: ["test"],
        stock: params.stock,
        createdAt: params.createdAt * 1000,
        updatedAt: params.createdAt * 1000,
      }),
      tags: [
        ["d", params.dTag],
        ["title", params.title],
        ["price", "25", "USD"],
        ["t", "test"],
        ...(typeof params.stock === "number"
          ? [["stock", String(params.stock)]]
          : []),
      ],
    },
    secretKey
  )
  return new NDKEvent(undefined, signed)
}

function makeSignedDeletionEvent(params: {
  secretKey?: Uint8Array
  createdAt: number
  tags: string[][]
}): NDKEvent {
  const signed = finalizeEvent(
    {
      kind: EVENT_KINDS.DELETION,
      created_at: params.createdAt,
      content: "",
      tags: params.tags,
    },
    params.secretKey ?? MERCHANT_A_SECRET
  )
  return new NDKEvent(undefined, signed)
}

beforeEach(async () => {
  __resetCommerceTestOverrides()
  __resetRelayListTestOverrides()
  cachedProducts = []
  cachedProductTombstones = []
  cachedProfiles = new Map()
  cachedOrderMessages = []
  __setCommerceTestOverrides({
    now: () => FIXED_NOW,
    resolveInboxRelayUrls: async () => ["wss://inbox.example"],
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
    getCachedProfiles: async (pubkeys) =>
      pubkeys.map((pubkey) => cachedProfiles.get(pubkey)),
    putCachedProfiles: async (rows) => {
      for (const row of rows) {
        cachedProfiles.set(row.pubkey, row)
      }
    },
    getCachedOrderMessages: async (principalPubkey) =>
      cachedOrderMessages.filter(
        (row) =>
          row.recipientPubkey === principalPubkey ||
          row.senderPubkey === principalPubkey
      ),
    putCachedOrderMessages: async (rows) => {
      for (const row of rows) {
        cachedOrderMessages = [
          ...cachedOrderMessages.filter((existing) => existing.id !== row.id),
          row,
        ]
      }
    },
    getCachedDirectMessages: async () => [],
    putCachedDirectMessages: async () => {},
  })
})

afterEach(async () => {
  __resetCommerceTestOverrides()
  __resetRelayListTestOverrides()
  cachedProducts = []
  cachedProductTombstones = []
  cachedProfiles = new Map()
  cachedOrderMessages = []
})

describe("commerce gateway", () => {
  it("passes author filters for perspective-scoped marketplace discovery", async () => {
    const productEvents = [
      makeProductEvent({
        pubkey: "merchant-a",
        dTag: "item-a",
        id: "event-a",
        createdAt: 101,
        title: "Item A",
      }),
      makeProductEvent({
        pubkey: "merchant-b",
        dTag: "item-b",
        id: "event-b",
        createdAt: 102,
        title: "Item B",
      }),
    ]
    let seenAuthors: string[] | undefined

    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) => {
        if (filter.kinds?.includes(EVENT_KINDS.PRODUCT)) {
          seenAuthors = filter.authors
          return productEvents as never
        }

        return []
      },
    })

    const result = await getMarketplaceProducts({
      authorPubkeys: ["merchant-a"],
      sort: "newest",
    })

    expect(seenAuthors).toEqual(["merchant-a"])
    expect(result.data.map((record) => record.product.pubkey)).toEqual([
      "merchant-a",
    ])
  })

  it("searches products globally when no perspective authors are supplied", async () => {
    const productEvents = [
      makeProductEvent({
        pubkey: "merchant-a",
        dTag: "other-item",
        id: "global-search-event-a",
        createdAt: 101,
        title: "Other item",
      }),
      makeProductEvent({
        pubkey: "merchant-b",
        dTag: "test-shirt",
        id: "global-search-event-b",
        createdAt: 102,
        title: "Test t-shirt",
      }),
    ]
    let seenAuthors: string[] | undefined

    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) => {
        if (filter.kinds?.includes(EVENT_KINDS.PRODUCT)) {
          seenAuthors = filter.authors
          return productEvents as never
        }
        return []
      },
    })

    const result = await getMarketplaceProducts({ textQuery: "test t-shirt" })

    expect(seenAuthors).toBeUndefined()
    expect(result.data.map((record) => record.product.title)).toEqual([
      "Test t-shirt",
    ])
  })

  it("keeps same d-tag listings from different merchants separate", async () => {
    const productEvents = [
      makeProductEvent({
        pubkey: "merchant-a",
        dTag: "shared-item",
        id: "event-a",
        createdAt: 101,
        title: "Merchant A Item",
      }),
      makeProductEvent({
        pubkey: "merchant-b",
        dTag: "shared-item",
        id: "event-b",
        createdAt: 102,
        title: "Merchant B Item",
      }),
    ]

    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) =>
        filter.kinds?.includes(EVENT_KINDS.PRODUCT)
          ? (productEvents as never)
          : [],
    })

    const result = await getMarketplaceProducts({ sort: "newest" })

    expect(result.data.map((record) => record.addressId).sort()).toEqual([
      "30402:merchant-a:shared-item",
      "30402:merchant-b:shared-item",
    ])
  })

  it("falls back to local cached marketplace products without changing shape", async () => {
    cachedProducts.push({
      id: "30402:merchant:cached-item",
      pubkey: "merchant",
      title: "Cached Item",
      summary: "cached summary",
      price: 25,
      currency: "USD",
      type: "simple",
      visibility: "public",
      images: [{ url: "https://example.com/cached-item.png" }],
      tags: ["cached"],
      createdAt: FIXED_NOW - 5_000,
      updatedAt: FIXED_NOW - 5_000,
      cachedAt: FIXED_NOW - 1_000,
    })

    __setCommerceTestOverrides({
      fetchEventsFanout: async () => {
        throw new Error("relay unavailable")
      },
    })

    const result = await getMarketplaceProducts({ limit: 10 })

    expect(result.meta.source).toBe("local_cache")
    expect(result.meta.stale).toBe(true)
    expect(result.data).toHaveLength(1)
    expect(result.data[0]?.product.title).toBe("Cached Item")
  })

  it("normalizes JSON-shaped summaries restored from the product cache", async () => {
    cachedProducts.push({
      id: "30402:merchant:cached-json-summary",
      pubkey: "merchant",
      title: "Love, Love, Love",
      summary: JSON.stringify({
        title: "Love, Love, Love",
        description: "Nutti loves Ecash",
        pricing: "free",
      }),
      price: 0,
      currency: "SATS",
      type: "simple",
      visibility: "public",
      images: [{ url: "https://example.com/cached-json-summary.png" }],
      tags: [" Ecash ", "ecash", "BITCOIN"],
      createdAt: FIXED_NOW - 5_000,
      updatedAt: FIXED_NOW - 5_000,
      cachedAt: FIXED_NOW - 1_000,
    })

    const result = await getCachedMarketplaceProducts()

    expect(result.data[0]?.product.summary).toBe("Nutti loves Ecash")
    expect(result.data[0]?.product.tags).toEqual(["ecash", "bitcoin"])

    const filtered = await getCachedMarketplaceProducts({
      tags: [" BITCOIN "],
    })
    expect(filtered.data.map((record) => record.product.id)).toEqual([
      "30402:merchant:cached-json-summary",
    ])
  })

  it("scopes cached marketplace reads to the requested author set at the loader", async () => {
    for (const pubkey of ["merchant-a", "merchant-b", "merchant-c"]) {
      cachedProducts.push({
        id: `30402:${pubkey}:item`,
        pubkey,
        title: `Item ${pubkey}`,
        summary: "",
        price: 10,
        currency: "USD",
        type: "simple",
        visibility: "public",
        images: [{ url: `https://example.com/${pubkey}.png` }],
        tags: [],
        createdAt: FIXED_NOW - 5_000,
        updatedAt: FIXED_NOW - 5_000,
        cachedAt: FIXED_NOW - 1_000,
      })
    }

    // Assert at the loader seam: the cache read must forward the author set to
    // the (Dexie-indexed) loader, not scope only via the post-read query filter.
    // A regression to an unscoped `toArray()` would leave seenAuthorPubkeys
    // undefined and fail here even though productMatchesQuery would still trim.
    let seenAuthorPubkeys: readonly string[] | undefined
    __setCommerceTestOverrides({
      getCachedProducts: async (merchantPubkey, authorPubkeys) => {
        seenAuthorPubkeys = authorPubkeys
        return cachedProducts.filter(
          (row) =>
            (!merchantPubkey || row.pubkey === merchantPubkey) &&
            (!authorPubkeys || authorPubkeys.includes(row.pubkey))
        )
      },
    })

    const result = await getCachedMarketplaceProducts({
      authorPubkeys: ["merchant-a", "merchant-b"],
    })

    expect(seenAuthorPubkeys).toEqual(["merchant-a", "merchant-b"])
    expect(result.data.map((record) => record.product.pubkey).sort()).toEqual([
      "merchant-a",
      "merchant-b",
    ])
  })

  it("keeps merchant storefront reads deletion-aware", async () => {
    const merchantPubkey = "merchant"
    const productEvent = makeProductEvent({
      pubkey: merchantPubkey,
      dTag: "deleted-item",
      id: "event-1",
      createdAt: 100,
      title: "Deleted Item",
    })

    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) => {
        if (filter.kinds?.includes(EVENT_KINDS.PRODUCT)) {
          return [productEvent as never]
        }

        if (filter.kinds?.includes(EVENT_KINDS.DELETION)) {
          return [
            {
              id: "delete-1",
              pubkey: merchantPubkey,
              created_at: 101,
              content: "",
              tags: [["a", `30402:${merchantPubkey}:deleted-item`]],
            } as never,
          ]
        }

        return []
      },
    })

    const result = await getMerchantStorefront({ merchantPubkey, limit: 10 })

    expect(result.data).toHaveLength(0)
  })

  it("lets storefront reads skip broad deletion fallback for faster first paint", async () => {
    const merchantPubkey = "merchant"
    const productEvent = makeProductEvent({
      pubkey: merchantPubkey,
      dTag: "live-item",
      id: "event-live",
      createdAt: 100,
      title: "Live Item",
    })
    const deletionFilters: Array<Record<string, unknown>> = []

    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) => {
        if (filter.kinds?.includes(EVENT_KINDS.PRODUCT)) {
          return [productEvent as never]
        }

        if (filter.kinds?.includes(EVENT_KINDS.DELETION)) {
          deletionFilters.push(filter as Record<string, unknown>)
        }

        return []
      },
    })

    const result = await getMerchantStorefront({
      merchantPubkey,
      limit: 10,
      deletionReadPolicy: {
        maxRelays: 4,
        connectTimeoutMs: 250,
        fetchTimeoutMs: 500,
      },
      deletionFallbackWhenEmpty: false,
    })

    expect(result.data).toHaveLength(1)
    expect(result.data[0]?.product.title).toBe("Live Item")
    expect(deletionFilters).toHaveLength(2)
    expect(
      deletionFilters.every((filter) => "#e" in filter || "#a" in filter)
    ).toBe(true)
  })

  it("does not let an empty merchant live read blank cached products", async () => {
    cachedProducts.push({
      id: "30402:merchant:cached-item",
      pubkey: "merchant",
      title: "Cached Item",
      summary: "cached summary",
      price: 25,
      currency: "USD",
      type: "simple",
      visibility: "public",
      images: [{ url: "https://example.com/cached-item.png" }],
      tags: ["cached"],
      createdAt: FIXED_NOW - 5_000,
      updatedAt: FIXED_NOW - 5_000,
      cachedAt: FIXED_NOW - 1_000,
    })

    __setCommerceTestOverrides({
      fetchEventsFanout: async () => [],
    })

    const result = await getMerchantStorefront({
      merchantPubkey: "merchant",
      limit: 10,
    })

    expect(result.meta.source).toBe("local_cache")
    expect(result.meta.stale).toBe(true)
    expect(result.data).toHaveLength(1)
    expect(result.data[0]?.product.title).toBe("Cached Item")
  })

  it("removes cached merchant products when deletion truth targets the address", async () => {
    const merchantPubkey = "merchant"
    cachedProducts.push({
      id: `30402:${merchantPubkey}:deleted-cached-item`,
      pubkey: merchantPubkey,
      title: "Deleted Cached Item",
      summary: "cached summary",
      price: 25,
      currency: "USD",
      type: "simple",
      visibility: "public",
      images: [{ url: "https://example.com/deleted-cached-item.png" }],
      tags: ["cached"],
      createdAt: 100_000,
      updatedAt: 100_000,
      cachedAt: FIXED_NOW - 1_000,
    })

    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) => {
        if (filter.kinds?.includes(EVENT_KINDS.DELETION)) {
          return [
            {
              id: "delete-cached-1",
              pubkey: merchantPubkey,
              created_at: 101,
              content: "",
              tags: [["a", `30402:${merchantPubkey}:deleted-cached-item`]],
            } as never,
          ]
        }

        return []
      },
    })

    const result = await getMerchantStorefront({ merchantPubkey, limit: 10 })

    expect(result.data).toHaveLength(0)
  })

  it("materializes signed product publishes in the local cache before relay readback", async () => {
    const signedProduct = makeSignedProductEvent({
      dTag: "signed-local-item",
      createdAt: 100,
      title: "Signed Local Item",
    })
    const merchantPubkey = signedProduct.pubkey
    await cacheSignedProductListingEvent(signedProduct)

    const result = await getCachedMerchantStorefront({
      merchantPubkey,
      limit: 10,
      includeMarketHidden: true,
    })

    expect(result.data).toHaveLength(1)
    expect(result.data[0]?.addressId).toBe(
      `30402:${merchantPubkey}:signed-local-item`
    )
    expect(result.data[0]?.product.title).toBe("Signed Local Item")
  })

  it("refuses to project an invalid product signature as local truth", async () => {
    const invalid = makeSignedProductEvent({
      dTag: "invalid-signature-item",
      createdAt: 100,
      title: "Invalid Signature Item",
    })
    invalid.sig = "00".repeat(64)

    await expect(cacheSignedProductListingEvent(invalid)).rejects.toThrow(
      "valid signed product listing"
    )
    expect(cachedProducts).toHaveLength(0)
  })

  it("refuses to persist an invalid deletion signature as a local tombstone", async () => {
    const invalid = makeSignedDeletionEvent({
      createdAt: 101,
      tags: [["a", `30402:${MERCHANT_A_PUBKEY}:invalid-deletion`]],
    })
    invalid.sig = "00".repeat(64)

    await expect(cacheSignedProductDeletionEvent(invalid)).rejects.toThrow(
      "valid signed product deletion"
    )
    expect(cachedProductTombstones).toHaveLength(0)
  })

  it("keeps a newer signed local publish ahead of stale relay readback", async () => {
    const dTag = "edited-item"
    const localProduct = makeSignedProductEvent({
      dTag,
      createdAt: 102,
      title: "Locally Edited Item",
    })
    const merchantPubkey = localProduct.pubkey
    await cacheSignedProductListingEvent(localProduct)

    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) => {
        if (filter.kinds?.includes(EVENT_KINDS.PRODUCT)) {
          return [
            makeProductEvent({
              pubkey: merchantPubkey,
              dTag,
              id: "event-relay-old",
              createdAt: 100,
              title: "Stale Relay Item",
            }) as never,
          ]
        }
        return []
      },
    })

    const result = await getMerchantStorefront({ merchantPubkey, limit: 10 })

    expect(result.data).toHaveLength(1)
    expect(result.data[0]?.eventId).toBe(localProduct.id)
    expect(result.data[0]?.product.title).toBe("Locally Edited Item")
    expect(cachedProducts[0]?.eventId).toBe(localProduct.id)
  })

  it("keeps newer local sold-out stock ahead of stale relay detail and batch reads", async () => {
    const dTag = "consecutive-stock-update"
    const localProduct = makeSignedProductEvent({
      dTag,
      createdAt: 102,
      title: "Locally Sold Out",
      stock: 0,
    })
    const merchantPubkey = localProduct.pubkey
    const addressId = `30402:${merchantPubkey}:${dTag}`
    await cacheSignedProductListingEvent(localProduct)

    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) => {
        if (filter.kinds?.includes(EVENT_KINDS.PRODUCT)) {
          return [
            makeProductEvent({
              pubkey: merchantPubkey,
              dTag,
              id: "event-relay-stock-12",
              createdAt: 100,
              title: "Stale Relay In Stock",
              stock: 12,
            }) as never,
          ]
        }
        return []
      },
    })

    const detail = await getProductDetail({
      productId: addressId,
      includeMarketHidden: true,
    })
    const batch = await getProductsByIds([addressId])

    expect(detail.data?.eventId).toBe(localProduct.id)
    expect(detail.data?.product.stock).toBe(0)
    expect(detail.meta.stale).toBe(false)
    expect(detail.meta.degraded).toBe(false)
    expect(batch.data[0]?.eventId).toBe(localProduct.id)
    expect(batch.data[0]?.product.stock).toBe(0)
    expect(cachedProducts[0]?.eventId).toBe(localProduct.id)
  })

  it("marks a mixed live and cached product batch as stale", async () => {
    const liveProduct = makeSignedProductEvent({
      secretKey: MERCHANT_A_SECRET,
      dTag: "live-batch-item",
      createdAt: 102,
      title: "Live Batch Item",
      stock: 4,
    })
    const cachedProduct = makeSignedProductEvent({
      secretKey: MERCHANT_B_SECRET,
      dTag: "cached-batch-item",
      createdAt: 101,
      title: "Cached Batch Item",
      stock: 3,
    })
    await cacheSignedProductListingEvent(liveProduct)
    await cacheSignedProductListingEvent(cachedProduct)

    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) =>
        filter.kinds?.includes(EVENT_KINDS.PRODUCT)
          ? ([liveProduct.rawEvent()] as never)
          : [],
    })

    const result = await getProductsByIds([
      `30402:${liveProduct.pubkey}:live-batch-item`,
      `30402:${cachedProduct.pubkey}:cached-batch-item`,
    ])

    expect(result.data).toHaveLength(2)
    expect(result.meta.source).toBe("local_cache")
    expect(result.meta.stale).toBe(true)
    expect(result.meta.degraded).toBe(true)
  })

  it("uses the lower event id to resolve same-timestamp product versions", async () => {
    const dTag = "same-second-edit"
    const versions = [
      makeSignedProductEvent({
        dTag,
        createdAt: 102,
        title: "Same Timestamp Version A",
      }),
      makeSignedProductEvent({
        dTag,
        createdAt: 102,
        title: "Same Timestamp Version B",
      }),
    ].sort((left, right) => left.id.localeCompare(right.id))
    const winner = versions[0]!
    const loser = versions[1]!
    const merchantPubkey = winner.pubkey
    await cacheSignedProductListingEvent(winner)

    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) => {
        if (filter.kinds?.includes(EVENT_KINDS.PRODUCT)) {
          return [loser as never]
        }
        return []
      },
    })

    const result = await getMerchantStorefront({ merchantPubkey, limit: 10 })

    expect(result.data).toHaveLength(1)
    expect(result.data[0]?.eventId).toBe(winner.id)
    expect(result.data[0]?.product.title).toBe(JSON.parse(winner.content).title)
  })

  it("suppresses stale cached merchant products with local signed deletion tombstones", async () => {
    const merchantPubkey = MERCHANT_A_PUBKEY
    const addressId = `30402:${merchantPubkey}:locally-deleted-item`
    cachedProducts.push({
      id: addressId,
      pubkey: merchantPubkey,
      title: "Locally Deleted Item",
      summary: "cached summary",
      price: 25,
      currency: "USD",
      type: "simple",
      visibility: "public",
      images: [{ url: "https://example.com/locally-deleted-item.png" }],
      tags: ["cached"],
      createdAt: 100_000,
      updatedAt: 100_000,
      cachedAt: FIXED_NOW - 1_000,
    })

    await cacheSignedProductDeletionEvent(
      makeSignedDeletionEvent({
        createdAt: 101,
        tags: [
          ["e", "event-local-old"],
          ["a", addressId],
          ["k", String(EVENT_KINDS.PRODUCT)],
        ],
      })
    )

    const result = await getCachedMerchantStorefront({
      merchantPubkey,
      limit: 10,
      includeMarketHidden: true,
    })

    expect(result.data).toHaveLength(0)
  })

  it("suppresses stale direct product detail with a local signed tombstone", async () => {
    const dTag = "locally-deleted-detail"
    const staleProduct = makeSignedProductEvent({
      dTag,
      createdAt: 100,
      title: "Locally Deleted Detail",
    })
    const merchantPubkey = staleProduct.pubkey
    const addressId = `30402:${merchantPubkey}:${dTag}`

    await cacheSignedProductListingEvent(staleProduct)
    await cacheSignedProductDeletionEvent(
      makeSignedDeletionEvent({
        createdAt: 101,
        tags: [["a", addressId]],
      })
    )
    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) =>
        filter.kinds?.includes(EVENT_KINDS.PRODUCT)
          ? ([staleProduct] as never)
          : [],
    })

    const result = await getProductDetail({ productId: addressId })

    expect(result.data).toBeNull()
  })

  it("suppresses deleted products from batched live reads", async () => {
    const dTag = "locally-deleted-batch"
    const staleProduct = makeSignedProductEvent({
      dTag,
      createdAt: 100,
      title: "Locally Deleted Batch Item",
    })
    const addressId = `30402:${staleProduct.pubkey}:${dTag}`

    await cacheSignedProductDeletionEvent(
      makeSignedDeletionEvent({
        createdAt: 101,
        tags: [["a", addressId]],
      })
    )
    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) =>
        filter.kinds?.includes(EVENT_KINDS.PRODUCT)
          ? ([staleProduct] as never)
          : [],
    })

    const result = await getProductsByIds([addressId], {
      includeMarketHidden: true,
    })

    expect(result.meta.source).toBe("commerce")
    expect(result.data).toHaveLength(0)
  })

  it("keeps market-hidden products out of batched Market reads", async () => {
    const productEvent = makeProductEvent({
      pubkey: "merchant",
      dTag: "blocked-batch-item",
      id: "event-blocked-batch",
      createdAt: 100,
      title: "Counterfeit goods display sample",
    })
    const addressId = "30402:merchant:blocked-batch-item"

    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) =>
        filter.kinds?.includes(EVENT_KINDS.PRODUCT)
          ? ([productEvent] as never)
          : [],
    })

    const marketResult = await getProductsByIds([addressId])
    const merchantResult = await getProductsByIds([addressId], {
      includeMarketHidden: true,
    })

    expect(marketResult.data).toHaveLength(0)
    expect(merchantResult.data).toHaveLength(1)
    expect(merchantResult.data[0]?.safety?.state).toBe("blocked")
  })

  it("suppresses stale event-id product detail across local signed tombstones", async () => {
    const staleProduct = makeSignedProductEvent({
      dTag: "locally-deleted-event-detail",
      createdAt: 100,
      title: "Locally Deleted Event Detail",
    })
    const eventId = staleProduct.id

    await cacheSignedProductListingEvent(staleProduct)
    await cacheSignedProductDeletionEvent(
      makeSignedDeletionEvent({
        createdAt: 101,
        tags: [["e", eventId]],
      })
    )
    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) =>
        filter.kinds?.includes(EVENT_KINDS.PRODUCT)
          ? ([staleProduct] as never)
          : [],
    })

    const result = await getProductDetail({ productId: eventId })

    expect(result.data).toBeNull()
  })

  it("allows a newer local product publish to supersede an older tombstone", async () => {
    const merchantPubkey = MERCHANT_A_PUBKEY
    const dTag = "republished-item"
    const addressId = `30402:${merchantPubkey}:${dTag}`
    await cacheSignedProductDeletionEvent(
      makeSignedDeletionEvent({
        createdAt: 101,
        tags: [
          ["a", addressId],
          ["k", String(EVENT_KINDS.PRODUCT)],
        ],
      })
    )
    await cacheSignedProductListingEvent(
      makeSignedProductEvent({
        dTag,
        createdAt: 102,
        title: "Republished Item",
      })
    )

    const result = await getCachedMerchantStorefront({
      merchantPubkey,
      limit: 10,
      includeMarketHidden: true,
    })

    expect(result.data).toHaveLength(1)
    expect(result.data[0]?.product.title).toBe("Republished Item")
  })

  it("does not let an older deletion request replace a newer local tombstone", async () => {
    const merchantPubkey = MERCHANT_A_PUBKEY
    const dTag = "deleted-twice"
    const addressId = `30402:${merchantPubkey}:${dTag}`
    await cacheSignedProductListingEvent(
      makeSignedProductEvent({
        dTag,
        createdAt: 102,
        title: "Deleted Twice",
      })
    )
    await cacheSignedProductDeletionEvent(
      makeSignedDeletionEvent({
        createdAt: 103,
        tags: [["a", addressId]],
      })
    )
    await cacheSignedProductDeletionEvent(
      makeSignedDeletionEvent({
        createdAt: 101,
        tags: [["a", addressId]],
      })
    )

    const result = await getCachedMerchantStorefront({
      merchantPubkey,
      limit: 10,
      includeMarketHidden: true,
    })

    expect(result.data).toHaveLength(0)
    expect(cachedProductTombstones[0]?.deletedAt).toBe(103)
  })

  it("does not apply an event-id deletion request across authors", async () => {
    const product = makeSignedProductEvent({
      secretKey: MERCHANT_A_SECRET,
      dTag: "shared-event-id-target",
      createdAt: 100,
      title: "Merchant A Item",
    })
    await cacheSignedProductListingEvent(product)
    await cacheSignedProductDeletionEvent(
      makeSignedDeletionEvent({
        secretKey: MERCHANT_B_SECRET,
        createdAt: 101,
        tags: [["e", product.id]],
      })
    )

    const result = await getCachedMarketplaceProducts()

    expect(result.data).toHaveLength(1)
    expect(result.data[0]?.product.pubkey).toBe(MERCHANT_A_PUBKEY)
  })

  it("rejects cross-author address tombstones without a valid product target", async () => {
    await expect(
      cacheSignedProductDeletionEvent(
        makeSignedDeletionEvent({
          secretKey: MERCHANT_B_SECRET,
          createdAt: 101,
          tags: [["a", `30402:${MERCHANT_A_PUBKEY}:item`]],
        })
      )
    ).rejects.toThrow("valid product target")
  })

  it("keeps image-broken products manageable for Merchant but hidden from Market storefront reads", async () => {
    cachedProducts.push({
      id: "30402:merchant:needs-image",
      pubkey: "merchant",
      title: "Needs Image",
      summary: "cached summary",
      price: 25,
      currency: "USD",
      type: "simple",
      visibility: "public",
      images: [],
      tags: ["cached"],
      createdAt: FIXED_NOW - 5_000,
      updatedAt: FIXED_NOW - 5_000,
      cachedAt: FIXED_NOW - 1_000,
    })

    __setCommerceTestOverrides({
      fetchEventsFanout: async () => [],
    })

    const marketResult = await getMerchantStorefront({
      merchantPubkey: "merchant",
      limit: 10,
    })
    const merchantResult = await getMerchantStorefront({
      merchantPubkey: "merchant",
      includeMarketHidden: true,
      limit: 10,
    })

    expect(marketResult.data).toHaveLength(0)
    expect(merchantResult.data).toHaveLength(1)
    expect(merchantResult.data[0]?.product.title).toBe("Needs Image")
  })

  it("suppresses blocked launch-safety listings from Market while Merchant can inspect them", async () => {
    const productEvent = makeProductEvent({
      pubkey: "merchant",
      dTag: "blocked-item",
      id: "event-blocked",
      createdAt: 100,
      title: "Counterfeit goods display sample",
    })

    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) =>
        filter.kinds?.includes(EVENT_KINDS.PRODUCT)
          ? ([productEvent] as never)
          : [],
    })

    const marketResult = await getMerchantStorefront({
      merchantPubkey: "merchant",
      limit: 10,
    })
    const merchantResult = await getMerchantStorefront({
      merchantPubkey: "merchant",
      includeMarketHidden: true,
      limit: 10,
    })
    const publicDetail = await getProductDetail({
      productId: "30402:merchant:blocked-item",
    })
    const merchantDetail = await getProductDetail({
      productId: "30402:merchant:blocked-item",
      includeMarketHidden: true,
    })

    expect(marketResult.data).toHaveLength(0)
    expect(publicDetail.data).toBeNull()
    expect(merchantResult.data).toHaveLength(1)
    expect(merchantResult.data[0]?.safety?.state).toBe("blocked")
    expect(merchantDetail.data?.safety?.state).toBe("blocked")
  })

  it("keeps policy-warning listings visible in Market while Merchant can inspect the warning", async () => {
    const productEvent = makeProductEvent({
      pubkey: "merchant",
      dTag: "warning-item",
      id: "event-warning",
      createdAt: 100,
      title: "CBD wellness balm",
    })

    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) =>
        filter.kinds?.includes(EVENT_KINDS.PRODUCT)
          ? ([productEvent] as never)
          : [],
    })

    const marketResult = await getMerchantStorefront({
      merchantPubkey: "merchant",
      limit: 10,
    })
    const merchantResult = await getMerchantStorefront({
      merchantPubkey: "merchant",
      includeMarketHidden: true,
      limit: 10,
    })

    expect(marketResult.data).toHaveLength(1)
    expect(marketResult.data[0]?.safety?.state).toBe("flagged")
    expect(merchantResult.data).toHaveLength(1)
    expect(merchantResult.data[0]?.safety?.state).toBe("flagged")
  })

  it("does not resurrect an older cached active listing after a newer blocked replacement", async () => {
    cachedProducts.push({
      id: "30402:merchant:replacement-item",
      pubkey: "merchant",
      title: "Previously Safe Item",
      summary: "cached summary",
      price: 25,
      currency: "USD",
      type: "simple",
      visibility: "public",
      images: [{ url: "https://example.com/product.png" }],
      tags: ["cached"],
      createdAt: 100_000,
      updatedAt: 100_000,
      cachedAt: FIXED_NOW - 1_000,
    })
    const blockedEvent = makeProductEvent({
      pubkey: "merchant",
      dTag: "replacement-item",
      id: "event-blocked-replacement",
      createdAt: 200,
      title: "Counterfeit goods display sample",
    })

    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) =>
        filter.kinds?.includes(EVENT_KINDS.PRODUCT)
          ? ([blockedEvent] as never)
          : [],
    })

    const marketResult = await getMerchantStorefront({
      merchantPubkey: "merchant",
      limit: 10,
    })
    const merchantResult = await getMerchantStorefront({
      merchantPubkey: "merchant",
      includeMarketHidden: true,
      limit: 10,
    })

    expect(marketResult.data).toHaveLength(0)
    expect(merchantResult.data).toHaveLength(1)
    expect(merchantResult.data[0]?.product.title).toBe(
      "Counterfeit goods display sample"
    )
    expect(
      cachedProducts.find((row) => row.id === "30402:merchant:replacement-item")
        ?.title
    ).toBe("Counterfeit goods display sample")

    __setCommerceTestOverrides({
      fetchEventsFanout: async () => [],
    })

    const cachedMarketResult = await getMerchantStorefront({
      merchantPubkey: "merchant",
      limit: 10,
    })
    const cachedMerchantResult = await getMerchantStorefront({
      merchantPubkey: "merchant",
      includeMarketHidden: true,
      limit: 10,
    })

    expect(cachedMarketResult.data).toHaveLength(0)
    expect(cachedMerchantResult.data[0]?.safety?.state).toBe("blocked")
  })

  it("resolves product detail from a NIP-89 naddr handler URL", async () => {
    const merchantPubkey = "a".repeat(64)
    const dTag = "naddr-item"
    const productEvent = makeProductEvent({
      pubkey: merchantPubkey,
      dTag,
      id: "event-naddr",
      createdAt: 100,
      title: "Naddr Item",
    })
    const naddr = nip19.naddrEncode({
      kind: EVENT_KINDS.PRODUCT,
      pubkey: merchantPubkey,
      identifier: dTag,
    })

    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) => {
        if (
          filter.kinds?.includes(EVENT_KINDS.PRODUCT) &&
          filter.authors?.includes(merchantPubkey) &&
          filter["#d"]?.includes(dTag)
        ) {
          return [productEvent as never]
        }

        return []
      },
    })

    const result = await getProductDetail({ productId: naddr })

    expect(result.data?.product.title).toBe("Naddr Item")
    expect(result.data?.addressId).toBe(
      `${EVENT_KINDS.PRODUCT}:${merchantPubkey}:${dTag}`
    )
  })

  it("builds stable buyer conversation summaries from cached messages", async () => {
    cachedOrderMessages.push(
      {
        id: "order-msg",
        orderId: "order-1",
        type: "order",
        senderPubkey: "buyer",
        recipientPubkey: "merchant",
        createdAt: FIXED_NOW - 10_000,
        rawContent: JSON.stringify({
          id: "order-msg",
          orderId: "order-1",
          type: "order",
          createdAt: FIXED_NOW - 10_000,
          senderPubkey: "buyer",
          recipientPubkey: "merchant",
          rawContent: "",
          payload: {
            id: "order-1",
            merchantPubkey: "merchant",
            buyerPubkey: "buyer",
            items: [
              {
                productId: "30402:merchant:item",
                quantity: 1,
                priceAtPurchase: 25,
                currency: "USD",
              },
            ],
            subtotal: 25,
            currency: "USD",
            createdAt: FIXED_NOW - 10_000,
          },
        }),
        cachedAt: FIXED_NOW - 10_000,
      },
      {
        id: "status-msg",
        orderId: "order-1",
        type: "status_update",
        senderPubkey: "merchant",
        recipientPubkey: "buyer",
        createdAt: FIXED_NOW - 5_000,
        rawContent: JSON.stringify({
          id: "status-msg",
          orderId: "order-1",
          type: "status_update",
          createdAt: FIXED_NOW - 5_000,
          senderPubkey: "merchant",
          recipientPubkey: "buyer",
          rawContent: "",
          payload: {
            status: "paid",
          },
        }),
        cachedAt: FIXED_NOW - 5_000,
      }
    )

    __setCommerceTestOverrides({
      requireNdkConnected: async () => ({ signer: undefined }) as never,
    })

    const listResult = await getBuyerConversationList({
      principalPubkey: "buyer",
      limit: 50,
    })
    const detailResult = await getConversationDetail({
      principalPubkey: "buyer",
      orderId: "order-1",
      role: "buyer",
    })

    expect(listResult.meta.source).toBe("local_cache")
    expect(listResult.data).toHaveLength(1)
    expect(listResult.data[0]?.status).toBe("paid")
    expect(listResult.data[0]?.totalSummary).toBe("25 USD")
    expect(detailResult.meta.source).toBe("local_cache")
    expect(detailResult.data?.messages).toHaveLength(2)
  })

  it("separates buyer-placed and merchant-received orders by role", async () => {
    const orderRow = (
      orderId: string,
      sender: string,
      recipient: string
    ): CachedOrderMessage => ({
      id: `${orderId}-order`,
      orderId,
      type: "order",
      senderPubkey: sender,
      recipientPubkey: recipient,
      createdAt: FIXED_NOW - 10_000,
      rawContent: JSON.stringify({
        id: `${orderId}-order`,
        orderId,
        type: "order",
        createdAt: FIXED_NOW - 10_000,
        senderPubkey: sender,
        recipientPubkey: recipient,
        rawContent: "",
        payload: {
          id: orderId,
          merchantPubkey: recipient,
          buyerPubkey: sender,
          items: [
            {
              productId: "30402:x:item",
              quantity: 1,
              priceAtPurchase: 10,
              currency: "USD",
            },
          ],
          subtotal: 10,
          currency: "USD",
          createdAt: FIXED_NOW - 10_000,
        },
      }),
      cachedAt: FIXED_NOW - 10_000,
    })

    // "dual" is both a buyer (placed order-buy to a merchant) and a merchant
    // (received order-sell from a buyer); both land in its inbox cache.
    cachedOrderMessages.push(
      orderRow("order-buy", "dual", "other-merchant"),
      orderRow("order-sell", "other-buyer", "dual")
    )

    __setCommerceTestOverrides({
      requireNdkConnected: async () => ({ signer: undefined }) as never,
    })

    const asBuyer = await getCachedBuyerConversationList({
      principalPubkey: "dual",
    })
    const asMerchant = await getCachedMerchantConversationList({
      principalPubkey: "dual",
    })

    expect(asBuyer.data.map((row) => row.orderId)).toEqual(["order-buy"])
    expect(asBuyer.data[0]?.merchantPubkey).toBe("other-merchant")
    expect(asMerchant.data.map((row) => row.orderId)).toEqual(["order-sell"])
    expect(asMerchant.data[0]?.buyerPubkey).toBe("other-buyer")
  })

  it("excludes chat-only (ambiguous-role) buckets from both roles", async () => {
    // A `message` can come from either side, so a bucket holding only chat has
    // no determinable role and must not surface in either view.
    cachedOrderMessages.push({
      id: "orphan-chat",
      orderId: "orphan",
      type: "message",
      senderPubkey: "someone",
      recipientPubkey: "dual",
      createdAt: FIXED_NOW - 5_000,
      rawContent: JSON.stringify({
        id: "orphan-chat",
        orderId: "orphan",
        type: "message",
        createdAt: FIXED_NOW - 5_000,
        senderPubkey: "someone",
        recipientPubkey: "dual",
        rawContent: "",
        payload: { note: "hi" },
      }),
      cachedAt: FIXED_NOW - 5_000,
    })

    __setCommerceTestOverrides({
      requireNdkConnected: async () => ({ signer: undefined }) as never,
    })

    const asBuyer = await getCachedBuyerConversationList({
      principalPubkey: "dual",
    })
    const asMerchant = await getCachedMerchantConversationList({
      principalPubkey: "dual",
    })

    expect(asBuyer.data.map((row) => row.orderId)).not.toContain("orphan")
    expect(asMerchant.data.map((row) => row.orderId)).not.toContain("orphan")
  })

  it("excludes partial buckets with conflicting roles or counterparties", async () => {
    const partialRow = (
      id: string,
      orderId: string,
      type: "payment_proof" | "status_update",
      senderPubkey: string,
      recipientPubkey: string
    ): CachedOrderMessage => ({
      id,
      orderId,
      type,
      senderPubkey,
      recipientPubkey,
      createdAt: FIXED_NOW - 5_000,
      rawContent: JSON.stringify({
        id,
        orderId,
        type,
        createdAt: FIXED_NOW - 5_000,
        senderPubkey,
        recipientPubkey,
        rawContent: "",
        payload: type === "status_update" ? { status: "accepted" } : {},
      }),
      cachedAt: FIXED_NOW - 5_000,
    })

    cachedOrderMessages.push(
      partialRow(
        "role-proof",
        "role-conflict",
        "payment_proof",
        "dual",
        "counterparty"
      ),
      partialRow(
        "role-status",
        "role-conflict",
        "status_update",
        "dual",
        "counterparty"
      ),
      partialRow(
        "counterparty-proof-a",
        "counterparty-conflict",
        "payment_proof",
        "buyer-a",
        "dual"
      ),
      partialRow(
        "counterparty-proof-b",
        "counterparty-conflict",
        "payment_proof",
        "buyer-b",
        "dual"
      )
    )

    const asBuyer = await getCachedBuyerConversationList({
      principalPubkey: "dual",
    })
    const asMerchant = await getCachedMerchantConversationList({
      principalPubkey: "dual",
    })

    expect(asBuyer.data).toHaveLength(0)
    expect(asMerchant.data).toHaveLength(0)
  })

  it("persists buyer-originated order messages into the conversation cache", async () => {
    await cacheParsedOrderMessage({
      id: "local-order-msg",
      orderId: "order-2",
      type: "order",
      createdAt: FIXED_NOW - 1_000,
      senderPubkey: "buyer",
      recipientPubkey: "merchant",
      rawContent: JSON.stringify({
        id: "order-2",
        merchantPubkey: "merchant",
        buyerPubkey: "buyer",
        items: [
          {
            productId: "30402:merchant:item",
            quantity: 1,
            priceAtPurchase: 1250,
            currency: "SATS",
          },
        ],
        subtotal: 1250,
        currency: "SATS",
        createdAt: FIXED_NOW - 1_000,
      }),
      payload: {
        id: "order-2",
        merchantPubkey: "merchant",
        buyerPubkey: "buyer",
        items: [
          {
            productId: "30402:merchant:item",
            quantity: 1,
            priceAtPurchase: 1250,
            currency: "SATS",
          },
        ],
        subtotal: 1250,
        currency: "SATS",
        createdAt: FIXED_NOW - 1_000,
      },
    })

    __setCommerceTestOverrides({
      requireNdkConnected: async () => ({ signer: undefined }) as never,
    })

    const result = await getBuyerConversationList({
      principalPubkey: "buyer",
      limit: 50,
    })

    expect(result.meta.source).toBe("local_cache")
    expect(result.data).toHaveLength(1)
    expect(result.data[0]?.orderId).toBe("order-2")
    expect(result.data[0]?.merchantPubkey).toBe("merchant")
  })

  it("retries wrapped order messages that failed to unwrap before marking them seen", async () => {
    let unwrapCalls = 0
    const wrappedEvent = {
      id: "wrap-1",
      kind: EVENT_KINDS.GIFT_WRAP,
      pubkey: "merchant",
      created_at: 100,
      content: "wrapped",
      tags: [["p", "buyer"]],
    }
    const orderRumor = {
      id: "order-rumor-1",
      kind: EVENT_KINDS.ORDER,
      pubkey: "buyer",
      created_at: 101,
      content: JSON.stringify({
        id: "order-3",
        merchantPubkey: "merchant",
        buyerPubkey: "buyer",
        items: [
          {
            productId: "30402:merchant:item",
            quantity: 1,
            priceAtPurchase: 2100,
            currency: "SATS",
          },
        ],
        subtotal: 2100,
        currency: "SATS",
        createdAt: FIXED_NOW,
      }),
      tags: [
        ["p", "merchant"],
        ["type", "order"],
        ["order", "order-3"],
        ["amount", "2100"],
        ["currency", "SATS"],
      ],
    }

    __setCommerceTestOverrides({
      requireNdkConnected: async () => ({ signer: {} }) as never,
      fetchEventsFanout: async (filter) =>
        filter.kinds?.includes(EVENT_KINDS.GIFT_WRAP)
          ? ([wrappedEvent] as never)
          : [],
      giftUnwrap: async () => {
        unwrapCalls += 1
        return unwrapCalls === 1 ? null : (orderRumor as never)
      },
    })

    const first = await getBuyerConversationList({
      principalPubkey: "buyer",
      limit: 50,
    })
    const second = await getBuyerConversationList({
      principalPubkey: "buyer",
      limit: 50,
    })

    expect(first.data).toHaveLength(0)
    expect(unwrapCalls).toBe(2)
    expect(second.data).toHaveLength(1)
    expect(second.data[0]?.orderId).toBe("order-3")
  })

  it("keeps payment-proof-only merchant conversations visible without marking them paid", async () => {
    const merchantPubkey = "merchant"
    const buyerPubkey = "buyer"
    const wrappedEvent = {
      id: "wrap-proof-1",
      kind: EVENT_KINDS.GIFT_WRAP,
      pubkey: buyerPubkey,
      created_at: 100,
      content: "wrapped-proof",
      tags: [["p", merchantPubkey]],
    }
    const proofRumor = {
      id: "proof-rumor-1",
      kind: EVENT_KINDS.ORDER,
      pubkey: buyerPubkey,
      created_at: 101,
      content: JSON.stringify({
        orderId: "order-proof-1",
        rail: "lightning",
        action: "private_checkout",
        amount: 2100,
        currency: "SATS",
        invoice: "lnbc2100n1proof",
        preimage: "paid-preimage",
        paymentHash: "paid-hash",
        proofDeliveryStatus: "pending",
      }),
      tags: [
        ["p", merchantPubkey],
        ["type", "payment_proof"],
        ["order", "order-proof-1"],
        ["amount", "2100"],
        ["currency", "SATS"],
      ],
    }

    __setCommerceTestOverrides({
      requireNdkConnected: async () => ({ signer: {} }) as never,
      fetchEventsFanout: async (filter) =>
        filter.kinds?.includes(EVENT_KINDS.GIFT_WRAP)
          ? ([wrappedEvent] as never)
          : [],
      giftUnwrap: async () => proofRumor as never,
    })

    const result = await getMerchantConversationList({
      principalPubkey: merchantPubkey,
      limit: 50,
    })

    expect(result.data).toHaveLength(1)
    expect(result.data[0]?.orderId).toBe("order-proof-1")
    expect(result.data[0]?.buyerPubkey).toBe(buyerPubkey)
    expect(result.data[0]?.merchantPubkey).toBe(merchantPubkey)
    expect(result.data[0]?.latestType).toBe("payment_proof")
    expect(result.data[0]?.status).toBeNull()
  })

  it("keeps malformed payment-proof-only buckets visible but unpaid", async () => {
    const merchantPubkey = "merchant"
    const buyerPubkey = "buyer"
    const wrappedEvent = {
      id: "wrap-proof-malformed",
      kind: EVENT_KINDS.GIFT_WRAP,
      pubkey: buyerPubkey,
      created_at: 100,
      content: "wrapped-proof",
      tags: [["p", merchantPubkey]],
    }
    const proofRumor = {
      id: "proof-rumor-malformed",
      kind: EVENT_KINDS.ORDER,
      pubkey: buyerPubkey,
      created_at: 101,
      content: JSON.stringify({}),
      tags: [
        ["p", merchantPubkey],
        ["type", "payment_proof"],
        ["order", "order-proof-malformed"],
      ],
    }

    __setCommerceTestOverrides({
      requireNdkConnected: async () => ({ signer: {} }) as never,
      fetchEventsFanout: async (filter) =>
        filter.kinds?.includes(EVENT_KINDS.GIFT_WRAP)
          ? ([wrappedEvent] as never)
          : [],
      giftUnwrap: async () => proofRumor as never,
    })

    const result = await getMerchantConversationList({
      principalPubkey: merchantPubkey,
      limit: 50,
    })

    expect(result.data).toHaveLength(1)
    expect(result.data[0]?.orderId).toBe("order-proof-malformed")
    expect(result.data[0]?.status).toBeNull()
  })

  it("queries only the declared merchant inbox relays for gift-wrapped orders", async () => {
    const merchantPubkey = "merchant"
    const merchantReadRelays = Array.from(
      { length: 8 },
      (_, index) => `wss://merchant-read-${index}.example`
    )
    let seenRelayUrls: string[] | undefined

    __setRelayListTestOverrides({
      now: () => FIXED_NOW,
      loadCached: async (pubkey) =>
        pubkey === merchantPubkey
          ? {
              pubkey,
              readRelayUrls: merchantReadRelays,
              writeRelayUrls: [],
              eventCreatedAt: 1,
              cachedAt: FIXED_NOW,
            }
          : undefined,
    })
    __setCommerceTestOverrides({
      requireNdkConnected: async () => ({ signer: {} }) as never,
      resolveInboxRelayUrls: async () => merchantReadRelays,
      fetchEventsFanout: async (filter, options) => {
        if (filter.kinds?.includes(EVENT_KINDS.GIFT_WRAP)) {
          seenRelayUrls = options?.relayUrls
        }
        return []
      },
    })

    await getMerchantConversationList({
      principalPubkey: merchantPubkey,
      limit: 50,
    })

    expect(seenRelayUrls).toEqual(merchantReadRelays)
  })

  it("retries parsed wrapped order messages when cache persistence fails", async () => {
    let unwrapCalls = 0
    let putCalls = 0
    const wrappedEvent = {
      id: "wrap-cache-fail-1",
      kind: EVENT_KINDS.GIFT_WRAP,
      pubkey: "buyer",
      created_at: 100,
      content: "wrapped",
      tags: [["p", "merchant"]],
    }
    const orderRumor = {
      id: "order-rumor-cache-fail-1",
      kind: EVENT_KINDS.ORDER,
      pubkey: "buyer",
      created_at: 101,
      content: JSON.stringify({
        id: "order-cache-fail-1",
        merchantPubkey: "merchant",
        buyerPubkey: "buyer",
        items: [
          {
            productId: "30402:merchant:item",
            quantity: 1,
            priceAtPurchase: 2100,
            currency: "SATS",
          },
        ],
        subtotal: 2100,
        currency: "SATS",
        createdAt: FIXED_NOW,
      }),
      tags: [
        ["p", "merchant"],
        ["type", "order"],
        ["order", "order-cache-fail-1"],
        ["amount", "2100"],
        ["currency", "SATS"],
      ],
    }

    __setCommerceTestOverrides({
      requireNdkConnected: async () => ({ signer: {} }) as never,
      fetchEventsFanout: async (filter) =>
        filter.kinds?.includes(EVENT_KINDS.GIFT_WRAP)
          ? ([wrappedEvent] as never)
          : [],
      giftUnwrap: async () => {
        unwrapCalls += 1
        return orderRumor as never
      },
      putCachedOrderMessages: async (rows) => {
        putCalls += 1
        if (putCalls === 1) {
          throw new Error("cache unavailable")
        }
        for (const row of rows) {
          cachedOrderMessages = [
            ...cachedOrderMessages.filter((existing) => existing.id !== row.id),
            row,
          ]
        }
      },
    })

    const first = await getMerchantConversationList({
      principalPubkey: "merchant",
      limit: 50,
    })
    const second = await getMerchantConversationList({
      principalPubkey: "merchant",
      limit: 50,
    })

    expect(first.data).toHaveLength(1)
    expect(second.data).toHaveLength(1)
    expect(unwrapCalls).toBe(2)
    expect(cachedOrderMessages).toHaveLength(1)
  })

  it("dedupes profile requests and serves cached profiles when relays fail later", async () => {
    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) => {
        if (filter.kinds?.includes(EVENT_KINDS.PROFILE)) {
          return [
            {
              id: "profile-1",
              pubkey: "alice",
              created_at: 10,
              content: JSON.stringify({ display_name: "Alice" }),
              tags: [],
            } as never,
          ]
        }

        return []
      },
    })

    const firstResult = await getProfiles({ pubkeys: ["alice", "alice"] })

    expect(Object.keys(firstResult.data)).toEqual(["alice"])
    expect(firstResult.data.alice?.displayName).toBe("Alice")
    expect(firstResult.meta.source).toBe("public")
    expect(cachedProfiles.get("alice")?.displayName).toBe("Alice")

    __setCommerceTestOverrides({
      fetchEventsFanout: async () => {
        throw new Error("offline")
      },
    })

    const secondResult = await getProfiles({ pubkeys: ["alice"] })

    expect(secondResult.meta.source).toBe("local_cache")
    expect(secondResult.data.alice?.displayName).toBe("Alice")
  })

  it("reads visible profiles through explicit planned relay fanout", async () => {
    let calledRequireNdk = false
    let seenFilterAuthors: string[] | undefined
    let seenOptions:
      | {
          relayUrls?: string[]
          connectTimeoutMs?: number
          fetchTimeoutMs?: number
        }
      | undefined

    __setCommerceTestOverrides({
      requireNdkConnected: async () => {
        calledRequireNdk = true
        return { signer: undefined } as never
      },
      fetchEventsFanout: async (filter, options) => {
        seenFilterAuthors = filter.authors
        seenOptions = options
        return [
          {
            id: "profile-2",
            pubkey: "bob",
            created_at: 10,
            content: JSON.stringify({ name: "Bob" }),
            tags: [],
          } as never,
        ]
      },
    })

    const result = await getProfiles({
      pubkeys: ["bob"],
      priority: "visible",
      skipCache: true,
    })

    expect(result.data.bob?.name).toBe("Bob")
    expect(calledRequireNdk).toBe(false)
    expect(seenFilterAuthors).toEqual(["bob"])
    expect(seenOptions?.relayUrls?.length).toBeGreaterThan(0)
    expect(seenOptions?.connectTimeoutMs).toBe(1_500)
    expect(seenOptions?.fetchTimeoutMs).toBe(3_000)
  })

  it("uses cached product source relays as first-choice merchant profile hints", async () => {
    cachedProducts.push({
      id: "30402:merchant:source-hinted-item",
      pubkey: "merchant",
      title: "Source Hinted Item",
      summary: "cached summary",
      price: 25,
      currency: "USD",
      type: "simple",
      visibility: "public",
      images: [{ url: "https://example.com/source-hinted-item.png" }],
      tags: ["cached"],
      sourceRelayUrls: ["wss://profile-source.example"],
      createdAt: FIXED_NOW - 5_000,
      updatedAt: FIXED_NOW - 5_000,
      cachedAt: FIXED_NOW - 1_000,
    })

    let seenRelayUrls: string[] | undefined

    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter, options) => {
        seenRelayUrls = options?.relayUrls
        if (
          filter.kinds?.includes(EVENT_KINDS.PROFILE) &&
          options?.relayUrls?.[0] === "wss://profile-source.example"
        ) {
          return [
            {
              id: "profile-merchant",
              pubkey: "merchant",
              created_at: 10,
              content: JSON.stringify({
                name: "Source Merchant",
                picture: "https://example.com/avatar.png",
              }),
              tags: [],
            } as never,
          ]
        }

        return []
      },
    })

    const result = await getProfiles({
      pubkeys: ["merchant"],
      priority: "background",
      skipCache: true,
      readPolicy: { maxRelays: 1 },
    })

    expect(seenRelayUrls?.[0]).toBe("wss://profile-source.example")
    expect(result.data.merchant?.name).toBe("Source Merchant")
    expect(result.data.merchant?.picture).toBe("https://example.com/avatar.png")
  })

  it("uses explicit product relay hints before default relays for profiles", async () => {
    let seenRelayUrls: string[] | undefined

    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter, options) => {
        seenRelayUrls = options?.relayUrls
        if (
          filter.kinds?.includes(EVENT_KINDS.PROFILE) &&
          options?.relayUrls?.[0] === "wss://live-product-source.example"
        ) {
          return [
            {
              id: "profile-live-merchant",
              pubkey: "live-merchant",
              created_at: 10,
              content: JSON.stringify({ display_name: "Live Merchant" }),
              tags: [],
            } as never,
          ]
        }

        return []
      },
    })

    const result = await getProfiles({
      pubkeys: ["live-merchant"],
      priority: "visible",
      skipCache: true,
      readPolicy: { maxRelays: 1 },
      relayHintsByPubkey: {
        "live-merchant": ["wss://live-product-source.example"],
      },
    })

    expect(seenRelayUrls?.[0]).toBe("wss://live-product-source.example")
    expect(result.data["live-merchant"]?.displayName).toBe("Live Merchant")
  })

  it("bounds broad progressive product author chunk fanout", async () => {
    const authorPubkeys = Array.from(
      { length: 129 },
      (_, index) => `merchant-${index}`
    )
    let activeFetches = 0
    let maxActiveFetches = 0
    let fetchCalls = 0

    __setRelayListTestOverrides({
      loadCached: async (pubkey) => ({
        pubkey,
        readRelayUrls: [],
        writeRelayUrls: [`wss://${pubkey}.relay.example`],
        eventCreatedAt: 1,
        cachedAt: FIXED_NOW,
      }),
    })
    __setCommerceTestOverrides({
      fetchEventsFanoutProgressive: async (filter, options, onProgress) => {
        activeFetches += 1
        maxActiveFetches = Math.max(maxActiveFetches, activeFetches)
        fetchCalls += 1
        const call = fetchCalls

        await new Promise((resolve) => setTimeout(resolve, 1))

        const pubkey = filter.authors?.[0] ?? "merchant"
        const event = makeProductEvent({
          pubkey,
          dTag: `item-${call}`,
          id: `event-${call}`,
          createdAt: 100 + call,
          title: `Item ${call}`,
        }) as never
        await onProgress({
          relayUrl: options?.relayUrls?.[0] ?? "wss://relay.example",
          events: [event],
          mergedEvents: [event],
        })

        activeFetches -= 1
        return [event]
      },
    })

    const result = await getMarketplaceProductsProgressive(
      {
        authorPubkeys,
        readPolicy: { maxRelays: 1 },
        sort: "newest",
      },
      () => {}
    )

    expect(fetchCalls).toBeGreaterThan(1)
    expect(maxActiveFetches).toBeLessThanOrEqual(2)
    expect(result.data.length).toBeGreaterThan(0)
  })

  it("emits profile progress before the full profile result settles", async () => {
    const progressNames: string[] = []

    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) => {
        if (!filter.kinds?.includes(EVENT_KINDS.PROFILE)) return []

        return [
          {
            id: "profile-progress-merchant",
            pubkey: "progress-merchant",
            created_at: 10,
            content: JSON.stringify({ display_name: "Progress Merchant" }),
            tags: [],
          } as never,
        ]
      },
    })

    const result = await getProfiles({
      pubkeys: ["progress-merchant"],
      skipCache: true,
      onProgress: (progress) => {
        const name = progress.data["progress-merchant"]?.displayName
        if (name) progressNames.push(name)
      },
    })

    expect(progressNames).toEqual(["Progress Merchant"])
    expect(result.data["progress-merchant"]?.displayName).toBe(
      "Progress Merchant"
    )
  })

  it("uses the newest profile event with content instead of a newer bare event", async () => {
    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) => {
        if (!filter.kinds?.includes(EVENT_KINDS.PROFILE)) return []

        return [
          {
            id: "profile-blank-newer",
            pubkey: "merchant",
            created_at: 20,
            content: "{}",
            tags: [],
          } as never,
          {
            id: "profile-rich-older",
            pubkey: "merchant",
            created_at: 10,
            content: JSON.stringify({ name: "ZALGEBAR" }),
            tags: [],
          } as never,
        ]
      },
    })

    const result = await getProfiles({
      pubkeys: ["merchant"],
      skipCache: true,
    })

    expect(result.data.merchant?.name).toBe("ZALGEBAR")
  })

  it("keeps stale cached profile identity when live profile lookup misses", async () => {
    cachedProfiles.set("merchant", {
      pubkey: "merchant",
      displayName: "ZALGEBAR",
      cachedAt: FIXED_NOW - 10 * 60_000,
    })

    __setCommerceTestOverrides({
      fetchEventsFanout: async () => [],
    })

    const result = await getProfiles({
      pubkeys: ["merchant"],
    })

    expect(result.data.merchant?.displayName).toBe("ZALGEBAR")
  })

  it("does not cache bare profile misses as successful profile rows", async () => {
    __setCommerceTestOverrides({
      fetchEventsFanout: async () => [],
    })

    const result = await getProfiles({
      pubkeys: ["missing-profile"],
      skipCache: true,
    })

    expect(result.data["missing-profile"]).toEqual({
      pubkey: "missing-profile",
    })
    expect(cachedProfiles.has("missing-profile")).toBe(false)
  })
})
