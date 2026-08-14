import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { NDKEvent } from "@nostr-dev-kit/ndk"
import { finalizeEvent, getPublicKey } from "nostr-tools/pure"
import {
  __resetCommerceTestOverrides,
  __resetRelayListTestOverrides,
  __setCommerceTestOverrides,
  __setRelayListTestOverrides,
  cacheSignedProductDeletionEvent,
  cacheSignedProductListingEvent,
  EVENT_KINDS,
  getCachedMerchantStorefront,
  getCachedMarketplaceProducts,
  getCachedProductDetail,
  getMarketplaceProducts,
  getMarketplaceProductsProgressive,
  getMerchantStorefront,
  getProductDetail,
  getProductsByIds,
} from "@conduit/core"
import type {
  CachedProduct,
  CachedProductTombstone,
  CommerceProductRecord,
} from "@conduit/core"

const FIXED_NOW = 1_700_000_000_000
const MERCHANT_A_SECRET = new Uint8Array(32).fill(21)
const MERCHANT_B_SECRET = new Uint8Array(32).fill(22)
const MERCHANT_A_PUBKEY = getPublicKey(MERCHANT_A_SECRET)
const MERCHANT_B_PUBKEY = getPublicKey(MERCHANT_B_SECRET)

let cachedProducts: CachedProduct[] = []
let cachedProductTombstones: CachedProductTombstone[] = []

