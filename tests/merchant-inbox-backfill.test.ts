import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  EVENT_KINDS,
  getMerchantConversationList,
  type CachedOrderMessage,
} from "@conduit/core"
import { attachEventSourceRelayUrl } from "@conduit/core/protocol/ndk"

const MERCHANT = "merchant-pubkey"
const BUYER = "buyer-pubkey"
const RELAY = "wss://inbox.example"

let cachedOrderMessages: CachedOrderMessage[] = []

function wrapEvent(id: string, createdAt: number) {
  return {
    id,
    kind: EVENT_KINDS.GIFT_WRAP,
    pubkey: `ephemeral-${id}`,
    created_at: createdAt,
    content: "wrapped",
    tags: [["p", MERCHANT]],
  }
}

function ignoredRumor(id: string) {
  return {
    id: `ignored-${id}`,
    kind: 1,
    pubkey: BUYER,
    created_at: 1,
    content: "ignored",
    tags: [],
  }
}

function orderRumor(orderId: string, createdAt: number) {
  return {
    id: `rumor-${orderId}`,
    kind: EVENT_KINDS.ORDER,
    pubkey: BUYER,
    created_at: createdAt,
    content: JSON.stringify({
      id: orderId,
      merchantPubkey: MERCHANT,
      buyerPubkey: BUYER,
      items: [
        {
          productId: `30402:${MERCHANT}:coffee`,
          quantity: 1,
          priceAtPurchase: 1_000,
          currency: "SATS",
        },
      ],
      subtotal: 1_000,
      currency: "SATS",
      createdAt: createdAt * 1_000,
    }),
    tags: [
      ["p", MERCHANT],
      ["type", "order"],
      ["order", orderId],
      ["amount", "1000"],
      ["currency", "SATS"],
    ],
  }
}

function successfulPage(
  events: ReturnType<typeof wrapEvent>[],
  relayUrls: readonly string[]
) {
  for (const event of events) {
    attachEventSourceRelayUrl(event as never, RELAY)
  }
  return {
    events: events as never,
    attemptedRelayUrls: [...relayUrls],
    successfulRelayUrls: [...relayUrls],
    failedRelayUrls: [],
  }
}

function recentPage(startAt: number, count = 400) {
  return Array.from({ length: count }, (_, index) =>
    wrapEvent(`recent-${startAt}-${index}`, startAt - index)
  )
}

