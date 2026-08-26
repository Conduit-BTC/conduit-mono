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
  getFollowPubkeys,
  getAtomicProductDetail,
  getMarketplaceProducts,
  getMarketplaceProductsProgressive,
  getMerchantConversationList,
  getMerchantStorefront,
  getProductImageCandidates,
  getProductDetail,
  getProductsByIds,
  getProfiles,
  __resetRelayHealth,
  __resetRelayListTestOverrides,
  __setRelayListTestOverrides,
  applyE2eRelayIsolation,
  recordRelayFailure,
} from "@conduit/core"
import { config, EVENT_KINDS } from "@conduit/core"
import type {
  CachedOrderMessage,
  CachedProduct,
  CachedProductTombstone,
  CachedProfile,
  FollowListReadResult,
  SignedPublicNostrEvent,
} from "@conduit/core"
import { attachEventSourceRelayUrl } from "@conduit/core/protocol/ndk"
import {
  getCartAvailabilityBlockingMessage,
  getCartAvailabilityReadDecision,
  getCartProductAvailability,
  type CartItem,
} from "../apps/market/src/lib/cart-model"

const FIXED_NOW = 1_700_000_000_000
const MERCHANT_A_SECRET = new Uint8Array(32).fill(1)
const MERCHANT_B_SECRET = new Uint8Array(32).fill(2)
const MERCHANT_A_PUBKEY = getPublicKey(MERCHANT_A_SECRET)
let cachedProducts: CachedProduct[] = []
let cachedProductTombstones: CachedProductTombstone[] = []
let cachedProfiles = new Map<string, CachedProfile>()
let cachedOrderMessages: CachedOrderMessage[] = []
const originalConfig = structuredClone(config)

function makeFollowListRead(input: {
  pubkey: string
  event?: SignedPublicNostrEvent
  coverage?: "complete" | "limited" | "unavailable"
  snapshotState?: "none" | "network" | "observed" | "pending"
  capped?: boolean
}): FollowListReadResult {
  const relayUrl = "wss://follow-relay.example"
  const coverage = input.coverage ?? "complete"
  const relayStatus = coverage === "unavailable" ? "failed" : "success"
  const author = {
    pubkey: input.pubkey,
    event: input.event,
    eventSourceRelayUrls: input.event ? [relayUrl] : [],
    hintRelayUrls: [relayUrl],
    plannedRelayUrls: [relayUrl],
    relays: [
      {
        relayUrl,
        status: relayStatus,
        eventCount: input.event ? 1 : 0,
      },
    ],
    eventsVerified: true,
    coverage,
    relayListState: "network" as const,
    relayHintTruncated: false,
    capped: input.capped ?? false,
    snapshotState: input.snapshotState ?? (input.event ? "network" : "none"),
  } satisfies FollowListReadResult["authors"][number]

  return {
    events: input.event ? [input.event] : [],
    authors: [author],
    plannedRelayUrls: [relayUrl],
    relays: author.relays,
    eventsVerified: true,
  }
}

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
      images: [{ url: "https://cdn.conduit.market/conduit-test/product.png" }],
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

