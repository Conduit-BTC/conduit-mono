import { nip19 } from "@nostr-dev-kit/ndk"
import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  getCachedProductDetail,
  getMarketplaceProducts,
  getProductDetail,
} from "./commerce"
import { toNostrPlainEvent } from "./ndk"
import {
  createRelayFrontierReadOutcome,
  type NostrPlainEvent,
} from "./relay-frontier"
import { mergeRelayHintsByPubkey, normalizeRelayHints } from "./relay-hints"
import {
  __resetRelayListTestOverrides,
  __setRelayListTestOverrides,
  type RelayList,
} from "./relay-list"
import {
  __resetRelayNetworkBudget,
  runWithRelayNetworkBudget,
} from "./relay-network-budget"

const PRODUCT_KIND = 30402

declare function describe(name: string, fn: () => void): void
declare function test(name: string, fn: () => void | Promise<void>): void
declare function afterEach(fn: () => void | Promise<void>): void
declare function expect(actual: unknown): {
  toBe(expected: unknown): void
  toEqual(expected: unknown): void
  toHaveLength(expected: number): void
  toContain(expected: unknown): void
  toBeLessThan(expected: number): void
  not: {
    toContain(expected: unknown): void
  }
}

afterEach(() => {
  __resetCommerceTestOverrides()
  __resetRelayListTestOverrides()
  __resetRelayNetworkBudget()
})