function installBaseOverrides() {
  __setCommerceTestOverrides({
    now: () => 1_700_000_000_000,
    requireNdkConnected: async () => ({ signer: {} }) as never,
    resolveInboxRelayUrls: async () => [RELAY],
    fetchEventsFanout: async () => [],
    getCachedOrderMessages: async () => cachedOrderMessages,
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
}

beforeEach(() => {
  __resetCommerceTestOverrides()
  cachedOrderMessages = []
  installBaseOverrides()
})

afterEach(() => {
  __resetCommerceTestOverrides()
  cachedOrderMessages = []
})

describe("merchant priority inbox backfill", () => {
  it("walks an inclusive outer-wrap cursor and includes an older order", async () => {
    const firstPage = recentPage(1_000)
    const boundary = firstPage[firstPage.length - 1]!
    const olderOrderWrap = wrapEvent("older-actionable-order", 600)
    const seenUntil: Array<number | undefined> = []

    __setCommerceTestOverrides({
      fetchEventsFanoutWithDiagnostics: async (filter, options) => {
        seenUntil.push(filter.until)
        return filter.until === undefined
          ? successfulPage(firstPage, options?.relayUrls ?? [])
          : successfulPage([boundary, olderOrderWrap], options?.relayUrls ?? [])
      },
      giftUnwrap: async (event) =>
        (event.id === olderOrderWrap.id
          ? orderRumor("order-older-actionable", 600)
          : ignoredRumor(event.id)) as never,
    })

    const result = await getMerchantConversationList({
      principalPubkey: MERCHANT,
      sort: "merchant_priority",
    })

    expect(seenUntil).toEqual([undefined, 601])
    expect(result.data.map((conversation) => conversation.orderId)).toEqual([
      "order-older-actionable",
    ])
    expect(result.meta.inbox?.coverage).toBe("complete")
    expect(result.meta.inbox?.historyCoverage).toBe("complete_within_scope")
    expect(result.meta.degraded).toBe(false)
  })

  it("reuses an overlapping recent page until the periodic deep rescan", async () => {
    const firstPage = recentPage(1_000)
    const boundary = firstPage[firstPage.length - 1]!
    const seenUntil: Array<number | undefined> = []
    let currentNow = 0

    __setCommerceTestOverrides({
      now: () => currentNow,
      fetchEventsFanoutWithDiagnostics: async (filter, options) => {
        seenUntil.push(filter.until)
        return filter.until === undefined
          ? successfulPage(firstPage, options?.relayUrls ?? [])
          : successfulPage([boundary], options?.relayUrls ?? [])
      },
      giftUnwrap: async (event) => ignoredRumor(event.id) as never,
    })

    const first = await getMerchantConversationList({
      principalPubkey: MERCHANT,
      sort: "merchant_priority",
    })
    const second = await getMerchantConversationList({
      principalPubkey: MERCHANT,
      sort: "merchant_priority",
    })
    currentNow = 300_001
    const third = await getMerchantConversationList({
      principalPubkey: MERCHANT,
      sort: "merchant_priority",
    })

    expect(seenUntil).toEqual([undefined, 601, undefined, undefined, 601])
    expect(first.meta.inbox?.historyCoverage).toBe("complete_within_scope")
    expect(second.meta.inbox?.historyCoverage).toBe("complete_within_scope")
    expect(second.meta.degraded).toBe(false)
    expect(third.meta.inbox?.historyCoverage).toBe("complete_within_scope")
  })

  it("falls back to a deep scan when a saturated recent window is unbridged", async () => {
    const firstWindow = recentPage(2_000)
    const firstBoundary = firstWindow[firstWindow.length - 1]!
    const nextWindow = Array.from({ length: 400 }, (_, index) =>
      wrapEvent(`new-window-${index}`, 3_000 - index)
    )
    const nextBoundary = nextWindow[nextWindow.length - 1]!
    let useNextWindow = false
    const seenUntil: Array<number | undefined> = []

    __setCommerceTestOverrides({
      fetchEventsFanoutWithDiagnostics: async (filter, options) => {
        seenUntil.push(filter.until)
        if (filter.until === undefined) {
          return successfulPage(
            useNextWindow ? nextWindow : firstWindow,
            options?.relayUrls ?? []
          )
        }
        return successfulPage(
          [useNextWindow ? nextBoundary : firstBoundary],
          options?.relayUrls ?? []
        )
      },
      giftUnwrap: async (event) => ignoredRumor(event.id) as never,
    })

    await getMerchantConversationList({
      principalPubkey: MERCHANT,
      sort: "merchant_priority",
    })
    useNextWindow = true
    const second = await getMerchantConversationList({
      principalPubkey: MERCHANT,
      sort: "merchant_priority",
    })

    expect(seenUntil).toEqual([undefined, 1_601, undefined, 2_601])
    expect(second.meta.inbox?.historyCoverage).toBe("complete_within_scope")
  })

  it("falls back to a deep scan when a relay enters the read plan", async () => {
    const relayB = "wss://new-inbox.example"
    const firstWindow = recentPage(1_000)
    const boundary = firstWindow[firstWindow.length - 1]!
    for (const event of firstWindow) {
      attachEventSourceRelayUrl(event as never, RELAY)
    }
    attachEventSourceRelayUrl(boundary as never, RELAY)
    const relayBWrap = wrapEvent("new-relay-wrap", 1_001)
    attachEventSourceRelayUrl(relayBWrap as never, relayB)
    let includeRelayB = false
    const seenUntil: Array<number | undefined> = []

    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () =>
        includeRelayB ? [RELAY, relayB] : [RELAY],
      fetchEventsFanoutWithDiagnostics: async (filter, options) => {
        seenUntil.push(filter.until)
        if (!includeRelayB) {
          return filter.until === undefined
            ? successfulPage(firstWindow, options?.relayUrls ?? [])
            : successfulPage([boundary], options?.relayUrls ?? [])
        }
        const relayUrls = options?.relayUrls ?? []
        return filter.until === undefined
          ? {
              events: [relayBWrap, ...firstWindow] as never,
              attemptedRelayUrls: [...relayUrls],
              successfulRelayUrls: [...relayUrls],
              failedRelayUrls: [],
            }
          : {
              events: [boundary] as never,
              attemptedRelayUrls: [...relayUrls],
              successfulRelayUrls: [...relayUrls],
              failedRelayUrls: [],
            }
      },
      giftUnwrap: async (event) => ignoredRumor(event.id) as never,
    })

    await getMerchantConversationList({
      principalPubkey: MERCHANT,
      sort: "merchant_priority",
    })
    includeRelayB = true
    const second = await getMerchantConversationList({
      principalPubkey: MERCHANT,
      sort: "merchant_priority",
    })

    expect(seenUntil).toEqual([undefined, 601, undefined, 601])
    expect(second.meta.inbox?.historyCoverage).toBe("complete_within_scope")
  })

  it("treats a planned skipped relay as partial and rescans when it returns", async () => {
    const relayB = "wss://parked-inbox.example"
    const firstWindow = recentPage(1_000)
    const boundary = firstWindow[firstWindow.length - 1]!
    for (const event of firstWindow) {
      attachEventSourceRelayUrl(event as never, RELAY)
    }
    const relayBWrap = wrapEvent("returned-relay-wrap", 1_001)
    attachEventSourceRelayUrl(relayBWrap as never, relayB)
    let relayBAvailable = false
    const seenUntil: Array<number | undefined> = []

    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [RELAY, relayB],
      fetchEventsFanoutWithDiagnostics: async (filter, options) => {
        seenUntil.push(filter.until)
        const plannedRelayUrls = [...(options?.relayUrls ?? [])]
        const attemptedRelayUrls = relayBAvailable
          ? plannedRelayUrls
          : plannedRelayUrls.filter((relayUrl) => relayUrl !== relayB)
        return {
          events:
            filter.until === undefined
              ? ([
                  ...(relayBAvailable ? [relayBWrap] : []),
                  ...firstWindow,
                ] as never)
              : ([boundary] as never),
          attemptedRelayUrls,
          successfulRelayUrls: attemptedRelayUrls,
          failedRelayUrls: [],
        }
      },
      giftUnwrap: async (event) => ignoredRumor(event.id) as never,
    })

    const first = await getMerchantConversationList({
      principalPubkey: MERCHANT,
      sort: "merchant_priority",
    })
    relayBAvailable = true
    const second = await getMerchantConversationList({
      principalPubkey: MERCHANT,
      sort: "merchant_priority",
    })

    expect(first.meta.inbox?.coverage).toBe("partial")
    expect(first.meta.inbox?.historyCoverage).toBe("complete_within_scope")
    expect(seenUntil).toEqual([undefined, 601, undefined, 601])
    expect(second.meta.inbox?.coverage).toBe("complete")
    expect(second.meta.inbox?.historyCoverage).toBe("complete_within_scope")
  })

  it("uses the newest saturated relay boundary so fanout cannot skip history", async () => {
    const relayA = "wss://inbox-a.example"
    const relayB = "wss://inbox-b.example"
    const relayAPage = Array.from({ length: 400 }, (_, index) =>
      wrapEvent(`relay-a-${index}`, 1_000 - index)
    )
    const relayBPage = Array.from({ length: 400 }, (_, index) =>
      wrapEvent(`relay-b-${index}`, 900 - index)
    )
    for (const event of relayAPage) {
      attachEventSourceRelayUrl(event as never, relayA)
    }
    for (const event of relayBPage) {
      attachEventSourceRelayUrl(event as never, relayB)
    }
    const olderOrderWrap = wrapEvent("relay-a-older-order", 600)
    attachEventSourceRelayUrl(olderOrderWrap as never, relayA)
    const seenUntil: Array<number | undefined> = []

    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [relayA, relayB],
      fetchEventsFanoutWithDiagnostics: async (filter, options) => {
        seenUntil.push(filter.until)
        const relayUrls = options?.relayUrls ?? []
        return filter.until === undefined
          ? {
              events: [...relayAPage, ...relayBPage] as never,
              attemptedRelayUrls: [...relayUrls],
              successfulRelayUrls: [...relayUrls],
              failedRelayUrls: [],
            }
          : {
              events: [olderOrderWrap] as never,
              attemptedRelayUrls: [...relayUrls],
              successfulRelayUrls: [...relayUrls],
              failedRelayUrls: [],
            }
      },
      giftUnwrap: async (event) =>
        (event.id === olderOrderWrap.id
          ? orderRumor("order-safe-fanout-cursor", 600)
          : ignoredRumor(event.id)) as never,
    })

    const result = await getMerchantConversationList({
      principalPubkey: MERCHANT,
      sort: "merchant_priority",
    })

    // Relay A saturated at 601 while relay B reached 501. Using the globally
    // oldest timestamp (501) would skip Relay A's order at 600.
    expect(seenUntil).toEqual([undefined, 601])
    expect(result.data[0]?.orderId).toBe("order-safe-fanout-cursor")
  })

  it("keeps default recent merchant reads to one page", async () => {
    const filters: Array<{ until?: number }> = []
    __setCommerceTestOverrides({
      fetchEventsFanoutWithDiagnostics: async (filter, options) => {
        filters.push({ until: filter.until })
        return successfulPage(recentPage(1_000), options?.relayUrls ?? [])
      },
      giftUnwrap: async (event) => ignoredRumor(event.id) as never,
    })

    const result = await getMerchantConversationList({
      principalPubkey: MERCHANT,
    })

    expect(filters).toEqual([{ until: undefined }])
    expect(result.meta.inbox?.historyCoverage).toBe("recent_only")
    expect(result.meta.degraded).toBe(false)
  })

  it("stops at an inclusive same-second cursor rather than skipping ties", async () => {
    const saturatedTimestamp = Array.from({ length: 400 }, (_, index) =>
      wrapEvent(`same-second-${index}`, 100)
    )
    const seenUntil: Array<number | undefined> = []

    __setCommerceTestOverrides({
      fetchEventsFanoutWithDiagnostics: async (filter, options) => {
        seenUntil.push(filter.until)
        return successfulPage(saturatedTimestamp, options?.relayUrls ?? [])
      },
      giftUnwrap: async (event) => ignoredRumor(event.id) as never,
    })

    const result = await getMerchantConversationList({
      principalPubkey: MERCHANT,
      queue: "paid_fulfill",
    })

    expect(seenUntil).toEqual([undefined, 100])
    expect(result.meta.inbox?.coverage).toBe("complete")
    expect(result.meta.inbox?.historyCoverage).toBe("cursor_stalled")
    expect(result.meta.degraded).toBe(true)
  })

  it("carries a stalled outcome after one overlapping recent page", async () => {
    const saturatedTimestamp = Array.from({ length: 400 }, (_, index) =>
      wrapEvent(`carried-stall-${index}`, 100)
    )
    const seenUntil: Array<number | undefined> = []

    __setCommerceTestOverrides({
      fetchEventsFanoutWithDiagnostics: async (filter, options) => {
        seenUntil.push(filter.until)
        return successfulPage(saturatedTimestamp, options?.relayUrls ?? [])
      },
      giftUnwrap: async (event) => ignoredRumor(event.id) as never,
    })

    await getMerchantConversationList({
      principalPubkey: MERCHANT,
      sort: "merchant_priority",
    })
    const second = await getMerchantConversationList({
      principalPubkey: MERCHANT,
      sort: "merchant_priority",
    })

    expect(seenUntil).toEqual([undefined, 100, undefined])
    expect(second.meta.inbox?.historyCoverage).toBe("cursor_stalled")
    expect(second.meta.degraded).toBe(true)
  })

  it("caps a progressing history read at four pages", async () => {
    const seenUntil: Array<number | undefined> = []
    let nextStart = 4_000

    __setCommerceTestOverrides({
      fetchEventsFanoutWithDiagnostics: async (filter, options) => {
        seenUntil.push(filter.until)
        const page = recentPage(nextStart)
        nextStart -= 400
        return successfulPage(page, options?.relayUrls ?? [])
      },
      giftUnwrap: async (event) => ignoredRumor(event.id) as never,
    })

    const result = await getMerchantConversationList({
      principalPubkey: MERCHANT,
      sort: "merchant_priority",
    })

    expect(seenUntil).toHaveLength(4)
    expect(result.meta.inbox?.coverage).toBe("complete")
    expect(result.meta.inbox?.historyCoverage).toBe("bounded")
    expect(result.meta.degraded).toBe(true)
  })

  it("carries a bounded outcome after one overlapping recent page", async () => {
    const pages = [
      recentPage(4_000),
      recentPage(3_601),
      recentPage(3_202),
      recentPage(2_803),
    ]
    const pageByUntil = new Map<number, ReturnType<typeof recentPage>>([
      [3_601, pages[1]!],
      [3_202, pages[2]!],
      [2_803, pages[3]!],
    ])
    const seenUntil: Array<number | undefined> = []

    __setCommerceTestOverrides({
      fetchEventsFanoutWithDiagnostics: async (filter, options) => {
        seenUntil.push(filter.until)
        return successfulPage(
          filter.until === undefined
            ? pages[0]!
            : (pageByUntil.get(filter.until) ?? []),
          options?.relayUrls ?? []
        )
      },
      giftUnwrap: async (event) => ignoredRumor(event.id) as never,
    })

    const first = await getMerchantConversationList({
      principalPubkey: MERCHANT,
      sort: "merchant_priority",
    })
    const second = await getMerchantConversationList({
      principalPubkey: MERCHANT,
      sort: "merchant_priority",
    })

    expect(seenUntil).toEqual([undefined, 3_601, 3_202, 2_803, undefined])
    expect(first.meta.inbox?.historyCoverage).toBe("bounded")
    expect(second.meta.inbox?.historyCoverage).toBe("bounded")
    expect(second.meta.degraded).toBe(true)
  })

  it("keeps relay failure separate from interrupted history", async () => {
    let page = 0
    __setCommerceTestOverrides({
      fetchEventsFanoutWithDiagnostics: async (_filter, options) => {
        page += 1
        const relayUrls = options?.relayUrls ?? []
        if (page === 1) return successfulPage(recentPage(1_000), relayUrls)
        return {
          events: [],
          attemptedRelayUrls: [...relayUrls],
          successfulRelayUrls: [],
          failedRelayUrls: [...relayUrls],
        }
      },
      giftUnwrap: async (event) => ignoredRumor(event.id) as never,
    })

    const result = await getMerchantConversationList({
      principalPubkey: MERCHANT,
      sort: "merchant_priority",
    })

    expect(result.meta.inbox?.coverage).toBe("partial")
    expect(result.meta.inbox?.historyCoverage).toBe("interrupted")
    expect(result.meta.degraded).toBe(true)
  })

  it("backs off an interrupted deep retry while still checking the recent page", async () => {
    const firstPage = recentPage(1_000)
    let currentNow = 0
    const seenUntil: Array<number | undefined> = []

    __setCommerceTestOverrides({
      now: () => currentNow,
      fetchEventsFanoutWithDiagnostics: async (filter, options) => {
        seenUntil.push(filter.until)
        const relayUrls = options?.relayUrls ?? []
        return filter.until === undefined
          ? successfulPage(firstPage, relayUrls)
          : {
              events: [],
              attemptedRelayUrls: [...relayUrls],
              successfulRelayUrls: [],
              failedRelayUrls: [...relayUrls],
            }
      },
      giftUnwrap: async (event) => ignoredRumor(event.id) as never,
    })

    const first = await getMerchantConversationList({
      principalPubkey: MERCHANT,
      sort: "merchant_priority",
    })
    const second = await getMerchantConversationList({
      principalPubkey: MERCHANT,
      sort: "merchant_priority",
    })
    currentNow = 120_001
    const third = await getMerchantConversationList({
      principalPubkey: MERCHANT,
      sort: "merchant_priority",
    })

    expect(seenUntil).toEqual([undefined, 601, undefined, undefined, 601])
    expect(first.meta.inbox?.historyCoverage).toBe("interrupted")
    expect(second.meta.inbox?.historyCoverage).toBe("interrupted")
    expect(third.meta.inbox?.historyCoverage).toBe("interrupted")
  })

  it("clears the history checkpoint with commerce test state", async () => {
    const firstPage = recentPage(1_000)
    const boundary = firstPage[firstPage.length - 1]!
    const seenUntil: Array<number | undefined> = []
    const installPagedRead = () => {
      __setCommerceTestOverrides({
        fetchEventsFanoutWithDiagnostics: async (filter, options) => {
          seenUntil.push(filter.until)
          return filter.until === undefined
            ? successfulPage(firstPage, options?.relayUrls ?? [])
            : successfulPage([boundary], options?.relayUrls ?? [])
        },
        giftUnwrap: async (event) => ignoredRumor(event.id) as never,
      })
    }
    installPagedRead()

    await getMerchantConversationList({
      principalPubkey: MERCHANT,
      sort: "merchant_priority",
    })
    __resetCommerceTestOverrides()
    installBaseOverrides()
    installPagedRead()
    await getMerchantConversationList({
      principalPubkey: MERCHANT,
      sort: "merchant_priority",
    })

    expect(seenUntil).toEqual([undefined, 601, undefined, 601])
  })

  it("serializes a deep sync behind an in-flight shallow sync", async () => {
    const firstPage = recentPage(1_000)
    const boundary = firstPage[firstPage.length - 1]!
    const olderOrderWrap = wrapEvent("serialized-older-order", 600)
    let fetchCalls = 0
    let releaseFirstPage: (() => void) | undefined
    let markFirstPageStarted: (() => void) | undefined
    const firstPageStarted = new Promise<void>((resolve) => {
      markFirstPageStarted = resolve
    })
    const firstPageGate = new Promise<void>((resolve) => {
      releaseFirstPage = resolve
    })

    __setCommerceTestOverrides({
      fetchEventsFanoutWithDiagnostics: async (filter, options) => {
        fetchCalls += 1
        if (fetchCalls === 1) {
          markFirstPageStarted?.()
          await firstPageGate
        }
        return filter.until === undefined
          ? successfulPage(firstPage, options?.relayUrls ?? [])
          : successfulPage([boundary, olderOrderWrap], options?.relayUrls ?? [])
      },
      giftUnwrap: async (event) =>
        (event.id === olderOrderWrap.id
          ? orderRumor("order-serialized", 600)
          : ignoredRumor(event.id)) as never,
    })

    const shallow = getMerchantConversationList({
      principalPubkey: MERCHANT,
    })
    await firstPageStarted
    const deepA = getMerchantConversationList({
      principalPubkey: MERCHANT,
      sort: "merchant_priority",
    })
    const deepB = getMerchantConversationList({
      principalPubkey: MERCHANT,
      queue: "paid_fulfill",
    })
    releaseFirstPage?.()

    const [, firstDeep, secondDeep] = await Promise.all([shallow, deepA, deepB])

    expect(fetchCalls).toBe(3)
    expect(firstDeep.data[0]?.orderId).toBe("order-serialized")
    expect(secondDeep.meta.inbox?.historyCoverage).toBe("complete_within_scope")
  })
})