function makeGammaProductEvent(params: {
  pubkey: string
  dTag: string
  id: string
  createdAt: number
  title: string
  type: "simple" | "variable" | "variation"
  parentProductId?: string
  size?: string
  stock?: number
  image?: boolean
  price?: number
}) {
  return {
    id: params.id,
    kind: EVENT_KINDS.PRODUCT,
    pubkey: params.pubkey,
    created_at: params.createdAt,
    content: `${params.title} description`,
    sig: "signed",
    tags: [
      ["d", params.dTag],
      ["title", params.title],
      ["price", String(params.price ?? 25_000), "SATS"],
      ["type", params.type, "physical"],
      ...(params.parentProductId ? [["a", params.parentProductId]] : []),
      ...(params.size ? [["spec", "size", params.size]] : []),
      ...(typeof params.stock === "number"
        ? [["stock", String(params.stock)]]
        : []),
      ...(params.image === false
        ? []
        : [["image", "https://cdn.conduit.market/conduit-test/product.png"]]),
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
        images: [
          { url: "https://cdn.conduit.market/conduit-test/product.png" },
        ],
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

function composeCheckoutAvailability(
  result: Awaited<ReturnType<typeof getProductsByIds>>,
  input: {
    productId: string
    merchantPubkey: string
    title: string
  }
) {
  const items: CartItem[] = [
    {
      productId: input.productId,
      merchantPubkey: input.merchantPubkey,
      title: input.title,
      price: 25,
      currency: "USD",
      stock: 1,
      quantity: 1,
    },
  ]
  const availability = getCartProductAvailability(
    items,
    result.data.map((record) => record.product)
  )
  const decision = getCartAvailabilityReadDecision({
    productIds: [input.productId],
    availability,
    meta: result.meta,
    diagnostics: result.diagnostics,
    querySucceeded: true,
  })

  return {
    availability,
    decision,
    inventoryMessage: getCartAvailabilityBlockingMessage(
      items,
      new Map(availability.map((entry) => [entry.productId, entry]))
    ),
  }
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
  __resetRelayHealth()
  __resetRelayListTestOverrides()
  cachedProducts = []
  cachedProductTombstones = []
  cachedProfiles = new Map()
  cachedOrderMessages = []
  // Commerce tests own the complete relay boundary. Keep secondary NIP-65
  // planning (including deletion-frontier reads) from reaching the network.
  __setRelayListTestOverrides({
    fetchEventsFanout: async () => [],
    loadCached: async () => undefined,
    putCached: async () => {},
    now: () => FIXED_NOW,
  })
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
  Object.assign(config, structuredClone(originalConfig))
  __resetCommerceTestOverrides()
  __resetRelayHealth()
  __resetRelayListTestOverrides()
  cachedProducts = []
  cachedProductTombstones = []
  cachedProfiles = new Map()
  cachedOrderMessages = []
})

describe("commerce gateway", () => {
  it("groups reachable Gamma variations while hiding orphan and foreign children", async () => {
    const merchantPubkey = MERCHANT_A_PUBKEY
    const foreignPubkey = getPublicKey(MERCHANT_B_SECRET)
    const parentProductId = `30402:${merchantPubkey}:shirt`
    const events = [
      makeGammaProductEvent({
        pubkey: merchantPubkey,
        dTag: "shirt",
        id: "shirt-parent-event",
        createdAt: 100,
        title: "Conduit Shirt",
        type: "variable",
      }),
      ...["S", "M", "L", "XL"].map((size, index) =>
        makeGammaProductEvent({
          pubkey: merchantPubkey,
          dTag: `shirt-${size.toLowerCase()}`,
          id: `shirt-${size.toLowerCase()}-event`,
          createdAt: 101 + index,
          title: `Conduit Shirt — ${size}`,
          type: "variation",
          parentProductId,
          size,
          stock: size === "S" ? 0 : 5,
          image: false,
        })
      ),
      makeGammaProductEvent({
        pubkey: merchantPubkey,
        dTag: "orphan",
        id: "orphan-event",
        createdAt: 106,
        title: "Orphan Option",
        type: "variation",
        parentProductId: `30402:${merchantPubkey}:missing`,
        size: "XXL",
      }),
      makeGammaProductEvent({
        pubkey: foreignPubkey,
        dTag: "foreign-child",
        id: "foreign-child-event",
        createdAt: 107,
        title: "Foreign Child",
        type: "variation",
        parentProductId,
        size: "XS",
      }),
      makeGammaProductEvent({
        pubkey: merchantPubkey,
        dTag: "sticker",
        id: "sticker-event",
        createdAt: 108,
        title: "Conduit Sticker",
        type: "simple",
      }),
      makeGammaProductEvent({
        pubkey: merchantPubkey,
        dTag: "empty-family",
        id: "empty-family-event",
        createdAt: 109,
        title: "Incomplete Family",
        type: "variable",
      }),
    ]

    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) =>
        filter.kinds?.includes(EVENT_KINDS.PRODUCT) ? (events as never) : [],
    })

    const market = await getMarketplaceProducts({ sort: "newest" })
    const merchant = await getMerchantStorefront({
      merchantPubkey,
      includeMarketHidden: true,
    })
    const childDetail = await getProductDetail({
      productId: `30402:${merchantPubkey}:shirt-l`,
    })
    const atomicChild = await getAtomicProductDetail({
      productId: `30402:${merchantPubkey}:shirt-l`,
      includeMarketHidden: true,
    })
    const incompleteFamily = await getProductDetail({
      productId: `30402:${merchantPubkey}:empty-family`,
      includeMarketHidden: true,
    })
    const selectedVariation = await getProductsByIds([
      `30402:${merchantPubkey}:shirt-l`,
    ])
    const orphanVariation = await getProductsByIds([
      `30402:${merchantPubkey}:orphan`,
    ])
    const parent = market.data.find(
      (record) => record.addressId === parentProductId
    )

    expect(market.data.map((record) => record.product.title).sort()).toEqual([
      "Conduit Shirt",
      "Conduit Sticker",
    ])
    expect(parent?.safety?.state).toBe("active")
    expect(
      parent?.family?.children.map((variation) => variation.product.id)
    ).toEqual([
      `30402:${merchantPubkey}:shirt-l`,
      `30402:${merchantPubkey}:shirt-m`,
      `30402:${merchantPubkey}:shirt-s`,
      `30402:${merchantPubkey}:shirt-xl`,
    ])
    expect(merchant.data).toHaveLength(8)
    expect(childDetail.data?.addressId).toBe(parentProductId)
    expect(childDetail.data?.family?.children).toHaveLength(4)
    expect(atomicChild.data?.addressId).toBe(`30402:${merchantPubkey}:shirt-l`)
    expect(atomicChild.data?.product.type).toBe("variation")
    expect(atomicChild.data?.family).toBeUndefined()
    expect(incompleteFamily.data?.family?.state).toBe("parent_only")
    expect(incompleteFamily.data?.family?.readEvidence).toMatchObject({
      source: incompleteFamily.meta.source,
      stale: incompleteFamily.meta.stale,
      degraded: incompleteFamily.meta.degraded,
      capped: incompleteFamily.meta.capped,
    })
    expect(selectedVariation.data[0]?.product.stock).toBe(5)
    expect(orphanVariation.data).toHaveLength(0)
  })

  it("sorts a variable family by the minimum child price shown in its summary", async () => {
    const merchantPubkey = MERCHANT_A_PUBKEY
    const parentProductId = `30402:${merchantPubkey}:shirt`
    const events = [
      makeGammaProductEvent({
        pubkey: merchantPubkey,
        dTag: "shirt",
        id: "shirt-parent-event",
        createdAt: 100,
        title: "Conduit Shirt",
        type: "variable",
        price: 1_000,
      }),
      makeGammaProductEvent({
        pubkey: merchantPubkey,
        dTag: "shirt-s",
        id: "shirt-s-event",
        createdAt: 101,
        title: "Conduit Shirt — S",
        type: "variation",
        parentProductId,
        size: "S",
        stock: 5,
        price: 3_000,
      }),
      makeGammaProductEvent({
        pubkey: merchantPubkey,
        dTag: "sticker",
        id: "sticker-event",
        createdAt: 102,
        title: "Conduit Sticker",
        type: "simple",
        price: 2_000,
      }),
    ]

    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) =>
        filter.kinds?.includes(EVENT_KINDS.PRODUCT) ? (events as never) : [],
    })

    const result = await getMarketplaceProducts({ sort: "price_asc" })

    expect(result.data.map((record) => record.product.title)).toEqual([
      "Conduit Sticker",
      "Conduit Shirt",
    ])
  })

  it("marks a saturated bounded catalog read as degraded", async () => {
    const events = Array.from({ length: 100 }, (_, index) =>
      makeProductEvent({
        pubkey: MERCHANT_A_PUBKEY,
        dTag: `bounded-${index}`,
        id: `bounded-event-${index}`,
        createdAt: 100 + index,
        title: `Bounded item ${index}`,
      })
    )
    let productLimit: number | undefined

    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) => {
        if (!filter.kinds?.includes(EVENT_KINDS.PRODUCT)) return []
        productLimit = filter.limit
        return events.slice(0, filter.limit ?? events.length) as never
      },
    })

    const result = await getMarketplaceProducts({ limit: 1 })

    expect(productLimit).toBe(100)
    expect(result.data).toHaveLength(1)
    expect(result.meta.capped).toBe(true)
    expect(result.meta.degraded).toBe(true)
    expect(result.meta.stale).toBe(false)
  })

  it("preserves raw catalog saturation after replaceable-event dedupe", async () => {
    const events = Array.from({ length: 100 }, (_, index) =>
      makeProductEvent({
        pubkey: MERCHANT_A_PUBKEY,
        dTag: "bounded-versioned",
        id: `bounded-versioned-event-${index}`,
        createdAt: 100 + index,
        title: `Bounded version ${index}`,
      })
    )

    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) =>
        filter.kinds?.includes(EVENT_KINDS.PRODUCT)
          ? (events.slice(0, filter.limit ?? events.length) as never)
          : [],
    })

    const result = await getMarketplaceProducts({ limit: 1 })

    expect(result.data).toHaveLength(1)
    expect(result.meta.capped).toBe(true)
    expect(result.meta.degraded).toBe(true)
  })

  it("marks partial relay product reads as degraded below the cap", async () => {
    const event = makeProductEvent({
      pubkey: MERCHANT_A_PUBKEY,
      dTag: "partial-read",
      id: "partial-read-event",
      createdAt: 100,
      title: "Partial read",
    })

    __setCommerceTestOverrides({
      fetchEventsFanout: async () => [],
      fetchEventsFanoutDetailed: async () => ({
        events: [event as never],
        relays: [
          {
            relayUrl: "wss://partial.example",
            status: "partial",
            eventCount: 1,
          },
        ],
      }),
    })

    const market = await getMarketplaceProducts({ limit: 10 })
    const storefront = await getMerchantStorefront({
      merchantPubkey: MERCHANT_A_PUBKEY,
      limit: 10,
    })

    expect(market.data).toHaveLength(1)
    expect(market.meta.degraded).toBe(true)
    expect(storefront.data).toHaveLength(1)
    expect(storefront.meta.degraded).toBe(true)
  })

  it("propagates progressive relay completion into final freshness", async () => {
    const event = makeProductEvent({
      pubkey: MERCHANT_A_PUBKEY,
      dTag: "progressive-read",
      id: "progressive-read-event",
      createdAt: 100,
      title: "Progressive read",
    }) as never
    let relayStatus: "partial" | "success" = "partial"

    __setCommerceTestOverrides({
      fetchEventsFanoutProgressive: async (_filter, options, onProgress) => {
        await onProgress({
          relayUrl: options.relayUrls?.[0] ?? "wss://progressive.example",
          events: [event],
          mergedEvents: [event],
          status: relayStatus,
        })
        return [event]
      },
    })

    const partial = await getMarketplaceProductsProgressive(
      { limit: 10 },
      () => {}
    )
    relayStatus = "success"
    const complete = await getMarketplaceProductsProgressive(
      { limit: 10 },
      () => {}
    )

    expect(partial.data).toHaveLength(1)
    expect(partial.meta.degraded).toBe(true)
    expect(complete.data).toHaveLength(1)
    expect(complete.meta.degraded).toBe(false)
  })

  it("marks a saturated variation-group read as degraded", async () => {
    const merchantPubkey = MERCHANT_A_PUBKEY
    const parentProductId = `30402:${merchantPubkey}:large-catalog`
    const events = [
      makeGammaProductEvent({
        pubkey: merchantPubkey,
        dTag: "large-catalog",
        id: "large-catalog-parent",
        createdAt: 100,
        title: "Large catalog",
        type: "variable",
      }),
      ...Array.from({ length: 200 }, (_, index) =>
        makeGammaProductEvent({
          pubkey: merchantPubkey,
          dTag: `large-catalog-${index}`,
          id: `large-catalog-variation-${index}`,
          createdAt: 101 + index,
          title: `Large catalog - ${index}`,
          type: "variation",
          parentProductId,
          size: String(index),
        })
      ),
    ]

    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) => {
        if (!filter.kinds?.includes(EVENT_KINDS.PRODUCT)) return []
        const matches = events.filter(
          (event) =>
            (!filter.authors || filter.authors.includes(event.pubkey)) &&
            (!filter["#d"] ||
              event.tags.some(
                (tag) => tag[0] === "d" && filter["#d"]?.includes(tag[1] ?? "")
              )) &&
            (!filter["#a"] ||
              event.tags.some(
                (tag) => tag[0] === "a" && filter["#a"]?.includes(tag[1] ?? "")
              ))
        )
        return matches.slice(0, filter.limit ?? matches.length) as never
      },
    })

    const result = await getProductDetail({ productId: parentProductId })

    expect(result.data?.family?.children).toHaveLength(200)
    expect(result.meta.source).toBe("commerce")
    expect(result.meta.capped).toBe(true)
    expect(result.meta.degraded).toBe(true)
    expect(result.data?.family?.readEvidence.degraded).toBe(true)
  })

  it("preserves raw variation saturation after replaceable-event dedupe", async () => {
    const merchantPubkey = MERCHANT_A_PUBKEY
    const parentProductId = `30402:${merchantPubkey}:versioned-large-catalog`
    const parent = makeGammaProductEvent({
      pubkey: merchantPubkey,
      dTag: "versioned-large-catalog",
      id: "versioned-large-catalog-parent",
      createdAt: 100,
      title: "Versioned large catalog",
      type: "variable",
    })
    const versions = Array.from({ length: 200 }, (_, index) =>
      makeGammaProductEvent({
        pubkey: merchantPubkey,
        dTag: "versioned-large-catalog-child",
        id: `versioned-large-catalog-child-${index}`,
        createdAt: 101 + index,
        title: `Versioned child ${index}`,
        type: "variation",
        parentProductId,
        size: "One size",
      })
    )

    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) => {
        if (!filter.kinds?.includes(EVENT_KINDS.PRODUCT)) return []
        if (filter["#d"]) return [parent] as never
        if (filter["#a"]) {
          return versions.slice(0, filter.limit ?? versions.length) as never
        }
        return [parent, ...versions] as never
      },
    })

    const result = await getProductDetail({ productId: parentProductId })

    expect(result.data?.family?.children).toHaveLength(1)
    expect(result.meta.capped).toBe(true)
    expect(result.meta.stale).toBe(true)
    expect(result.meta.degraded).toBe(true)
  })

  it("partitions exact product batches by author without Cartesian collisions", async () => {
    const merchants = Array.from({ length: 11 }, (_, index) =>
      getPublicKey(new Uint8Array(32).fill(index + 1))
    )
    const wantedEvents = merchants.map((pubkey, index) =>
      makeProductEvent({
        pubkey,
        dTag: `item-${index}`,
        id: `wanted-${index}`,
        createdAt: 200 + index,
        title: `Wanted ${index}`,
      })
    )
    const crossEvents = merchants.flatMap((pubkey, authorIndex) =>
      merchants.flatMap((_, dTagIndex) =>
        authorIndex === dTagIndex
          ? []
          : [
              makeProductEvent({
                pubkey,
                dTag: `item-${dTagIndex}`,
                id: `cross-${authorIndex}-${dTagIndex}`,
                createdAt: 100 + authorIndex,
                title: `Cross ${authorIndex}-${dTagIndex}`,
              }),
            ]
      )
    )
    const productFilters: Array<Record<string, unknown>> = []

    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) => {
        if (!filter.kinds?.includes(EVENT_KINDS.PRODUCT)) return []
        productFilters.push(filter as Record<string, unknown>)
        const matches = [...crossEvents, ...wantedEvents].filter(
          (event) =>
            (!filter.authors || filter.authors.includes(event.pubkey)) &&
            (!filter["#d"] ||
              event.tags.some(
                (tag) => tag[0] === "d" && filter["#d"]?.includes(tag[1] ?? "")
              ))
        )
        return matches.slice(0, filter.limit ?? matches.length) as never
      },
    })

    const result = await getProductsByIds(
      merchants.map((pubkey, index) => `30402:${pubkey}:item-${index}`)
    )
    const exactFilters = productFilters.filter((filter) => "#d" in filter)

    expect(result.data).toHaveLength(merchants.length)
    expect(result.data.map((record) => record.product.title).sort()).toEqual(
      wantedEvents.map((_, index) => `Wanted ${index}`).sort()
    )
    expect(exactFilters).toHaveLength(merchants.length)
    expect(
      exactFilters.every(
        (filter) =>
          Array.isArray(filter.authors) &&
          filter.authors.length === 1 &&
          Array.isArray(filter["#d"]) &&
          filter["#d"].length === 1 &&
          filter.limit === undefined
      )
    ).toBe(true)
  })

  it("keeps a family stale until every cached sibling has live group coverage", async () => {
    const merchantPubkey = MERCHANT_A_PUBKEY
    const parentProductId = `30402:${merchantPubkey}:coverage-shirt`
    const parent = makeGammaProductEvent({
      pubkey: merchantPubkey,
      dTag: "coverage-shirt",
      id: "coverage-shirt-parent",
      createdAt: 100,
      title: "Coverage shirt",
      type: "variable",
    })
    const small = makeGammaProductEvent({
      pubkey: merchantPubkey,
      dTag: "coverage-shirt-s",
      id: "coverage-shirt-s-event",
      createdAt: 101,
      title: "Coverage shirt - S",
      type: "variation",
      parentProductId,
      size: "S",
    })
    const medium = makeGammaProductEvent({
      pubkey: merchantPubkey,
      dTag: "coverage-shirt-m",
      id: "coverage-shirt-m-event",
      createdAt: 102,
      title: "Coverage shirt - M",
      type: "variation",
      parentProductId,
      size: "M",
    })
    let includeEverySibling = true

    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) => {
        if (!filter.kinds?.includes(EVENT_KINDS.PRODUCT)) return []
        if (filter["#d"]) {
          return [parent, small, medium].filter((event) =>
            event.tags.some(
              (tag) => tag[0] === "d" && filter["#d"]?.includes(tag[1] ?? "")
            )
          ) as never
        }
        if (filter["#a"]) {
          return (includeEverySibling ? [small, medium] : [small]) as never
        }
        return [parent, small, medium] as never
      },
    })

    await getMarketplaceProducts()
    includeEverySibling = false
    const partial = await getProductsByIds([parentProductId])
    includeEverySibling = true
    const complete = await getProductsByIds([parentProductId])

    expect(partial.data[0]?.family?.children).toHaveLength(2)
    expect(partial.meta.source).toBe("commerce")
    expect(partial.meta.stale).toBe(true)
    expect(partial.meta.degraded).toBe(true)
    expect(partial.data[0]?.family?.readEvidence.stale).toBe(true)
    expect(complete.meta.source).toBe("commerce")
    expect(complete.meta.stale).toBe(false)
    expect(complete.meta.degraded).toBe(false)
    expect(complete.data[0]?.family?.readEvidence.stale).toBe(false)
  })

  it("keeps a family stale when a cached sibling is newer than live coverage", async () => {
    const merchantPubkey = MERCHANT_A_PUBKEY
    const parentProductId = `30402:${merchantPubkey}:versioned-shirt`
    const parent = makeGammaProductEvent({
      pubkey: merchantPubkey,
      dTag: "versioned-shirt",
      id: "versioned-shirt-parent",
      createdAt: 100,
      title: "Versioned shirt",
      type: "variable",
    })
    const small = makeGammaProductEvent({
      pubkey: merchantPubkey,
      dTag: "versioned-shirt-s",
      id: "versioned-shirt-s-event",
      createdAt: 101,
      title: "Versioned shirt - S",
      type: "variation",
      parentProductId,
      size: "S",
    })
    const olderMedium = makeGammaProductEvent({
      pubkey: merchantPubkey,
      dTag: "versioned-shirt-m",
      id: "versioned-shirt-m-older",
      createdAt: 102,
      title: "Versioned shirt - M (older)",
      type: "variation",
      parentProductId,
      size: "M",
    })
    const newerMedium = makeGammaProductEvent({
      pubkey: merchantPubkey,
      dTag: "versioned-shirt-m",
      id: "versioned-shirt-m-newer",
      createdAt: 202,
      title: "Versioned shirt - M (newer)",
      type: "variation",
      parentProductId,
      size: "M",
    })
    let primeCache = true

    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) => {
        if (!filter.kinds?.includes(EVENT_KINDS.PRODUCT)) return []
        if (primeCache) return [parent, small, newerMedium] as never
        if (filter["#d"]) return [parent] as never
        if (filter["#a"]) return [small, olderMedium] as never
        return []
      },
    })

    await getMarketplaceProducts()
    primeCache = false
    const result = await getProductsByIds([parentProductId])

    expect(
      result.data[0]?.family?.children.map((child) => child.eventId)
    ).toContain(newerMedium.id)
    expect(result.meta.stale).toBe(true)
    expect(result.meta.degraded).toBe(true)
    expect(result.data[0]?.family?.readEvidence.stale).toBe(true)
  })

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
      images: [
        { url: "https://cdn.conduit.market/conduit-test/cached-item.png" },
      ],
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

  it("retains cached product evidence while projecting profile and image requests safely", async () => {
    cachedProducts.push({
      id: "30402:merchant:cached-image-safety",
      pubkey: "merchant",
      title: "Cached Image Safety",
      price: 25,
      currency: "USD",
      type: "simple",
      visibility: "public",
      images: [
        { url: "https://192.168.1.5/private.png" },
        { url: "https://cdn.conduit.market/conduit-test/public.png" },
      ],
      tags: ["cached"],
      createdAt: FIXED_NOW - 5_000,
      updatedAt: FIXED_NOW - 5_000,
      cachedAt: FIXED_NOW - 1_000,
    })
    cachedProfiles.set("merchant", {
      pubkey: "merchant",
      name: "Cached Merchant",
      picture: "http://127.0.0.1/avatar.png",
      banner: "https://cdn.conduit.market/conduit-test/banner.png",
      cachedAt: FIXED_NOW - 1_000,
    })

    const products = await getCachedMarketplaceProducts()
    const profiles = await getProfiles({ pubkeys: ["merchant"] })

    expect(products.data[0]?.product.images).toEqual([
      { url: "https://192.168.1.5/private.png" },
      { url: "https://cdn.conduit.market/conduit-test/public.png" },
    ])
    expect(getProductImageCandidates(products.data[0]!.product)).toEqual([
      { url: "https://cdn.conduit.market/conduit-test/public.png" },
    ])
    expect(profiles.data.merchant?.picture).toBeUndefined()
    expect(profiles.data.merchant?.banner).toBe(
      "https://cdn.conduit.market/conduit-test/banner.png"
    )
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
      images: [
        {
          url: "https://cdn.conduit.market/conduit-test/cached-json-summary.png",
        },
      ],
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
        images: [
          { url: `https://cdn.conduit.market/conduit-test/${pubkey}.png` },
        ],
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
    const productEvent = makeSignedProductEvent({
      dTag: "deleted-item",
      createdAt: 100,
      title: "Deleted Item",
    })
    const merchantPubkey = productEvent.pubkey
    const deletionEvent = makeSignedDeletionEvent({
      createdAt: 101,
      tags: [["a", `30402:${merchantPubkey}:deleted-item`]],
    })

    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) => {
        if (filter.kinds?.includes(EVENT_KINDS.PRODUCT)) {
          return [productEvent as never]
        }

        if (filter.kinds?.includes(EVENT_KINDS.DELETION)) {
          return [deletionEvent as never]
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

  it("keeps the broad deletion fallback for Merchant storefront reads", async () => {
    const merchantPubkey = "merchant"
    const productEvent = makeProductEvent({
      pubkey: merchantPubkey,
      dTag: "fallback-item",
      id: "event-fallback",
      createdAt: 100,
      title: "Fallback Item",
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

    await getMerchantStorefront({ merchantPubkey, limit: 10 })

    expect(deletionFilters).toHaveLength(3)
    expect(
      deletionFilters.some((filter) => !("#e" in filter) && !("#a" in filter))
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
      images: [
        { url: "https://cdn.conduit.market/conduit-test/cached-item.png" },
      ],
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
    const merchantPubkey = MERCHANT_A_PUBKEY
    const dTag = "deleted-cached-item"
    cachedProducts.push({
      id: `30402:${merchantPubkey}:${dTag}`,
      pubkey: merchantPubkey,
      dTag,
      title: "Deleted Cached Item",
      summary: "cached summary",
      price: 25,
      currency: "USD",
      type: "simple",
      visibility: "public",
      images: [
        {
          url: "https://cdn.conduit.market/conduit-test/deleted-cached-item.png",
        },
      ],
      tags: ["cached"],
      createdAt: 100_000,
      updatedAt: 100_000,
      cachedAt: FIXED_NOW - 1_000,
    })

    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) => {
        if (filter.kinds?.includes(EVENT_KINDS.DELETION)) {
          return [
            makeSignedDeletionEvent({
              createdAt: 101,
              tags: [["a", `30402:${merchantPubkey}:${dTag}`]],
            }) as never,
          ]
        }

        return []
      },
    })

    const result = await getMerchantStorefront({ merchantPubkey, limit: 10 })

    expect(result.data).toHaveLength(0)
  })

  it("keeps legacy cache rows exact-event-only when address metadata is missing or malformed", async () => {
    const merchantPubkey = MERCHANT_A_PUBKEY
    const missingAddress = `30402:${merchantPubkey}:legacy-missing-d`
    const malformedAddress = `30402:${merchantPubkey}:legacy-malformed-d`
    const exactAddress = `30402:${merchantPubkey}:legacy-exact-event`
    const exactEventId = "33".repeat(32)
    const makeLegacyRow = (
      id: string,
      eventId: string,
      title: string,
      dTag?: string
    ): CachedProduct => ({
      id,
      pubkey: merchantPubkey,
      ...(dTag === undefined ? {} : { dTag }),
      title,
      summary: "legacy cached product",
      price: 25,
      currency: "USD",
      type: "simple",
      visibility: "public",
      images: [
        {
          url: "https://cdn.conduit.market/conduit-test/legacy-cached-item.png",
        },
      ],
      tags: ["cached"],
      eventId,
      eventCreatedAt: id === exactAddress ? 200 : 100,
      createdAt: 100_000,
      updatedAt: 100_000,
      cachedAt: FIXED_NOW - 1_000,
    })

    cachedProducts.push(
      makeLegacyRow(
        missingAddress,
        "11".repeat(32),
        "Missing address metadata"
      ),
      makeLegacyRow(
        malformedAddress,
        "22".repeat(32),
        "Malformed address metadata",
        "different-coordinate"
      ),
      makeLegacyRow(
        exactAddress,
        exactEventId,
        "Exact-event legacy product",
        ""
      )
    )

    await cacheSignedProductDeletionEvent(
      makeSignedDeletionEvent({
        createdAt: 101,
        tags: [
          ["a", missingAddress],
          ["a", malformedAddress],
          ["e", exactEventId],
        ],
      })
    )

    const result = await getCachedMerchantStorefront({
      merchantPubkey,
      limit: 10,
      includeMarketHidden: true,
    })

    expect(result.data.map((record) => record.addressId).sort()).toEqual(
      [missingAddress, malformedAddress].sort()
    )
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
    expect(detail.meta.stale).toBe(true)
    expect(detail.meta.degraded).toBe(true)
    expect(batch.data[0]?.eventId).toBe(localProduct.id)
    expect(batch.data[0]?.product.stock).toBe(0)
    expect(batch.meta.stale).toBe(true)
    expect(batch.meta.degraded).toBe(true)
    expect(cachedProducts[0]?.eventId).toBe(localProduct.id)
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
      dTag: "locally-deleted-item",
      title: "Locally Deleted Item",
      summary: "cached summary",
      price: 25,
      currency: "USD",
      type: "simple",
      visibility: "public",
      images: [
        {
          url: "https://cdn.conduit.market/conduit-test/locally-deleted-item.png",
        },
      ],
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
      fetchEventsFanout: async () => [],
      fetchEventsFanoutWithDiagnostics: async (filter, options) => {
        const relayUrls = [...(options?.relayUrls ?? [])]
        return filter.kinds?.includes(EVENT_KINDS.PRODUCT)
          ? {
              events: [staleProduct],
              attemptedRelayUrls: relayUrls,
              successfulRelayUrls: relayUrls,
              failedRelayUrls: [],
            }
          : {
              events: [],
              attemptedRelayUrls: relayUrls,
              successfulRelayUrls: [],
              failedRelayUrls: relayUrls,
            }
      },
    })

    const result = await getProductDetail({ productId: addressId })

    expect(result.data).toBeNull()
  })

  it("uses cached source provenance when resolving exact-event detail deletions", async () => {
    const cachedSourceRelayUrl = "wss://cached-exact-source.conduit.market"
    const liveSourceRelayUrl = "wss://live-exact-source.conduit.market"
    const cachedProduct = makeSignedProductEvent({
      dTag: "exact-source-detail",
      createdAt: 100,
      title: "Exact source detail",
    })
    attachEventSourceRelayUrl(cachedProduct, cachedSourceRelayUrl)
    await cacheSignedProductListingEvent(cachedProduct)

    const liveProduct = new NDKEvent(undefined, cachedProduct.rawEvent())
    attachEventSourceRelayUrl(liveProduct, liveSourceRelayUrl)
    const deletion = makeSignedDeletionEvent({
      createdAt: 90,
      tags: [["e", cachedProduct.id]],
    })
    const deletionRelayAttempts: string[][] = []
    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter, options) => {
        if (filter.kinds?.includes(EVENT_KINDS.PRODUCT)) {
          return [liveProduct] as never
        }
        if (filter.kinds?.includes(EVENT_KINDS.DELETION)) {
          const relayUrls = options?.relayUrls ?? []
          deletionRelayAttempts.push([...relayUrls])
          return relayUrls.includes(cachedSourceRelayUrl)
            ? ([deletion] as never)
            : []
        }
        return []
      },
    })

    const result = await getProductDetail({ productId: cachedProduct.id })

    expect(result.data).toBeNull()
    expect(
      deletionRelayAttempts.some((relayUrls) =>
        relayUrls.includes(cachedSourceRelayUrl)
      )
    ).toBe(true)
  })

  it("uses approved owner source provenance for storefront deletion reads", async () => {
    const localRelayUrl = "wss://127.0.0.1:7447"
    const product = makeSignedProductEvent({
      dTag: "owner-source-deletion",
      createdAt: 100,
      title: "Owner source deletion",
    })
    attachEventSourceRelayUrl(product, localRelayUrl)
    __setRelayListTestOverrides({
      loadCached: async (pubkey) => ({
        pubkey,
        readRelayUrls: [],
        writeRelayUrls: [localRelayUrl],
        eventCreatedAt: 1,
        cachedAt: FIXED_NOW,
      }),
    })

    const deletionRelayAttempts: string[][] = []
    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter, options) => {
        if (filter.kinds?.includes(EVENT_KINDS.PRODUCT)) {
          return [product] as never
        }
        if (filter.kinds?.includes(EVENT_KINDS.DELETION)) {
          deletionRelayAttempts.push([...(options?.relayUrls ?? [])])
        }
        return []
      },
    })

    await getMerchantStorefront({
      merchantPubkey: product.pubkey,
      authenticatedPubkey: product.pubkey,
      limit: 10,
    })

    expect(deletionRelayAttempts.length).toBeGreaterThan(0)
    expect(
      deletionRelayAttempts.every((relayUrls) =>
        relayUrls.includes(localRelayUrl)
      )
    ).toBe(true)
  })

  it("treats a successful exact event-id detail read as complete", async () => {
    const product = makeSignedProductEvent({
      dTag: "exact-event-detail",
      createdAt: 100,
      title: "Exact event detail",
    })
    let productFilter: Record<string, unknown> | null = null
    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) => {
        if (filter.kinds?.includes(EVENT_KINDS.PRODUCT)) {
          productFilter = filter as Record<string, unknown>
          return [product] as never
        }
        return []
      },
    })

    const result = await getProductDetail({ productId: product.id })

    expect(productFilter).toMatchObject({ ids: [product.id] })
    expect(productFilter).not.toHaveProperty("limit")
    expect(result.data?.eventId).toBe(product.id)
    expect(result.meta).toMatchObject({
      stale: false,
      degraded: false,
      capped: false,
    })
  })

  it("suppresses direct product detail with a relay deletion event", async () => {
    const dTag = "relay-deleted-detail"
    const staleProduct = makeSignedProductEvent({
      dTag,
      createdAt: 100,
      title: "Relay Deleted Detail",
    })
    const addressId = `30402:${staleProduct.pubkey}:${dTag}`
    const deletion = makeSignedDeletionEvent({
      createdAt: 101,
      tags: [["a", addressId]],
    })

    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) =>
        filter.kinds?.includes(EVENT_KINDS.PRODUCT)
          ? ([staleProduct] as never)
          : filter.kinds?.includes(EVENT_KINDS.DELETION)
            ? ([deletion] as never)
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
    expect(result.diagnostics[0]?.issue).not.toBeNull()
  })

  it("suppresses relay-deleted products from batched live reads", async () => {
    const dTag = "relay-deleted-batch"
    const staleProduct = makeSignedProductEvent({
      dTag,
      createdAt: 100,
      title: "Relay Deleted Batch Item",
    })
    const addressId = `30402:${staleProduct.pubkey}:${dTag}`
    const deletion = makeSignedDeletionEvent({
      createdAt: 101,
      tags: [["a", addressId]],
    })

    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) =>
        filter.kinds?.includes(EVENT_KINDS.PRODUCT)
          ? ([staleProduct] as never)
          : filter.kinds?.includes(EVENT_KINDS.DELETION)
            ? ([deletion] as never)
            : [],
    })

    const result = await getProductsByIds([addressId], {
      includeMarketHidden: true,
    })

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
      images: [{ url: "https://cdn.conduit.market/conduit-test/product.png" }],
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
      allowMissingProtectedReadAuthorization: true,
      getNdk: async () => ({ signer: undefined }) as never,
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

  it("projects buyer summaries through the merchant cancellation reducer", async () => {
    const row = (
      id: string,
      type: CachedOrderMessage["type"],
      createdAt: number,
      payload: Record<string, unknown>
    ): CachedOrderMessage => ({
      id,
      orderId: "order-cancelled",
      type,
      senderPubkey: type === "order" ? "buyer" : "merchant",
      recipientPubkey: type === "order" ? "merchant" : "buyer",
      createdAt,
      rawContent: JSON.stringify({
        id,
        orderId: "order-cancelled",
        type,
        createdAt,
        senderPubkey: type === "order" ? "buyer" : "merchant",
        recipientPubkey: type === "order" ? "merchant" : "buyer",
        rawContent: "",
        payload,
      }),
      cachedAt: createdAt,
    })

    cachedOrderMessages.push(
      row("order", "order", FIXED_NOW - 5_000, {
        id: "order-cancelled",
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
        createdAt: FIXED_NOW - 5_000,
      }),
      row("accepted", "status_update", FIXED_NOW - 4_000, {
        status: "accepted",
      }),
      row("cancel", "status_update", FIXED_NOW - 3_000, {
        status: "cancelled",
      }),
      row("stale-shipping", "shipping_update", FIXED_NOW - 2_000, {
        carrier: "Stale",
        trackingNumber: "STALE",
      }),
      row("stale-processing", "status_update", FIXED_NOW - 1_000, {
        status: "processing",
      })
    )

    const result = await getCachedBuyerConversationList({
      principalPubkey: "buyer",
    })

    expect(result.data).toHaveLength(1)
    expect(result.data[0]).toMatchObject({
      status: "cancelled",
      latestType: "status_update",
      preview: "Status updated to cancelled",
      messageCount: 5,
    })
    expect(result.data[0]?.messages).toHaveLength(5)
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
      getNdk: async () => ({ signer: undefined }) as never,
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
      getNdk: async () => ({ signer: undefined }) as never,
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
      allowMissingProtectedReadAuthorization: true,
      getNdk: async () => ({ signer: undefined }) as never,
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
      allowMissingProtectedReadAuthorization: true,
      getNdk: async () => ({ signer: {} }) as never,
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
      allowMissingProtectedReadAuthorization: true,
      getNdk: async () => ({ signer: {} }) as never,
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
      allowMissingProtectedReadAuthorization: true,
      getNdk: async () => ({ signer: {} }) as never,
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

  it("reads gift wraps from declared inbox plus compatibility relays", async () => {
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
      allowMissingProtectedReadAuthorization: true,
      getNdk: async () => ({ signer: {} }) as never,
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

    // Permissive reads (CND-208): declared inbox relays lead the plan and the
    // bounded compatibility read set stays present even with local settings.
    expect(seenRelayUrls?.slice(0, merchantReadRelays.length)).toEqual(
      merchantReadRelays
    )
    for (const compatibilityRelayUrl of config.commerceDmFallbackRelayUrls) {
      expect(seenRelayUrls).toContain(compatibilityRelayUrl)
    }
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
      allowMissingProtectedReadAuthorization: true,
      getNdk: async () => ({ signer: {} }) as never,
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

  it("marks follow discovery stale when relay coverage is incomplete", async () => {
    __setCommerceTestOverrides({
      readLatestFollowLists: async () =>
        makeFollowListRead({
          pubkey: MERCHANT_A_PUBKEY,
          coverage: "unavailable",
        }),
    })

    const result = await getFollowPubkeys({ pubkey: MERCHANT_A_PUBKEY })

    expect(result.data).toEqual([])
    expect(result.meta.stale).toBe(true)
    expect(result.meta.degraded).toBe(true)
    expect(result.meta.eventObserved).toBe(false)
    expect(result.meta.coverage).toBe("unavailable")
  })

  it("marks an empty follow lookup unavailable and stale", async () => {
    const result = await getFollowPubkeys({ pubkey: "  " })

    expect(result.data).toEqual([])
    expect(result.meta.eventObserved).toBe(false)
    expect(result.meta.coverage).toBe("unavailable")
    expect(result.meta.stale).toBe(true)
    expect(result.meta.degraded).toBe(true)
  })

  it("distinguishes no follow event from a signed empty follow list", async () => {
    __setCommerceTestOverrides({
      readLatestFollowLists: async (input, options) => {
        expect(input).toEqual({
          pubkeys: [MERCHANT_A_PUBKEY],
          authenticatedPubkey: MERCHANT_A_PUBKEY,
        })
        expect(options.now?.()).toBe(FIXED_NOW)
        return makeFollowListRead({ pubkey: MERCHANT_A_PUBKEY })
      },
    })

    const notObserved = await getFollowPubkeys({
      pubkey: MERCHANT_A_PUBKEY,
      authenticatedPubkey: MERCHANT_A_PUBKEY,
    })
    expect(notObserved.data).toEqual([])
    expect(notObserved.meta.stale).toBe(false)
    expect(notObserved.meta.eventObserved).toBe(false)

    __setCommerceTestOverrides({
      readLatestFollowLists: async () =>
        makeFollowListRead({
          pubkey: MERCHANT_A_PUBKEY,
          event: {
            id: "2".repeat(64),
            pubkey: MERCHANT_A_PUBKEY,
            kind: EVENT_KINDS.CONTACT_LIST,
            created_at: 1_700_000_000,
            content: "",
            sig: "a".repeat(128),
            tags: [],
          },
        }),
    })

    const signedEmpty = await getFollowPubkeys({
      pubkey: MERCHANT_A_PUBKEY,
    })
    expect(signedEmpty.data).toEqual([])
    expect(signedEmpty.meta.stale).toBe(false)
    expect(signedEmpty.meta.eventObserved).toBe(true)
    expect(signedEmpty.meta.eventCreatedAt).toBe(1_700_000_000)
    expect(signedEmpty.meta.eventId).toBe("2".repeat(64))
  })

  it("projects the selected follow-list snapshot", async () => {
    __setCommerceTestOverrides({
      readLatestFollowLists: async () =>
        makeFollowListRead({
          pubkey: MERCHANT_A_PUBKEY,
          event: {
            id: "1".repeat(64),
            pubkey: MERCHANT_A_PUBKEY,
            kind: EVENT_KINDS.CONTACT_LIST,
            created_at: 1_700_000_000,
            content: "",
            sig: "a".repeat(128),
            tags: [["p", "c".repeat(64)]],
          },
        }),
    })

    const result = await getFollowPubkeys({ pubkey: MERCHANT_A_PUBKEY })

    expect(result.data).toEqual(["c".repeat(64)])
    expect(result.meta.eventId).toBe("1".repeat(64))
    expect(result.event?.id).toBe("1".repeat(64))
  })

  it("keeps retained follow evidence stale and cache-sourced", async () => {
    const event: SignedPublicNostrEvent = {
      id: "3".repeat(64),
      pubkey: MERCHANT_A_PUBKEY,
      kind: EVENT_KINDS.CONTACT_LIST,
      created_at: 1_700_000_000,
      content: "",
      sig: "a".repeat(128),
      tags: [["p", "d".repeat(64)]],
    }
    __setCommerceTestOverrides({
      readLatestFollowLists: async () =>
        makeFollowListRead({
          pubkey: MERCHANT_A_PUBKEY,
          event,
          coverage: "limited",
          snapshotState: "observed",
        }),
    })

    const result = await getFollowPubkeys({
      pubkey: MERCHANT_A_PUBKEY,
      authenticatedPubkey: MERCHANT_A_PUBKEY,
    })

    expect(result.data).toEqual(["d".repeat(64)])
    expect(result.meta.source).toBe("local_cache")
    expect(result.meta.stale).toBe(true)
    expect(result.meta.degraded).toBe(true)
    expect(result.meta.snapshotState).toBe("observed")
  })

  it("does not project an implausibly future retained follow snapshot", async () => {
    const futureEvent: SignedPublicNostrEvent = {
      id: "4".repeat(64),
      pubkey: MERCHANT_A_PUBKEY,
      kind: EVENT_KINDS.CONTACT_LIST,
      created_at: FIXED_NOW / 1_000 + 301,
      content: "",
      sig: "a".repeat(128),
      tags: [["p", "d".repeat(64)]],
    }
    __setCommerceTestOverrides({
      readLatestFollowLists: async () =>
        makeFollowListRead({
          pubkey: MERCHANT_A_PUBKEY,
          event: futureEvent,
          coverage: "limited",
          snapshotState: "observed",
        }),
    })

    const result = await getFollowPubkeys({
      pubkey: MERCHANT_A_PUBKEY,
      authenticatedPubkey: MERCHANT_A_PUBKEY,
    })

    expect(result.data).toEqual([])
    expect(result.event).toBeUndefined()
    expect(result.meta.eventObserved).toBe(false)
    expect(result.meta.coverage).toBe("limited")
    expect(result.meta.stale).toBe(true)
    expect(result.meta.degraded).toBe(true)
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

  it("revalidates a fresh public cache row from the authenticated owner's relay perspective", async () => {
    const localRelayUrl = "wss://127.0.0.1:7447"
    cachedProfiles.set("merchant", {
      pubkey: "merchant",
      displayName: "Public Cache",
      cachedAt: FIXED_NOW - 1_000,
    })
    __setRelayListTestOverrides({
      loadCached: async (pubkey) => ({
        pubkey,
        readRelayUrls: [],
        writeRelayUrls: [localRelayUrl],
        eventCreatedAt: 1,
        cachedAt: FIXED_NOW,
      }),
    })
    let seenRelayUrls: string[] | undefined
    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter, options) => {
        seenRelayUrls = options?.relayUrls
        return filter.kinds?.includes(EVENT_KINDS.PROFILE)
          ? ([
              {
                id: "profile-owner-local",
                pubkey: "merchant",
                created_at: 10,
                content: JSON.stringify({ display_name: "Owner Relay" }),
                tags: [],
              },
            ] as never)
          : []
      },
    })

    const result = await getProfiles({
      pubkeys: ["merchant"],
      authenticatedPubkey: "merchant",
    })

    expect(seenRelayUrls?.[0]).toBe(localRelayUrl)
    expect(seenRelayUrls).toContain(localRelayUrl)
    expect(result.data.merchant?.displayName).toBe("Owner Relay")
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
      getNdk: async () => {
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

  it("uses public cached product sources but drops stale private profile hints", async () => {
    cachedProducts.push({
      id: "30402:merchant:source-hinted-item",
      pubkey: "merchant",
      title: "Source Hinted Item",
      summary: "cached summary",
      price: 25,
      currency: "USD",
      type: "simple",
      visibility: "public",
      images: [
        {
          url: "https://cdn.conduit.market/conduit-test/source-hinted-item.png",
        },
      ],
      tags: ["cached"],
      sourceRelayUrls: [
        "wss://127.0.0.1:7447",
        "wss://profile-source.conduit.market",
      ],
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
          options?.relayUrls?.[0] === "wss://profile-source.conduit.market"
        ) {
          return [
            {
              id: "profile-merchant",
              pubkey: "merchant",
              created_at: 10,
              content: JSON.stringify({
                name: "Source Merchant",
                picture: "https://cdn.conduit.market/conduit-test/avatar.png",
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

    expect(seenRelayUrls?.[0]).toBe("wss://profile-source.conduit.market")
    expect(seenRelayUrls).not.toContain("wss://127.0.0.1:7447")
    expect(result.data.merchant?.name).toBe("Source Merchant")
    expect(result.data.merchant?.picture).toBe(
      "https://cdn.conduit.market/conduit-test/avatar.png"
    )
  })

  it("preserves an authenticated user's private relay in the current profile plan", async () => {
    const localRelayUrl = "wss://127.0.0.1:7447"
    cachedProducts.push({
      id: "30402:merchant:local-source-item",
      pubkey: "merchant",
      title: "Local Source Item",
      summary: "cached summary",
      price: 25,
      currency: "USD",
      type: "simple",
      visibility: "public",
      images: [
        {
          url: "https://cdn.conduit.market/conduit-test/local-source-item.png",
        },
      ],
      tags: ["cached"],
      sourceRelayUrls: [localRelayUrl],
      createdAt: FIXED_NOW - 5_000,
      updatedAt: FIXED_NOW - 5_000,
      cachedAt: FIXED_NOW - 1_000,
    })
    __setRelayListTestOverrides({
      loadCached: async (pubkey) => ({
        pubkey,
        readRelayUrls: [],
        writeRelayUrls: [localRelayUrl],
        eventCreatedAt: 1,
        cachedAt: FIXED_NOW,
      }),
    })

    let seenRelayUrls: string[] | undefined
    __setCommerceTestOverrides({
      fetchEventsFanout: async (_filter, options) => {
        seenRelayUrls = options?.relayUrls
        return []
      },
    })

    await getProfiles({
      pubkeys: ["merchant"],
      authenticatedPubkey: "merchant",
      priority: "background",
      skipCache: true,
      readPolicy: { maxRelays: 1 },
    })

    expect(seenRelayUrls).toEqual([localRelayUrl])
  })

  it("uses explicit product relay hints before default relays for profiles", async () => {
    let seenRelayUrls: string[] | undefined

    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter, options) => {
        seenRelayUrls = options?.relayUrls
        if (
          filter.kinds?.includes(EVENT_KINDS.PROFILE) &&
          options?.relayUrls?.[0] === "wss://live-product-source.conduit.market"
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
      readPolicy: { maxRelays: 2 },
      relayHintsByPubkey: {
        "live-merchant": [
          "https://live-product-source.conduit.market/?ignored=true",
          "wss://live-product-source.conduit.market",
          "wss://127.0.0.1:7447",
          "wss://service.test",
          "second-product-source.conduit.market/path?ignored=true",
          "wss://second-product-source.conduit.market/path",
        ],
      },
    })

    expect(seenRelayUrls).toEqual([
      "wss://live-product-source.conduit.market",
      "wss://second-product-source.conduit.market/path",
    ])
    expect(result.data["live-merchant"]?.displayName).toBe("Live Merchant")
  })

  it("drops public profile hints after planning during E2E isolation", async () => {
    const isolatedRelayUrl = "ws://127.0.0.1:7777"
    let seenRelayUrls: string[] | undefined
    Object.assign(config, applyE2eRelayIsolation(config, [isolatedRelayUrl]))
    __setCommerceTestOverrides({
      fetchEventsFanout: async (_filter, options) => {
        seenRelayUrls = options?.relayUrls
        return []
      },
    })

    await getProfiles({
      pubkeys: ["isolated-merchant"],
      skipCache: true,
      relayHintsByPubkey: {
        "isolated-merchant": ["wss://relay.damus.io"],
      },
    })

    expect(seenRelayUrls).toEqual([isolatedRelayUrl])
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

  it("bounds and parallelizes broad deletion-frontier discovery", async () => {
    const authorPubkeys = Array.from(
      { length: 129 },
      (_, index) => `merchant-${index}`
    )
    const productEvents = authorPubkeys.map((pubkey, index) =>
      makeProductEvent({
        pubkey,
        dTag: `deletion-item-${index}`,
        id: `deletion-event-${index}`,
        createdAt: 100 + index,
        title: `Deletion Item ${index}`,
      })
    )
    let activeDeletionFetches = 0
    let maxActiveDeletionFetches = 0
    let deletionFetchCalls = 0

    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) => {
        if (filter.kinds?.includes(EVENT_KINDS.PRODUCT)) {
          return productEvents as never
        }
        if (!filter.kinds?.includes(EVENT_KINDS.DELETION)) return []

        deletionFetchCalls += 1
        activeDeletionFetches += 1
        maxActiveDeletionFetches = Math.max(
          maxActiveDeletionFetches,
          activeDeletionFetches
        )
        await new Promise((resolve) => setTimeout(resolve, 1))
        activeDeletionFetches -= 1
        return []
      },
    })

    const result = await getMarketplaceProducts({
      authorPubkeys,
      readPolicy: { maxRelays: 1 },
      sort: "newest",
    })

    expect(deletionFetchCalls).toBe(6)
    expect(maxActiveDeletionFetches).toBeGreaterThan(1)
    expect(maxActiveDeletionFetches).toBeLessThanOrEqual(4)
    expect(result.data).toHaveLength(129)
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

    const firstResult = await getProfiles({
      pubkeys: ["merchant"],
      skipCache: true,
    })
    const secondResult = await getProfiles({
      pubkeys: ["merchant"],
      skipCache: true,
    })

    expect(firstResult.data.merchant?.name).toBe("ZALGEBAR")
    expect(secondResult.data.merchant?.name).toBe("ZALGEBAR")
    expect(firstResult.meta).toMatchObject({
      source: "public",
      stale: false,
      degraded: false,
    })
    expect(secondResult.meta).toMatchObject({
      source: "public",
      stale: false,
      degraded: false,
    })
    expect(cachedProfiles.get("merchant")).toMatchObject({
      name: "ZALGEBAR",
      rawContent: "{}",
      eventId: "profile-blank-newer",
      eventCreatedAt: 20,
    })
  })

  it("shares richer profile merging without changing the durable frontier", async () => {
    const latestContent = JSON.stringify({
      display_name: "",
      about: "Current relay bio",
      picture: "",
    })
    cachedProfiles.set("merchant", {
      pubkey: "merchant",
      displayName: "Cached Merchant",
      picture: "https://cdn.conduit.market/cached-avatar.png",
      rawContent: JSON.stringify({
        display_name: "Cached Merchant",
        picture: "https://cdn.conduit.market/cached-avatar.png",
      }),
      eventId: "profile-cached",
      eventCreatedAt: 10,
      cachedAt: FIXED_NOW - 1_000,
    })
    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) =>
        filter.kinds?.includes(EVENT_KINDS.PROFILE)
          ? ([
              {
                id: "profile-current",
                pubkey: "merchant",
                created_at: 20,
                content: latestContent,
                tags: [],
              },
            ] as never)
          : [],
    })

    const result = await getProfiles({
      pubkeys: ["merchant"],
      skipCache: true,
    })

    expect(result.data.merchant).toMatchObject({
      displayName: "Cached Merchant",
      about: "Current relay bio",
      picture: "https://cdn.conduit.market/cached-avatar.png",
    })
    expect(cachedProfiles.get("merchant")).toMatchObject({
      displayName: "Cached Merchant",
      about: "Current relay bio",
      picture: "https://cdn.conduit.market/cached-avatar.png",
      rawContent: latestContent,
      eventId: "profile-current",
      eventCreatedAt: 20,
    })
  })

  it("does not regress raw profile publish context during a forced narrower refresh", async () => {
    cachedProfiles.set("merchant", {
      pubkey: "merchant",
      name: "Current Merchant",
      rawContent: JSON.stringify({
        name: "Current Merchant",
        picture: "http://127.0.0.1/private-avatar.png",
      }),
      eventId: "profile-current",
      eventCreatedAt: 20,
      cachedAt: FIXED_NOW - 1_000,
    })
    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) =>
        filter.kinds?.includes(EVENT_KINDS.PROFILE)
          ? ([
              {
                id: "profile-older",
                pubkey: "merchant",
                created_at: 10,
                content: JSON.stringify({ name: "Older Relay View" }),
                tags: [],
              },
            ] as never)
          : [],
    })

    const result = await getProfiles({
      pubkeys: ["merchant"],
      skipCache: true,
    })

    expect(result.data.merchant?.name).toBe("Current Merchant")
    expect(result.meta).toMatchObject({
      source: "local_cache",
      stale: true,
      degraded: true,
    })
    expect(cachedProfiles.get("merchant")).toMatchObject({
      rawContent: JSON.stringify({
        name: "Current Merchant",
        picture: "http://127.0.0.1/private-avatar.png",
      }),
      eventId: "profile-current",
      eventCreatedAt: 20,
    })
  })

  it("repairs a stale projection when the exact cached event is observed", async () => {
    const eventId = "1".repeat(64)
    const rawContent = JSON.stringify({ name: "Alice" })
    cachedProfiles.set("merchant", {
      pubkey: "merchant",
      name: "Alice",
      about: "Stale enriched biography",
      rawContent,
      eventId,
      eventCreatedAt: 110,
      cachedAt: FIXED_NOW - 1_000,
    })
    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) =>
        filter.kinds?.includes(EVENT_KINDS.PROFILE)
          ? ([
              {
                id: eventId,
                pubkey: "merchant",
                created_at: 110,
                content: rawContent,
                tags: [],
              },
            ] as never)
          : [],
    })

    const result = await getProfiles({
      pubkeys: ["merchant"],
      skipCache: true,
    })

    expect(result.data.merchant).toMatchObject({ name: "Alice" })
    expect(result.data.merchant?.about).toBeUndefined()
    expect(result.meta).toMatchObject({
      source: "public",
      stale: false,
      degraded: false,
    })
    expect(cachedProfiles.get("merchant")).toMatchObject({
      name: "Alice",
      rawContent,
      eventId,
      eventCreatedAt: 110,
    })
    expect(cachedProfiles.get("merchant")?.about).toBeUndefined()
  })

  for (const scenario of [
    {
      label: "a newer timestamp",
      delayedId: "5".repeat(64),
      delayedCreatedAt: 105,
      winnerId: "1".repeat(64),
      winnerCreatedAt: 110,
    },
    {
      label: "the lower event id at an equal timestamp",
      delayedId: "7".repeat(64),
      delayedCreatedAt: 110,
      winnerId: "1".repeat(64),
      winnerCreatedAt: 110,
    },
  ]) {
    it(`atomically retains ${scenario.label} across concurrent profile refreshes`, async () => {
      const initialId = "9".repeat(64)
      cachedProfiles.set("merchant", {
        pubkey: "merchant",
        name: "Initial profile",
        rawContent: JSON.stringify({ name: "Initial profile" }),
        eventId: initialId,
        eventCreatedAt: 100,
        cachedAt: FIXED_NOW - 1_000,
      })

      let fetchCall = 0
      let markDelayedFetchStarted!: () => void
      let resumeDelayedFetch!: () => void
      const delayedFetchStarted = new Promise<void>((resolve) => {
        markDelayedFetchStarted = resolve
      })
      const delayedFetchGate = new Promise<void>((resolve) => {
        resumeDelayedFetch = resolve
      })
      __setCommerceTestOverrides({
        fetchEventsFanout: async (filter) => {
          if (!filter.kinds?.includes(EVENT_KINDS.PROFILE)) return []

          fetchCall += 1
          if (fetchCall === 1) {
            markDelayedFetchStarted()
            await delayedFetchGate
            return [
              {
                id: scenario.delayedId,
                pubkey: "merchant",
                created_at: scenario.delayedCreatedAt,
                content: JSON.stringify({ name: "Delayed loser" }),
                tags: [],
              } as never,
            ]
          }

          return [
            {
              id: scenario.winnerId,
              pubkey: "merchant",
              created_at: scenario.winnerCreatedAt,
              content: JSON.stringify({
                name: "Committed winner",
                bot: true,
                birthday: { year: 1990, month: 8 },
              }),
              tags: [],
            } as never,
          ]
        },
      })

      const delayedResultPromise = getProfiles({
        pubkeys: ["merchant"],
        skipCache: true,
      })
      await delayedFetchStarted

      const winnerResult = await getProfiles({
        pubkeys: ["merchant"],
        skipCache: true,
      })
      resumeDelayedFetch()
      const delayedResult = await delayedResultPromise

      expect(winnerResult.data.merchant?.name).toBe("Committed winner")
      expect(delayedResult.data.merchant?.name).toBe("Committed winner")
      expect(delayedResult.meta).toMatchObject({
        degraded: true,
        source: "local_cache",
        stale: true,
      })
      expect(cachedProfiles.get("merchant")).toMatchObject({
        name: "Committed winner",
        rawContent: JSON.stringify({
          name: "Committed winner",
          bot: true,
          birthday: { year: 1990, month: 8 },
        }),
        eventId: scenario.winnerId,
        eventCreatedAt: scenario.winnerCreatedAt,
      })
    })
  }

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
    expect(result.meta).toMatchObject({
      source: "local_cache",
      stale: true,
      degraded: true,
    })
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

describe("getProductsByIds diagnostics", () => {
  const dTag = "diagnosed-item"
  const merchantPubkey = MERCHANT_A_PUBKEY
  const addressId = `30402:${merchantPubkey}:${dTag}`

  it("reports a null issue only for an exact live coordinate match", async () => {
    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) =>
        filter.kinds?.includes(EVENT_KINDS.PRODUCT)
          ? ([
              makeProductEvent({
                pubkey: merchantPubkey,
                dTag,
                id: "event-live-diagnosed",
                createdAt: 100,
                title: "Live Diagnosed",
              }),
            ] as never)
          : [],
    })

    const result = await getProductsByIds([addressId])

    expect(result.diagnostics).toEqual([
      {
        productId: addressId,
        addressId,
        issue: null,
        coverage: { listing: "complete", deletion: "complete" },
      },
    ])
    expect(result.meta.degraded).toBe(false)
  })

  it("types malformed references without dropping valid coordinates", async () => {
    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) =>
        filter.kinds?.includes(EVENT_KINDS.PRODUCT)
          ? ([
              makeProductEvent({
                pubkey: merchantPubkey,
                dTag,
                id: "event-live-beside-invalid",
                createdAt: 100,
                title: "Live Beside Invalid",
              }),
            ] as never)
          : [],
    })

    const result = await getProductsByIds(["not-an-address", addressId])

    expect(result.data).toHaveLength(1)
    expect(result.diagnostics).toEqual([
      {
        productId: "not-an-address",
        addressId: null,
        issue: "invalid_product_reference",
      },
      {
        productId: addressId,
        addressId,
        issue: null,
        coverage: { listing: "complete", deletion: "complete" },
      },
    ])
    expect(result.meta.degraded).toBe(true)
  })

  it("returns product_missing only for an authoritative complete read", async () => {
    __setCommerceTestOverrides({
      fetchEventsFanout: async () => [],
    })

    const result = await getProductsByIds([addressId])

    expect(result.diagnostics[0]?.issue).toBe("product_missing")
  })

  it("keeps a partial read distinct from a missing listing", async () => {
    __setCommerceTestOverrides({
      fetchEventsFanoutWithDiagnostics: async () => ({
        events: [],
        attemptedRelayUrls: ["wss://ok.example", "wss://down.example"],
        successfulRelayUrls: ["wss://ok.example"],
        failedRelayUrls: ["wss://down.example"],
      }),
    })

    const result = await getProductsByIds([addressId])

    expect(result.diagnostics[0]?.issue).toBe("lookup_partial")
    expect(result.meta.degraded).toBe(true)
  })

  it("reports listing coverage independently for each requested author", async () => {
    const completedAddressId = `30402:${merchantPubkey}:completed-missing`
    const unavailablePubkey = getPublicKey(new Uint8Array(32).fill(19))
    const unavailableAddressId = `30402:${unavailablePubkey}:unavailable-item`
    __setCommerceTestOverrides({
      fetchEventsFanoutWithDiagnostics: async (filter, options) => {
        const relayUrls = [...(options?.relayUrls ?? [])]
        const unavailable = filter.authors?.includes(unavailablePubkey) ?? false
        return {
          events: [],
          attemptedRelayUrls: relayUrls,
          successfulRelayUrls: unavailable ? [] : relayUrls,
          failedRelayUrls: unavailable ? relayUrls : [],
        }
      },
    })

    const result = await getProductsByIds([
      completedAddressId,
      unavailableAddressId,
    ])

    expect(result.diagnostics).toEqual([
      {
        productId: completedAddressId,
        addressId: completedAddressId,
        issue: "product_missing",
        coverage: { listing: "complete", deletion: "complete" },
      },
      {
        productId: unavailableAddressId,
        addressId: unavailableAddressId,
        issue: "lookup_unavailable",
        coverage: { listing: "unavailable", deletion: "complete" },
      },
    ])
    expect(result.meta.degraded).toBe(true)
  })

  it("authorizes an exact live listing while surfacing partial coverage", async () => {
    const liveEvent = makeSignedProductEvent({
      dTag: "diagnosed-partial-live",
      createdAt: 100,
      title: "Partial Live",
      stock: 1,
    })
    const liveAddressId = `30402:${liveEvent.pubkey}:diagnosed-partial-live`
    __setCommerceTestOverrides({
      fetchEventsFanout: async () => [],
      fetchEventsFanoutWithDiagnostics: async (filter) =>
        filter.kinds?.includes(EVENT_KINDS.PRODUCT)
          ? {
              events: [liveEvent],
              attemptedRelayUrls: [
                "wss://ok.conduit.market",
                "wss://down.conduit.market",
              ],
              successfulRelayUrls: ["wss://ok.conduit.market"],
              failedRelayUrls: ["wss://down.conduit.market"],
            }
          : {
              events: [],
              attemptedRelayUrls: ["wss://ok.conduit.market"],
              successfulRelayUrls: ["wss://ok.conduit.market"],
              failedRelayUrls: [],
            },
    })

    const result = await getProductsByIds([liveAddressId])
    const checkout = composeCheckoutAvailability(result, {
      productId: liveAddressId,
      merchantPubkey: liveEvent.pubkey,
      title: "Partial Live",
    })

    expect(result.data[0]?.eventId).toBe(liveEvent.id)
    expect(result.diagnostics[0]).toMatchObject({
      issue: null,
      coverage: { listing: "partial" },
    })
    expect(result.meta.stale).toBe(true)
    expect(result.meta.degraded).toBe(true)
    expect(checkout.availability).toEqual([
      {
        merchantPubkey: liveEvent.pubkey,
        productId: liveAddressId,
        status: "available",
        stock: 1,
        refreshed: true,
      },
    ])
    expect(checkout.decision).toEqual({
      status: "verified_at_read",
      coverage: "partial",
    })
    expect(checkout.inventoryMessage).toBeNull()
  })

  it("surfaces a parked author relay without vetoing exact live evidence", async () => {
    const parkedRelayUrl = "wss://parked-author-hint.conduit.market"
    const liveEvent = makeSignedProductEvent({
      dTag: "diagnosed-parked-hint",
      createdAt: 100,
      title: "Parked Author Hint",
    })
    const liveAddressId = `30402:${liveEvent.pubkey}:diagnosed-parked-hint`
    const healthNow = Date.now()
    recordRelayFailure(parkedRelayUrl, healthNow)
    recordRelayFailure(parkedRelayUrl, healthNow)
    __setRelayListTestOverrides({
      now: () => FIXED_NOW,
      loadCached: async (pubkey) =>
        pubkey === liveEvent.pubkey
          ? {
              pubkey,
              readRelayUrls: [],
              writeRelayUrls: [parkedRelayUrl],
              eventCreatedAt: 1,
              cachedAt: FIXED_NOW,
            }
          : undefined,
    })
    __setCommerceTestOverrides({
      fetchEventsFanout: async () => [],
      fetchEventsFanoutWithDiagnostics: async (filter, options) => {
        const relayUrls = [...(options?.relayUrls ?? [])]
        expect(relayUrls).not.toContain(parkedRelayUrl)
        return {
          events: filter.kinds?.includes(EVENT_KINDS.PRODUCT)
            ? [liveEvent]
            : [],
          attemptedRelayUrls: relayUrls,
          successfulRelayUrls: relayUrls,
          failedRelayUrls: [],
        }
      },
    })

    const result = await getProductsByIds([liveAddressId])

    expect(result.data[0]?.eventId).toBe(liveEvent.id)
    expect(result.diagnostics[0]).toMatchObject({
      issue: null,
      coverage: { listing: "partial", deletion: "partial" },
    })
    expect(result.meta.source).toBe("commerce")
    expect(result.meta.stale).toBe(true)
    expect(result.meta.degraded).toBe(true)
  })

  it("does not certify a newer cached version from an older live address match", async () => {
    const dTag = "diagnosed-newer-cache"
    const olderLiveEvent = makeSignedProductEvent({
      dTag,
      createdAt: 100,
      title: "Older Live",
    })
    const newerCachedEvent = makeSignedProductEvent({
      dTag,
      createdAt: 200,
      title: "Newer Cached",
    })
    const cachedAddressId = `30402:${newerCachedEvent.pubkey}:${dTag}`
    await cacheSignedProductListingEvent(newerCachedEvent)
    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) =>
        filter.kinds?.includes(EVENT_KINDS.PRODUCT)
          ? ([olderLiveEvent] as never)
          : [],
    })

    const result = await getProductsByIds([cachedAddressId])

    expect(result.data[0]?.eventId).toBe(newerCachedEvent.id)
    expect(result.diagnostics[0]?.issue).toBe("cached_only")
    expect(result.meta.source).toBe("local_cache")
    expect(result.meta.stale).toBe(true)
    expect(result.meta.degraded).toBe(true)
  })

  it("honors a remote deletion when batch lookup is the first observer", async () => {
    const productEvent = makeSignedProductEvent({
      dTag: "diagnosed-remotely-deleted",
      createdAt: 100,
      title: "Remotely Deleted",
    })
    const deletedAddressId = `30402:${productEvent.pubkey}:diagnosed-remotely-deleted`
    const deletionEvent = makeSignedDeletionEvent({
      createdAt: 101,
      tags: [["a", deletedAddressId]],
    })
    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) => {
        if (filter.kinds?.includes(EVENT_KINDS.PRODUCT)) {
          return [productEvent as never]
        }
        if (filter.kinds?.includes(EVENT_KINDS.DELETION)) {
          return [deletionEvent as never]
        }
        return []
      },
    })

    const result = await getProductsByIds([deletedAddressId])

    expect(result.data).toHaveLength(0)
    expect(result.diagnostics[0]?.issue).not.toBeNull()
    expect(result.diagnostics[0]?.coverage?.deletion).toBe("complete")
  })

  it("allows a current live listing when one deletion relay is unavailable", async () => {
    const liveEvent = makeSignedProductEvent({
      dTag: "diagnosed-deletion-partial",
      createdAt: 100,
      title: "Deletion Coverage Partial",
    })
    const liveAddressId = `30402:${liveEvent.pubkey}:diagnosed-deletion-partial`
    __setCommerceTestOverrides({
      fetchEventsFanout: async () => [],
      fetchEventsFanoutWithDiagnostics: async (filter, options) => {
        const relayUrls = [...(options?.relayUrls ?? [])]
        if (filter.kinds?.includes(EVENT_KINDS.PRODUCT)) {
          return {
            events: [liveEvent],
            attemptedRelayUrls: relayUrls,
            successfulRelayUrls: relayUrls,
            failedRelayUrls: [],
          }
        }
        return {
          events: [],
          attemptedRelayUrls: [...relayUrls, "wss://unavailable.example"],
          successfulRelayUrls: relayUrls,
          failedRelayUrls: ["wss://unavailable.example"],
        }
      },
    })

    const result = await getProductsByIds([liveAddressId])

    expect(result.data[0]?.eventId).toBe(liveEvent.id)
    expect(result.diagnostics[0]).toMatchObject({
      issue: null,
      coverage: { listing: "complete", deletion: "partial" },
    })
    expect(result.meta.source).toBe("commerce")
    expect(result.meta.degraded).toBe(true)
  })

  it("allows positive live evidence when deletion discovery is unavailable", async () => {
    const liveEvent = makeSignedProductEvent({
      dTag: "diagnosed-deletion-unavailable",
      createdAt: 100,
      title: "Deletion Discovery Unavailable",
      stock: 1,
    })
    const liveAddressId = `30402:${liveEvent.pubkey}:diagnosed-deletion-unavailable`
    __setCommerceTestOverrides({
      fetchEventsFanout: async () => [],
      fetchEventsFanoutWithDiagnostics: async (filter, options) => {
        const relayUrls = [...(options?.relayUrls ?? [])]
        return filter.kinds?.includes(EVENT_KINDS.PRODUCT)
          ? {
              events: [liveEvent],
              attemptedRelayUrls: relayUrls,
              successfulRelayUrls: relayUrls,
              failedRelayUrls: [],
            }
          : {
              events: [],
              attemptedRelayUrls: relayUrls,
              successfulRelayUrls: [],
              failedRelayUrls: relayUrls,
            }
      },
    })

    const result = await getProductsByIds([liveAddressId])
    const checkout = composeCheckoutAvailability(result, {
      productId: liveAddressId,
      merchantPubkey: liveEvent.pubkey,
      title: "Deletion Discovery Unavailable",
    })

    expect(result.data[0]?.eventId).toBe(liveEvent.id)
    expect(result.diagnostics[0]).toMatchObject({
      issue: null,
      coverage: { listing: "complete", deletion: "unavailable" },
    })
    expect(result.meta.source).toBe("commerce")
    expect(result.meta.degraded).toBe(true)
    expect(checkout.decision).toEqual({
      status: "verified_at_read",
      coverage: "partial",
    })
    expect(checkout.inventoryMessage).toBeNull()
  })

  it("blocks cached-only terms when live listing reads are degraded", async () => {
    const cachedEvent = makeSignedProductEvent({
      dTag: "diagnosed-cached-partial",
      createdAt: 100,
      title: "Cached During Partial Read",
    })
    const cachedAddressId = `30402:${cachedEvent.pubkey}:diagnosed-cached-partial`
    await cacheSignedProductListingEvent(cachedEvent)
    __setCommerceTestOverrides({
      fetchEventsFanout: async () => [],
      fetchEventsFanoutWithDiagnostics: async (filter, options) => {
        const relayUrls = [...(options?.relayUrls ?? [])]
        return filter.kinds?.includes(EVENT_KINDS.PRODUCT)
          ? {
              events: [],
              attemptedRelayUrls: [...relayUrls, "wss://unavailable.example"],
              successfulRelayUrls: relayUrls,
              failedRelayUrls: ["wss://unavailable.example"],
            }
          : {
              events: [],
              attemptedRelayUrls: relayUrls,
              successfulRelayUrls: relayUrls,
              failedRelayUrls: [],
            }
      },
    })

    const result = await getProductsByIds([cachedAddressId])

    expect(result.data[0]?.eventId).toBe(cachedEvent.id)
    expect(result.diagnostics[0]).toMatchObject({
      issue: "lookup_partial",
      coverage: { listing: "partial" },
    })
    expect(result.meta.source).toBe("local_cache")
  })

  it("reports lookup_unavailable and keeps cached data when every relay fails", async () => {
    const cachedEvent = makeSignedProductEvent({
      dTag: "diagnosed-cached",
      createdAt: 100,
      title: "Cached While Offline",
    })
    const cachedAddressId = `30402:${cachedEvent.pubkey}:diagnosed-cached`
    await cacheSignedProductListingEvent(cachedEvent)
    __setCommerceTestOverrides({
      fetchEventsFanoutWithDiagnostics: async () => ({
        events: [],
        attemptedRelayUrls: ["wss://down.example"],
        successfulRelayUrls: [],
        failedRelayUrls: ["wss://down.example"],
      }),
    })

    const result = await getProductsByIds([cachedAddressId])

    expect(result.data).toHaveLength(1)
    expect(result.diagnostics[0]?.issue).toBe("lookup_unavailable")
    expect(result.meta.source).toBe("local_cache")
    expect(result.meta.degraded).toBe(true)
  })

  it("marks a cache-only confirmation after a complete live read", async () => {
    const cachedEvent = makeSignedProductEvent({
      dTag: "diagnosed-cache-only",
      createdAt: 100,
      title: "Cache Only Confirmation",
    })
    const cachedAddressId = `30402:${cachedEvent.pubkey}:diagnosed-cache-only`
    await cacheSignedProductListingEvent(cachedEvent)
    __setCommerceTestOverrides({
      fetchEventsFanout: async () => [],
    })

    const result = await getProductsByIds([cachedAddressId])

    expect(result.data).toHaveLength(1)
    expect(result.diagnostics[0]?.issue).toBe("cached_only")
  })

  it("types market-filtered listings instead of calling them missing", async () => {
    const productEvent = makeProductEvent({
      pubkey: "merchant",
      dTag: "diagnosed-filtered",
      id: "event-diagnosed-filtered",
      createdAt: 100,
      title: "Counterfeit goods display sample",
    })
    const filteredAddressId = "30402:merchant:diagnosed-filtered"
    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) =>
        filter.kinds?.includes(EVENT_KINDS.PRODUCT)
          ? ([productEvent] as never)
          : [],
    })

    const result = await getProductsByIds([filteredAddressId])

    expect(result.data).toHaveLength(0)
    expect(result.diagnostics[0]?.issue).toBe("listing_filtered")
  })
})
