import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  getBuyerConversationList,
  getConversationDetail,
  getMarketplaceProducts,
  getMerchantStorefront,
  getProfiles,
} from "@conduit/core"
import { EVENT_KINDS } from "@conduit/core"
import type {
  CachedOrderMessage,
  CachedProduct,
  CachedProfile,
} from "@conduit/core"

const FIXED_NOW = 1_700_000_000_000
let cachedProducts: CachedProduct[] = []
let cachedProfiles = new Map<string, CachedProfile>()
let cachedOrderMessages: CachedOrderMessage[] = []

function makeProductEvent(params: {
  pubkey: string
  dTag: string
  id: string
  createdAt: number
  title: string
}): {
  id: string
  pubkey: string
  created_at: number
  content: string
  tags: string[][]
} {
  return {
    id: params.id,
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
      createdAt: params.createdAt * 1000,
      updatedAt: params.createdAt * 1000,
    }),
    tags: [
      ["d", params.dTag],
      ["title", params.title],
      ["price", "25", "USD"],
      ["t", "test"],
    ],
  }
}

beforeEach(async () => {
  __resetCommerceTestOverrides()
  cachedProducts = []
  cachedProfiles = new Map()
  cachedOrderMessages = []
  __setCommerceTestOverrides({
    now: () => FIXED_NOW,
    getCachedProducts: async (merchantPubkey) =>
      cachedProducts.filter(
        (row) => !merchantPubkey || row.pubkey === merchantPubkey
      ),
    putCachedProducts: async (rows) => {
      for (const row of rows) {
        cachedProducts = [
          ...cachedProducts.filter((existing) => existing.id !== row.id),
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
  })
})

afterEach(async () => {
  __resetCommerceTestOverrides()
  cachedProducts = []
  cachedProfiles = new Map()
  cachedOrderMessages = []
})

describe("commerce gateway", () => {
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