function productEvent(input: {
  id: string
  pubkey: string
  dTag: string
  title: string
  createdAt: number
}): NostrPlainEvent {
  const addressId = `${PRODUCT_KIND}:${input.pubkey}:${input.dTag}`
  return {
    id: input.id,
    pubkey: input.pubkey,
    created_at: input.createdAt,
    kind: PRODUCT_KIND,
    tags: [
      ["d", input.dTag],
      ["title", input.title],
      ["image", `https://cdn.example.com/${input.id}.jpg`],
    ],
    content: JSON.stringify({
      id: addressId,
      pubkey: input.pubkey,
      title: input.title,
      price: 10,
      currency: "USD",
      images: [{ url: `https://cdn.example.com/${input.id}.jpg` }],
      tags: ["test"],
      createdAt: input.createdAt * 1000,
      updatedAt: input.createdAt * 1000,
    }),
    sig: `${input.id}-sig`,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function relayList(pubkey: string, writeRelayUrls: string[]): RelayList {
  return {
    pubkey,
    readRelayUrls: [],
    writeRelayUrls,
    eventCreatedAt: 1,
    cachedAt: 1,
  }
}

describe("commerce product hydration", () => {
  test("normalizes, dedupes, and caps source relay hints", () => {
    expect(
      normalizeRelayHints([
        "Relay.Example.com/",
        "https://relay.example.com",
        "not a relay",
        "wss://second.example",
        "wss://third.example",
        "wss://fourth.example",
        "wss://fifth.example",
        "wss://sixth.example",
      ])
    ).toEqual([
      "wss://relay.example.com",
      "wss://second.example",
      "wss://third.example",
      "wss://fourth.example",
      "wss://fifth.example",
    ])

    expect(
      mergeRelayHintsByPubkey(
        { merchant: ["wss://one.example", "wss://two.example"] },
        { merchant: ["wss://two.example", "https://three.example"] }
      )
    ).toEqual({
      merchant: [
        "wss://one.example",
        "wss://two.example",
        "wss://three.example",
      ],
    })
  })

  test("keeps products from different merchants when d tags collide", async () => {
    const events = [
      productEvent({
        id: "event-a",
        pubkey: "merchant-a",
        dTag: "shared",
        title: "Merchant A Product",
        createdAt: 100,
      }),
      productEvent({
        id: "event-b",
        pubkey: "merchant-b",
        dTag: "shared",
        title: "Merchant B Product",
        createdAt: 200,
      }),
    ]
    const cachedWrites: unknown[] = []
    __setCommerceTestOverrides({
      fetchEventsFanout: async () => events as never,
      getCachedProducts: async () => [],
      putCachedProducts: async (rows) => {
        cachedWrites.push(...rows)
      },
      now: () => 1_000_000,
    })

    const result = await getMarketplaceProducts()

    expect(result.data.map((record) => record.addressId).sort()).toEqual([
      "30402:merchant-a:shared",
      "30402:merchant-b:shared",
    ])
    expect(cachedWrites).toHaveLength(2)
  })

  test("cached product detail resolves the exact full coordinate", async () => {
    const cachedAt = 1_000_000
    __setCommerceTestOverrides({
      getCachedProducts: async () => [
        {
          id: "30402:merchant-a:shared",
          pubkey: "merchant-a",
          title: "Merchant A Product",
          price: 10,
          currency: "USD",
          images: [{ url: "https://cdn.example.com/a.jpg" }],
          tags: [],
          cachedAt,
          createdAt: cachedAt,
          updatedAt: cachedAt,
        },
        {
          id: "30402:merchant-b:shared",
          pubkey: "merchant-b",
          title: "Merchant B Product",
          price: 12,
          currency: "USD",
          images: [{ url: "https://cdn.example.com/b.jpg" }],
          tags: [],
          cachedAt,
          createdAt: cachedAt,
          updatedAt: cachedAt,
        },
      ],
      now: () => cachedAt,
    })

    const result = await getCachedProductDetail({
      productId: "30402:merchant-b:shared",
    })

    expect(result.data?.addressId).toBe("30402:merchant-b:shared")
    expect(result.data?.product.title).toBe("Merchant B Product")
  })

  test("keeps author write-relay hints inside tight marketplace fanout", async () => {
    const relayLists = new Map<string, RelayList>([
      ["alice", relayList("alice", ["wss://alice-write.example"])],
      ["bob", relayList("bob", ["wss://bob-write.example"])],
    ])
    const requestedRelayUrls: string[][] = []
    __setRelayListTestOverrides({
      now: () => 100,
      loadCached: async (pubkey) => relayLists.get(pubkey),
      putCached: async () => undefined,
    })
    __setCommerceTestOverrides({
      fetchEventsFanout: async (_filter, options) => {
        requestedRelayUrls.push(options?.relayUrls ?? [])
        return [] as never
      },
      getCachedProducts: async () => [],
      putCachedProducts: async () => undefined,
      now: () => 1_000_000,
    })

    await getMarketplaceProducts({
      authorPubkeys: ["alice", "bob"],
      readPolicy: { maxRelays: 2 },
    })

    expect(requestedRelayUrls[0]).toEqual([
      "wss://alice-write.example",
      "wss://bob-write.example",
    ])
  })

  test("uses naddr relay hints before default relays for exact product detail", async () => {
    const merchantPubkey = "a".repeat(64)
    const dTag = "source-hinted"
    const event = productEvent({
      id: "event-source-hinted",
      pubkey: merchantPubkey,
      dTag,
      title: "Source Hinted Product",
      createdAt: 100,
    })
    const naddr = nip19.naddrEncode({
      kind: PRODUCT_KIND,
      pubkey: merchantPubkey,
      identifier: dTag,
      relays: ["relay-hint.example"],
    })
    let seenRelayUrls: string[] | undefined
    let seenSourceBuckets: Record<string, string> | undefined

    __setCommerceTestOverrides({
      fetchEventsFanout: async (_filter, options) => {
        seenRelayUrls = options?.relayUrls
        seenSourceBuckets = options?.sourceBucketsByRelayUrl
        return [event] as never
      },
      getCachedProducts: async () => [],
      putCachedProducts: async () => undefined,
      now: () => 1_000_000,
    })

    const result = await getProductDetail({ productId: naddr })

    expect(seenRelayUrls?.[0]).toBe("wss://relay-hint.example")
    expect(seenSourceBuckets).toEqual({
      "wss://relay-hint.example": "source_hint",
    })
    expect(result.data?.addressId).toBe(
      `${PRODUCT_KIND}:${merchantPubkey}:${dTag}`
    )
  })

  test("uses cached product source relays before default relays for exact product detail", async () => {
    const merchantPubkey = "merchant-with-cache"
    const dTag = "cached-source"
    const addressId = `${PRODUCT_KIND}:${merchantPubkey}:${dTag}`
    const event = productEvent({
      id: "event-cached-source",
      pubkey: merchantPubkey,
      dTag,
      title: "Cached Source Product",
      createdAt: 100,
    })
    let seenRelayUrls: string[] | undefined
    let seenSourceBuckets: Record<string, string> | undefined

    __setCommerceTestOverrides({
      fetchEventsFanout: async (_filter, options) => {
        seenRelayUrls = options?.relayUrls
        seenSourceBuckets = options?.sourceBucketsByRelayUrl
        return [event] as never
      },
      getCachedProducts: async (pubkey) =>
        pubkey === merchantPubkey
          ? [
              {
                id: addressId,
                pubkey: merchantPubkey,
                title: "Cached Product",
                price: 10,
                currency: "USD",
                images: [{ url: "https://cdn.example.com/cached.jpg" }],
                tags: [],
                cachedAt: 1_000_000,
                createdAt: 1_000_000,
                updatedAt: 1_000_000,
                sourceRelayUrls: ["cached-source.example"],
              },
            ]
          : [],
      putCachedProducts: async () => undefined,
      now: () => 1_000_000,
    })

    const result = await getProductDetail({ productId: addressId })

    expect(seenRelayUrls?.[0]).toBe("wss://cached-source.example")
    expect(seenSourceBuckets).toEqual({
      "wss://cached-source.example": "source_hint",
    })
    expect(result.data?.addressId).toBe(addressId)
  })
})

describe("relay frontier outcomes", () => {
  test("adapts NDK-shaped events into plain Nostr events", () => {
    const plain = toNostrPlainEvent({
      id: "event-id",
      pubkey: "merchant",
      created_at: 123,
      kind: PRODUCT_KIND,
      tags: [["d", "item"]],
      content: "body",
      sig: "signature",
      extra: "ignored",
    } as never)

    expect(plain).toEqual({
      id: "event-id",
      pubkey: "merchant",
      created_at: 123,
      kind: PRODUCT_KIND,
      tags: [["d", "item"]],
      content: "body",
      sig: "signature",
    })
  })

  test("classifies source outcomes without exposing NDK objects", () => {
    const outcome = createRelayFrontierReadOutcome({
      adapter: "ndk",
      relayUrl: "wss://relay.example",
      sourceBucket: "core_public_fallback",
      priorityClass: "user_publish",
      startedAt: 1_000,
      finishedAt: 1_125,
      eventsReceived: 3,
      eventsReturned: 2,
      duplicateEvents: 1,
      sourceHintsDiscovered: 1,
    })

    expect(outcome).toEqual({
      adapter: "ndk",
      relayUrl: "wss://relay.example",
      sourceBucket: "core_public_fallback",
      priorityClass: "user_publish",
      status: "success",
      startedAt: 1_000,
      finishedAt: 1_125,
      durationMs: 125,
      eventsReceived: 3,
      eventsReturned: 2,
      duplicateEvents: 1,
      malformedEvents: 0,
      sourceHintsDiscovered: 1,
    })
  })

  test("runs queued critical reads before ambient prefetch work", async () => {
    const started: string[] = []
    const release = deferred<void>()
    const blockerClasses = [
      "visible_marketplace_read",
      "visible_marketplace_read",
      "visible_marketplace_read",
      "visible_marketplace_read",
      "visible_marketplace_read",
      "background_hydration",
      "background_hydration",
      "background_hydration",
    ] as const
    const blockers = blockerClasses.map((budgetClass, index) =>
      runWithRelayNetworkBudget(
        async () => {
          started.push(`blocker-${index}`)
          await release.promise
          return index
        },
        {
          budgetClass,
          relayUrl: `wss://blocker-${index}.example`,
        }
      )
    )

    await Promise.resolve()
    expect(started).toHaveLength(8)

    const prefetch = runWithRelayNetworkBudget(
      async () => {
        started.push("prefetch")
        return "prefetch"
      },
      { budgetClass: "prefetch", relayUrl: "wss://prefetch.example" }
    )
    const critical = runWithRelayNetworkBudget(
      async () => {
        started.push("critical")
        return "critical"
      },
      {
        budgetClass: "critical_order_read",
        relayUrl: "wss://critical.example",
      }
    )

    expect(started).not.toContain("prefetch")
    expect(started).not.toContain("critical")

    release.resolve()
    await Promise.all([...blockers, prefetch, critical])

    expect(started.indexOf("critical")).toBeLessThan(
      started.indexOf("prefetch")
    )
  })
})
