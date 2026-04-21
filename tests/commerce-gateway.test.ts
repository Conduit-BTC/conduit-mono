import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  clearRelayOverrides,
  getBuyerConversationList,
  getConversationDetail,
  getMarketplaceProducts,
  getMerchantStorefront,
  getProfiles,
  saveRelayOverrides,
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
const store: Record<string, string> = {}
const originalLocalStorage = globalThis.localStorage

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
      images: [],
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
  Object.keys(store).forEach((key) => delete store[key])
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value
      },
      removeItem: (key: string) => {
        delete store[key]
      },
      clear: () => {
        Object.keys(store).forEach((key) => delete store[key])
      },
      length: 0,
      key: () => null,
    },
    writable: true,
    configurable: true,
  })
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
  clearRelayOverrides()
  Object.defineProperty(globalThis, "localStorage", {
    value: originalLocalStorage,
    writable: true,
    configurable: true,
  })
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
      images: [],
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

  it("uses commerce relays for marketplace browse when configured", async () => {
    saveRelayOverrides({
      custom: {
        merchant: [],
        commerce: [
          {
            url: "wss://commerce-only.test",
            role: "commerce",
            source: "custom",
            out: false,
            in: true,
            find: true,
            dm: false,
          },
        ],
        general: [],
      },
      states: {
        merchant: {},
        commerce: {},
        general: {
          "wss://relay.primal.net": { hidden: true },
          "wss://relay.damus.io": { hidden: true },
          "wss://nos.lol": { hidden: true },
          "wss://relay.nostr.band": { hidden: true },
          "wss://purplepag.es": { hidden: true },
          "wss://relay.nostr.net": { hidden: true },
          "wss://sendit.nosflare.com": { hidden: true },
          "wss://relay.plebeian.market": { hidden: true },
        },
      },
    })

    let seenRelayUrls: string[] | undefined
    __setCommerceTestOverrides({
      fetchEventsFanout: async (_filter, options) => {
        seenRelayUrls = options?.relayUrls
        return []
      },
    })

    await getMarketplaceProducts({ limit: 10 })

    expect(seenRelayUrls).toContain("wss://commerce-only.test")
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

  it("keeps merchant storefront reads compatible with commerce fallback relays", async () => {
    saveRelayOverrides({
      custom: {
        merchant: [],
        commerce: [
          {
            url: "wss://commerce-fallback.test",
            role: "commerce",
            source: "custom",
            out: false,
            in: true,
            find: true,
            dm: false,
          },
        ],
        general: [],
      },
      states: {
        merchant: {},
        commerce: {},
        general: {},
      },
    })

    let seenRelayUrls: string[] | undefined
    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter, options) => {
        if (filter.kinds?.includes(EVENT_KINDS.PRODUCT)) {
          seenRelayUrls = options?.relayUrls
        }
        return []
      },
    })

    await getMerchantStorefront({ merchantPubkey: "merchant", limit: 10 })

    expect(seenRelayUrls).toContain("wss://commerce-fallback.test")
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
      requireNdkConnected: async () =>
        ({
          fetchEvents: async () =>
            new Set([
              {
                id: "profile-1",
                pubkey: "alice",
                created_at: 10,
                content: JSON.stringify({ display_name: "Alice" }),
                tags: [],
              },
            ]),
        }) as never,
    })

    const firstResult = await getProfiles({ pubkeys: ["alice", "alice"] })

    expect(Object.keys(firstResult.data)).toEqual(["alice"])
    expect(firstResult.data.alice?.displayName).toBe("Alice")
    expect(firstResult.meta.source).toBe("public")
    expect(cachedProfiles.get("alice")?.displayName).toBe("Alice")

    __setCommerceTestOverrides({
      requireNdkConnected: async () => {
        throw new Error("offline")
      },
    })

    const secondResult = await getProfiles({ pubkeys: ["alice"] })

    expect(secondResult.meta.source).toBe("local_cache")
    expect(secondResult.data.alice?.displayName).toBe("Alice")
  })
})