function makeSignedProduct(params: {
  secretKey?: Uint8Array
  dTag: string
  createdAt: number
  title: string
}): NDKEvent {
  const secretKey = params.secretKey ?? MERCHANT_A_SECRET
  const pubkey = getPublicKey(secretKey)
  const event = finalizeEvent(
    {
      kind: EVENT_KINDS.PRODUCT,
      created_at: params.createdAt,
      content: JSON.stringify({
        id: `${EVENT_KINDS.PRODUCT}:${pubkey}:${params.dTag}`,
        pubkey,
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
    secretKey
  )

  return new NDKEvent(undefined, event)
}

function makeSignedDeletion(params: {
  secretKey?: Uint8Array
  createdAt: number
  tags: string[][]
}): NDKEvent {
  const event = finalizeEvent(
    {
      kind: EVENT_KINDS.DELETION,
      created_at: params.createdAt,
      content: "",
      tags: params.tags,
    },
    params.secretKey ?? MERCHANT_A_SECRET
  )

  return new NDKEvent(undefined, event)
}

function productAddress(pubkey: string, dTag: string): string {
  return `${EVENT_KINDS.PRODUCT}:${pubkey}:${dTag}`
}

function setRelayReads(input: {
  products: readonly NDKEvent[]
  deletions?: readonly NDKEvent[]
}): void {
  __setCommerceTestOverrides({
    fetchEventsFanout: async (filter) => {
      if (filter.kinds?.includes(EVENT_KINDS.PRODUCT)) {
        return [...input.products] as never
      }
      if (filter.kinds?.includes(EVENT_KINDS.DELETION)) {
        return [...(input.deletions ?? [])] as never
      }
      return []
    },
  })
}

beforeEach(() => {
  __resetCommerceTestOverrides()
  __resetRelayListTestOverrides()
  cachedProducts = []
  cachedProductTombstones = []

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
  cachedProducts = []
  cachedProductTombstones = []
})

describe("product deletion convergence regression matrix", () => {
  it("keeps equal d-tags author-scoped", async () => {
    const merchantAProduct = makeSignedProduct({
      dTag: "shared-d",
      createdAt: 100,
      title: "Merchant A product",
    })
    const merchantBProduct = makeSignedProduct({
      secretKey: MERCHANT_B_SECRET,
      dTag: "shared-d",
      createdAt: 100,
      title: "Merchant B product",
    })

    await cacheSignedProductListingEvent(merchantAProduct)
    await cacheSignedProductListingEvent(merchantBProduct)
    await cacheSignedProductDeletionEvent(
      makeSignedDeletion({
        createdAt: 110,
        tags: [["a", productAddress(MERCHANT_A_PUBKEY, "shared-d")]],
      })
    )

    const result = await getCachedMarketplaceProducts()

    expect(result.data.map((record) => record.product.pubkey)).toEqual([
      MERCHANT_B_PUBKEY,
    ])
  })

  it("applies an address deletion as an inclusive cutoff while preserving a genuinely newer replacement", async () => {
    const older = makeSignedProduct({
      dTag: "replaceable",
      createdAt: 100,
      title: "Older product",
    })
    const newer = makeSignedProduct({
      dTag: "replaceable",
      createdAt: 201,
      title: "Newer product",
    })

    await cacheSignedProductListingEvent(older)
    await cacheSignedProductDeletionEvent(
      makeSignedDeletion({
        createdAt: 200,
        tags: [["a", productAddress(MERCHANT_A_PUBKEY, "replaceable")]],
      })
    )
    await cacheSignedProductListingEvent(newer)

    const result = await getCachedMarketplaceProducts({
      merchantPubkey: MERCHANT_A_PUBKEY,
    })

    expect(result.data.map((record) => record.product.title)).toEqual([
      "Newer product",
    ])
  })

  it("honors an exact event-id deletion even when the deletion timestamp is older", async () => {
    const product = makeSignedProduct({
      dTag: "legacy-clock-skew",
      createdAt: 200,
      title: "Clock-skewed legacy product",
    })

    await cacheSignedProductListingEvent(product)
    await cacheSignedProductDeletionEvent(
      makeSignedDeletion({
        createdAt: 100,
        tags: [["e", product.id]],
      })
    )

    const result = await getCachedMarketplaceProducts({
      merchantPubkey: MERCHANT_A_PUBKEY,
    })

    expect(result.data).toEqual([])
  })

  it("retains validated remote tombstone evidence when a later relay read omits it", async () => {
    const product = makeSignedProduct({
      dTag: "remote-omission",
      createdAt: 100,
      title: "Remotely deleted product",
    })
    const deletion = makeSignedDeletion({
      createdAt: 110,
      tags: [
        ["e", product.id],
        ["a", productAddress(MERCHANT_A_PUBKEY, "remote-omission")],
      ],
    })

    await cacheSignedProductListingEvent(product)
    setRelayReads({ products: [product], deletions: [deletion] })
    const observed = await getMerchantStorefront({
      merchantPubkey: MERCHANT_A_PUBKEY,
      limit: 10,
    })
    expect(observed.data).toEqual([])

    setRelayReads({ products: [product], deletions: [] })
    const omitted = await getMerchantStorefront({
      merchantPubkey: MERCHANT_A_PUBKEY,
      limit: 10,
    })

    expect(omitted.data).toEqual([])
    expect(cachedProductTombstones.length).toBeGreaterThan(0)
  })

  it("keeps remote-first evidence for a product observed only on a later read", async () => {
    const product = makeSignedProduct({
      dTag: "remote-first",
      createdAt: 100,
      title: "Late stale product",
    })
    const deletion = makeSignedDeletion({
      createdAt: 110,
      tags: [["a", productAddress(MERCHANT_A_PUBKEY, "remote-first")]],
    })

    setRelayReads({ products: [product], deletions: [deletion] })
    expect(
      (
        await getMerchantStorefront({
          merchantPubkey: MERCHANT_A_PUBKEY,
          includeMarketHidden: true,
        })
      ).data
    ).toEqual([])
    expect(cachedProductTombstones.length).toBeGreaterThan(0)

    cachedProducts = []
    setRelayReads({ products: [product], deletions: [] })
    expect(
      (
        await getMerchantStorefront({
          merchantPubkey: MERCHANT_A_PUBKEY,
          includeMarketHidden: true,
        })
      ).data
    ).toEqual([])
  })

  it("does not persist or apply a tampered remote tombstone", async () => {
    const product = makeSignedProduct({
      dTag: "tampered-remote",
      createdAt: 100,
      title: "Still visible",
    })
    const deletion = makeSignedDeletion({
      createdAt: 110,
      tags: [["e", product.id]],
    })
    deletion.sig = "0".repeat(128)
    setRelayReads({ products: [product], deletions: [deletion] })

    const result = await getMerchantStorefront({
      merchantPubkey: MERCHANT_A_PUBKEY,
      includeMarketHidden: true,
    })

    expect(result.data.map(({ eventId }) => eventId)).toEqual([product.id])
    expect(cachedProductTombstones).toEqual([])
  })

  it("retracts a progressive product when its tombstone arrives later", async () => {
    const product = makeSignedProduct({
      dTag: "progressive-late-delete",
      createdAt: 100,
      title: "Progressively deleted product",
    })
    const deletion = makeSignedDeletion({
      createdAt: 110,
      tags: [
        ["e", product.id],
        ["a", productAddress(MERCHANT_A_PUBKEY, "progressive-late-delete")],
      ],
    })
    const snapshots: CommerceProductRecord[][] = []

    __setCommerceTestOverrides({
      fetchEventsFanoutProgressive: async (_filter, options, onProgress) => {
        await onProgress({
          relayUrl: options?.relayUrls?.[0] ?? "wss://product-source.example",
          events: [product] as never,
          mergedEvents: [product] as never,
        })
        // Install the deletion read only after product progress. This keeps the
        // test on the progressive path while deterministically modeling a
        // tombstone that becomes observable after the first product snapshot.
        __setCommerceTestOverrides({
          fetchEventsFanout: async (filter) =>
            filter.kinds?.includes(EVENT_KINDS.DELETION)
              ? ([deletion] as never)
              : [],
        })
        return [product] as never
      },
    })

    const result = await getMarketplaceProductsProgressive(
      {
        merchantPubkey: MERCHANT_A_PUBKEY,
        limit: 10,
      },
      (progress) => {
        snapshots.push(progress.data)
      }
    )

    expect(
      snapshots.some((snapshot) =>
        snapshot.some((record) => record.eventId === product.id)
      )
    ).toBe(true)
    expect(snapshots.at(-1)).toEqual([])
    expect(result.data).toEqual([])
  })

  it("suppresses a progressive product when its tombstone was observed first", async () => {
    const product = makeSignedProduct({
      dTag: "progressive-known-delete",
      createdAt: 100,
      title: "Previously deleted product",
    })
    const address = productAddress(
      MERCHANT_A_PUBKEY,
      "progressive-known-delete"
    )
    await cacheSignedProductDeletionEvent(
      makeSignedDeletion({
        createdAt: 110,
        tags: [
          ["e", product.id],
          ["a", address],
        ],
      })
    )
    const snapshots: CommerceProductRecord[][] = []

    __setCommerceTestOverrides({
      fetchEventsFanoutProgressive: async (_filter, options, onProgress) => {
        await onProgress({
          relayUrl: options?.relayUrls?.[0] ?? "wss://product-source.example",
          events: [product] as never,
          mergedEvents: [product] as never,
        })
        return [product] as never
      },
      fetchEventsFanout: async () => [],
    })

    const result = await getMarketplaceProductsProgressive(
      { merchantPubkey: MERCHANT_A_PUBKEY, limit: 10 },
      (progress) => snapshots.push(progress.data)
    )

    expect(snapshots.every((snapshot) => snapshot.length === 0)).toBe(true)
    expect(result.data).toEqual([])
  })

  it("agrees across catalog, Merchant, progressive, detail, batch, and cache surfaces", async () => {
    const product = makeSignedProduct({
      dTag: "surface-agreement",
      createdAt: 100,
      title: "Deleted everywhere",
    })
    const address = productAddress(MERCHANT_A_PUBKEY, "surface-agreement")
    const deletion = makeSignedDeletion({
      createdAt: 110,
      tags: [
        ["e", product.id],
        ["a", address],
      ],
    })
    await cacheSignedProductListingEvent(product)

    setRelayReads({ products: [product], deletions: [deletion] })
    expect(
      (
        await getMerchantStorefront({
          merchantPubkey: MERCHANT_A_PUBKEY,
          includeMarketHidden: true,
          limit: 10,
        })
      ).data
    ).toEqual([])

    // A later omission cannot weaken the validated evidence now in cache.
    setRelayReads({ products: [product], deletions: [] })
    const progressiveSnapshots: CommerceProductRecord[][] = []
    const [
      catalog,
      cachedCatalog,
      merchant,
      cachedMerchant,
      detail,
      cachedDetail,
      batch,
      progressive,
    ] = await Promise.all([
      getMarketplaceProducts({ merchantPubkey: MERCHANT_A_PUBKEY }),
      getCachedMarketplaceProducts({ merchantPubkey: MERCHANT_A_PUBKEY }),
      getMerchantStorefront({
        merchantPubkey: MERCHANT_A_PUBKEY,
        includeMarketHidden: true,
        limit: 10,
      }),
      getCachedMerchantStorefront({
        merchantPubkey: MERCHANT_A_PUBKEY,
        includeMarketHidden: true,
        limit: 10,
      }),
      getProductDetail({ productId: address }),
      getCachedProductDetail({ productId: address }),
      getProductsByIds([address]),
      getMarketplaceProductsProgressive(
        { merchantPubkey: MERCHANT_A_PUBKEY, limit: 10 },
        (progress) => progressiveSnapshots.push(progress.data)
      ),
    ])

    expect(catalog.data).toEqual([])
    expect(cachedCatalog.data).toEqual([])
    expect(merchant.data).toEqual([])
    expect(cachedMerchant.data).toEqual([])
    expect(detail.data).toBeNull()
    expect(cachedDetail.data).toBeNull()
    expect(batch.data).toEqual([])
    expect(progressive.data).toEqual([])
    expect(progressiveSnapshots.at(-1)).toEqual([])
  })

  it("applies local tombstones to successful batch reads", async () => {
    const product = makeSignedProduct({
      dTag: "batch-local-delete",
      createdAt: 100,
      title: "Batch-deleted product",
    })
    const address = productAddress(MERCHANT_A_PUBKEY, "batch-local-delete")

    await cacheSignedProductDeletionEvent(
      makeSignedDeletion({
        createdAt: 110,
        tags: [
          ["e", product.id],
          ["a", address],
        ],
      })
    )
    setRelayReads({ products: [product] })

    const result = await getProductsByIds([address])

    expect(result.data).toEqual([])
  })
})
