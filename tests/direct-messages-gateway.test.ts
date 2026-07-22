import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  EVENT_KINDS,
  getCachedDirectMessageConversationList,
  getConversationDetail,
  getDirectMessageConversationList,
  getDirectMessageThread,
  markDirectMessageConversationRead,
} from "@conduit/core"

const BUYER = "buyer-pubkey"
const MERCHANT = "merchant-pubkey"

type Row = {
  id: string
  senderPubkey: string
  recipientPubkey: string
  content: string
  kind: number
  createdAt: number
  read: 0 | 1
}

let directRows: Row[] = []
let orderRows: Array<{ id: string; rawContent: string }> = []

function giftWrapEvent(id: string, recipient = BUYER) {
  return {
    id,
    kind: EVENT_KINDS.GIFT_WRAP,
    pubkey: MERCHANT,
    created_at: 100,
    content: "wrapped",
    tags: [["p", recipient]],
  }
}

function directRumor(params: {
  id: string
  sender: string
  recipient: string
  content: string
  createdAt: number
}) {
  return {
    id: params.id,
    kind: EVENT_KINDS.DIRECT_MESSAGE,
    pubkey: params.sender,
    created_at: params.createdAt,
    content: params.content,
    tags: [["p", params.recipient]],
  }
}

function orderRumor(id: string) {
  return {
    id,
    kind: EVENT_KINDS.ORDER,
    pubkey: BUYER,
    created_at: 105,
    content: JSON.stringify({ note: "order note" }),
    tags: [
      ["p", MERCHANT],
      ["type", "message"],
      ["order", "order-1"],
    ],
  }
}

function legacyDirectMessage(params: {
  id: string
  sender: string
  recipient: string
  ciphertext: string
  createdAt: number
}) {
  return {
    id: params.id,
    kind: EVENT_KINDS.DM_LEGACY,
    pubkey: params.sender,
    created_at: params.createdAt,
    content: params.ciphertext,
    tags: [["p", params.recipient]],
  }
}

beforeEach(() => {
  __resetCommerceTestOverrides()
  directRows = []
  orderRows = []
  __setCommerceTestOverrides({
    now: () => 1_700_000_000_000,
    requireNdkConnected: async () => ({ signer: {} }) as never,
    resolveInboxRelayUrls: async () => ["wss://inbox.example"],
    getCachedDirectMessages: async (principalPubkey) =>
      directRows.filter(
        (row) =>
          row.recipientPubkey === principalPubkey ||
          row.senderPubkey === principalPubkey
      ) as never,
    putCachedDirectMessages: async (rows) => {
      for (const row of rows as Row[]) {
        directRows = [
          ...directRows.filter((existing) => existing.id !== row.id),
          row,
        ]
      }
    },
    getCachedOrderMessages: async () => orderRows as never,
    putCachedOrderMessages: async (rows) => {
      for (const row of rows as Array<{ id: string; rawContent: string }>) {
        orderRows = [
          ...orderRows.filter((existing) => existing.id !== row.id),
          row,
        ]
      }
    },
    markDirectMessagesRead: async (
      principalPubkey,
      counterpartyPubkey,
      transport = "nip17"
    ) => {
      let updated = 0
      directRows = directRows.map((row) => {
        if (
          row.recipientPubkey !== principalPubkey ||
          row.senderPubkey !== counterpartyPubkey ||
          row.kind !==
            (transport === "nip04"
              ? EVENT_KINDS.DM_LEGACY
              : EVENT_KINDS.DIRECT_MESSAGE) ||
          row.read !== 0
        ) {
          return row
        }
        updated += 1
        return { ...row, read: 1 }
      })
      return updated
    },
  })
})

afterEach(() => {
  __resetCommerceTestOverrides()
  directRows = []
  orderRows = []
})

describe("general direct-message gateway", () => {
  it("queries incoming and outgoing kind-4 filters", async () => {
    const legacyFilters: Array<Record<string, unknown>> = []
    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) => {
        if (filter.kinds?.includes(EVENT_KINDS.DM_LEGACY)) {
          legacyFilters.push(filter as Record<string, unknown>)
        }
        return []
      },
    })

    await getDirectMessageConversationList({ principalPubkey: BUYER })

    expect(legacyFilters).toHaveLength(2)
    expect(legacyFilters).toContainEqual(
      expect.objectContaining({
        kinds: [EVENT_KINDS.DM_LEGACY],
        "#p": [BUYER],
      })
    )
    expect(legacyFilters).toContainEqual(
      expect.objectContaining({
        kinds: [EVENT_KINDS.DM_LEGACY],
        authors: [BUYER],
      })
    )
  })

  it("keeps nip17 and nip04 summaries separate and caches kind-4 plaintext", async () => {
    const incomingLegacy = legacyDirectMessage({
      id: "legacy-incoming",
      sender: MERCHANT,
      recipient: BUYER,
      ciphertext: "legacy incoming cipher",
      createdAt: 99,
    })
    const outgoingLegacy = legacyDirectMessage({
      id: "legacy-outgoing",
      sender: BUYER,
      recipient: MERCHANT,
      ciphertext: "legacy outgoing cipher",
      createdAt: 100,
    })
    __setCommerceTestOverrides({
      requireNdkConnected: async () =>
        ({
          signer: {
            decrypt: async (_user: unknown, ciphertext: string) =>
              `plain:${ciphertext}`,
          },
        }) as never,
      fetchEventsFanout: async (filter) => {
        if (filter.kinds?.includes(EVENT_KINDS.GIFT_WRAP)) {
          return [giftWrapEvent("wrap-current")] as never
        }
        if (filter.kinds?.includes(EVENT_KINDS.DM_LEGACY)) {
          return (filter.authors ? [outgoingLegacy] : [incomingLegacy]) as never
        }
        return []
      },
      giftUnwrap: async () =>
        directRumor({
          id: "current-dm",
          sender: MERCHANT,
          recipient: BUYER,
          content: "current message",
          createdAt: 101,
        }) as never,
    })

    const result = await getDirectMessageConversationList({
      principalPubkey: BUYER,
    })

    expect(result.data.map((conversation) => conversation.id).sort()).toEqual([
      `nip04:${MERCHANT}`,
      `nip17:${MERCHANT}`,
    ])
    expect(
      result.data.find((conversation) => conversation.transport === "nip04")
        ?.messageCount
    ).toBe(2)
    expect(
      directRows
        .filter((row) => row.kind === EVENT_KINDS.DM_LEGACY)
        .map((row) => ({ id: row.id, content: row.content }))
        .sort((a, b) => a.id.localeCompare(b.id))
    ).toEqual([
      { id: "legacy-incoming", content: "plain:legacy incoming cipher" },
      { id: "legacy-outgoing", content: "plain:legacy outgoing cipher" },
    ])
  })

  it("retries only failed legacy decrypts without suppressing nip17", async () => {
    const decryptCalls: Record<string, number> = {}
    let unwrapCalls = 0
    const goodLegacy = legacyDirectMessage({
      id: "legacy-good",
      sender: MERCHANT,
      recipient: BUYER,
      ciphertext: "good-cipher",
      createdAt: 99,
    })
    const badLegacy = legacyDirectMessage({
      id: "legacy-bad",
      sender: MERCHANT,
      recipient: BUYER,
      ciphertext: "bad-cipher",
      createdAt: 100,
    })
    __setCommerceTestOverrides({
      requireNdkConnected: async () =>
        ({
          signer: {
            decrypt: async (_user: unknown, ciphertext: string) => {
              decryptCalls[ciphertext] = (decryptCalls[ciphertext] ?? 0) + 1
              if (ciphertext === "bad-cipher") throw new Error("private")
              return "legacy readable"
            },
          },
        }) as never,
      fetchEventsFanout: async (filter) => {
        if (filter.kinds?.includes(EVENT_KINDS.GIFT_WRAP)) {
          return [giftWrapEvent("wrap-current")] as never
        }
        if (filter.kinds?.includes(EVENT_KINDS.DM_LEGACY) && !filter.authors) {
          return [goodLegacy, badLegacy] as never
        }
        return []
      },
      giftUnwrap: async () => {
        unwrapCalls += 1
        return directRumor({
          id: "current-dm",
          sender: MERCHANT,
          recipient: BUYER,
          content: "current readable",
          createdAt: 101,
        }) as never
      },
    })

    const first = await getDirectMessageConversationList({
      principalPubkey: BUYER,
    })
    const second = await getDirectMessageConversationList({
      principalPubkey: BUYER,
    })
    const third = await getDirectMessageConversationList({
      principalPubkey: BUYER,
    })

    expect(first.meta.legacyDecryptFailures).toEqual([
      { eventId: "legacy-bad", reason: "decrypt_failed", retryable: true },
    ])
    expect(second.meta.legacyDecryptFailures).toEqual([
      { eventId: "legacy-bad", reason: "decrypt_failed", retryable: false },
    ])
    expect(third.meta.legacyDecryptFailures).toEqual(
      second.meta.legacyDecryptFailures
    )
    expect(decryptCalls).toEqual({ "good-cipher": 1, "bad-cipher": 2 })
    expect(unwrapCalls).toBe(1)
    expect(second.data.map((conversation) => conversation.id).sort()).toEqual([
      `nip04:${MERCHANT}`,
      `nip17:${MERCHANT}`,
    ])
  })

  it("groups kind-14 messages by counterparty and ignores kind-16 order wraps", async () => {
    const rumors: Record<string, ReturnType<typeof directRumor>> = {
      "wrap-a": directRumor({
        id: "dm-a",
        sender: MERCHANT,
        recipient: BUYER,
        content: "hi, how can I help?",
        createdAt: 101,
      }),
      "wrap-b": directRumor({
        id: "dm-b",
        sender: BUYER,
        recipient: MERCHANT,
        content: "do you ship to NZ?",
        createdAt: 102,
      }),
    }

    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) =>
        filter.kinds?.includes(EVENT_KINDS.GIFT_WRAP)
          ? ([
              giftWrapEvent("wrap-a"),
              giftWrapEvent("wrap-b"),
              giftWrapEvent("wrap-order"),
            ] as never)
          : [],
      giftUnwrap: async (event) =>
        (event.id === "wrap-order"
          ? orderRumor("order-rumor")
          : rumors[event.id]) as never,
    })

    const result = await getDirectMessageConversationList({
      principalPubkey: BUYER,
    })

    expect(result.data).toHaveLength(1)
    expect(result.data[0]?.counterpartyPubkey).toBe(MERCHANT)
    expect(result.data[0]?.messageCount).toBe(2)
    expect(result.data[0]?.preview).toBe("do you ship to NZ?")
    expect(result.data[0]?.unreadFromCounterparty).toBe(1)
    expect(orderRows).toHaveLength(1)
  })

  it("preserves complete preview content for presentation-time formatting", async () => {
    const legacyEnvelope = JSON.stringify({
      id: "2e2811f8-d38e-4929-a937-7b41e5fa6f2e",
      type: 2,
      message: "Your order has been declined.",
      paid: false,
      shipped: false,
      cancelled: true,
      padding: "x".repeat(80),
    })
    expect(legacyEnvelope.length).toBeGreaterThan(140)

    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) =>
        filter.kinds?.includes(EVENT_KINDS.GIFT_WRAP)
          ? ([giftWrapEvent("wrap-legacy-envelope")] as never)
          : [],
      giftUnwrap: async () =>
        directRumor({
          id: "dm-legacy-envelope",
          sender: MERCHANT,
          recipient: BUYER,
          content: legacyEnvelope,
          createdAt: 103,
        }) as never,
    })

    const result = await getDirectMessageConversationList({
      principalPubkey: BUYER,
    })

    expect(result.data[0]?.preview).toBe(legacyEnvelope)
  })

  it("unwraps and routes a mixed inbox once across concurrent consumers", async () => {
    const unwrapCalls: Record<string, number> = {}
    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) =>
        filter.kinds?.includes(EVENT_KINDS.GIFT_WRAP)
          ? ([giftWrapEvent("wrap-dm"), giftWrapEvent("wrap-order")] as never)
          : [],
      giftUnwrap: async (event) => {
        unwrapCalls[event.id] = (unwrapCalls[event.id] ?? 0) + 1
        return (
          event.id === "wrap-order"
            ? orderRumor("order-rumor")
            : directRumor({
                id: "dm-rumor",
                sender: MERCHANT,
                recipient: BUYER,
                content: "hello",
                createdAt: 101,
              })
        ) as never
      },
    })

    const [direct, orders] = await Promise.all([
      getDirectMessageConversationList({ principalPubkey: BUYER }),
      getConversationDetail({ principalPubkey: BUYER, orderId: "order-1" }),
    ])

    expect(direct.data[0]?.messageCount).toBe(1)
    expect(orders.data?.messages).toHaveLength(1)
    expect(unwrapCalls).toEqual({ "wrap-dm": 1, "wrap-order": 1 })
    expect(directRows).toHaveLength(1)
    expect(orderRows).toHaveLength(1)
  })

  it("surfaces decrypt failures in meta without leaking content", async () => {
    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) =>
        filter.kinds?.includes(EVENT_KINDS.GIFT_WRAP)
          ? ([giftWrapEvent("wrap-ok"), giftWrapEvent("wrap-bad")] as never)
          : [],
      giftUnwrap: async (event) =>
        (event.id === "wrap-ok"
          ? directRumor({
              id: "dm-ok",
              sender: MERCHANT,
              recipient: BUYER,
              content: "readable",
              createdAt: 101,
            })
          : null) as never,
    })

    const result = await getDirectMessageConversationList({
      principalPubkey: BUYER,
    })

    expect(result.data).toHaveLength(1)
    expect(result.meta.decryptFailures).toHaveLength(1)
    const failure = result.meta.decryptFailures?.[0]
    expect(failure?.wrapId).toBe("wrap-bad")
    expect(failure?.reason).toBe("nip44_failed")
    expect(Object.keys(failure ?? {}).sort()).toEqual(["reason", "wrapId"])
    expect(result.meta.degraded).toBe(true)
  })

  it("marks an empty result degraded when the current NIP-17 lane is unavailable", async () => {
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [],
      fetchEventsFanout: async () => [],
    })

    const result = await getDirectMessageConversationList({
      principalPubkey: BUYER,
    })

    expect(result.data).toEqual([])
    expect(result.meta.stale).toBe(true)
    expect(result.meta.degraded).toBe(true)
  })

  it("re-attempts only previously-failed wraps on a later read", async () => {
    const unwrapCalls: Record<string, number> = {}
    let badResolves = false

    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) =>
        filter.kinds?.includes(EVENT_KINDS.GIFT_WRAP)
          ? ([giftWrapEvent("wrap-ok"), giftWrapEvent("wrap-bad")] as never)
          : [],
      giftUnwrap: async (event) => {
        unwrapCalls[event.id] = (unwrapCalls[event.id] ?? 0) + 1
        if (event.id === "wrap-ok") {
          return directRumor({
            id: "dm-ok",
            sender: MERCHANT,
            recipient: BUYER,
            content: "readable",
            createdAt: 101,
          }) as never
        }
        return (
          badResolves
            ? directRumor({
                id: "dm-recovered",
                sender: MERCHANT,
                recipient: BUYER,
                content: "recovered",
                createdAt: 102,
              })
            : null
        ) as never
      },
    })

    const first = await getDirectMessageConversationList({
      principalPubkey: BUYER,
    })
    expect(first.meta.decryptFailures).toHaveLength(1)

    badResolves = true
    const second = await getDirectMessageConversationList({
      principalPubkey: BUYER,
    })

    // wrap-ok parsed on the first read is not unwrapped again; wrap-bad is.
    expect(unwrapCalls["wrap-ok"]).toBe(1)
    expect(unwrapCalls["wrap-bad"]).toBe(2)
    expect(second.meta.decryptFailures ?? []).toHaveLength(0)
    expect(second.data[0]?.messageCount).toBe(2)
  })

  it("retries a wrapper when its routed cache write fails", async () => {
    let unwrapCalls = 0
    let cacheAttempts = 0
    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) =>
        filter.kinds?.includes(EVENT_KINDS.GIFT_WRAP)
          ? ([giftWrapEvent("wrap-cache-retry")] as never)
          : [],
      giftUnwrap: async () => {
        unwrapCalls += 1
        return directRumor({
          id: "dm-cache-retry",
          sender: MERCHANT,
          recipient: BUYER,
          content: "available before persistence",
          createdAt: 101,
        }) as never
      },
      putCachedDirectMessages: async (rows) => {
        cacheAttempts += 1
        if (cacheAttempts === 1) throw new Error("cache unavailable")
        directRows = rows as Row[]
      },
    })

    const first = await getDirectMessageConversationList({
      principalPubkey: BUYER,
    })
    const second = await getDirectMessageConversationList({
      principalPubkey: BUYER,
    })

    expect(first.data[0]?.preview).toBe("available before persistence")
    expect(second.data[0]?.preview).toBe("available before persistence")
    expect(unwrapCalls).toBe(2)
    expect(cacheAttempts).toBe(2)
    expect(directRows).toHaveLength(1)
  })

  it("keeps successful wrapper state isolated by principal", async () => {
    const otherBuyer = "other-buyer"
    let unwrapCalls = 0
    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) => {
        if (!filter.kinds?.includes(EVENT_KINDS.GIFT_WRAP)) return []
        const recipient = filter["#p"]?.[0] ?? BUYER
        return [giftWrapEvent("shared-wrap-id", recipient)] as never
      },
      giftUnwrap: async (event) => {
        unwrapCalls += 1
        const recipient = event.tags.find((tag) => tag[0] === "p")?.[1] ?? ""
        return directRumor({
          id: `dm-${recipient}`,
          sender: MERCHANT,
          recipient,
          content: `hello ${recipient}`,
          createdAt: 101,
        }) as never
      },
    })

    const first = await getDirectMessageConversationList({
      principalPubkey: BUYER,
    })
    const second = await getDirectMessageConversationList({
      principalPubkey: otherBuyer,
    })

    expect(first.data[0]?.preview).toBe(`hello ${BUYER}`)
    expect(second.data[0]?.preview).toBe(`hello ${otherBuyer}`)
    expect(unwrapCalls).toBe(2)
  })

  it("adds the principal's kind-10050 inbox relays to the DM read fanout", async () => {
    let giftWrapReadRelays: string[] | undefined

    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter, options) => {
        if (filter.kinds?.includes(EVENT_KINDS.PRIVATE_MESSAGE_RELAYS)) {
          return [
            {
              id: "relays-10050",
              kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
              pubkey: BUYER,
              created_at: 90,
              content: "",
              tags: [["relay", "wss://inbox.example"]],
            },
          ] as never
        }
        if (filter.kinds?.includes(EVENT_KINDS.GIFT_WRAP)) {
          giftWrapReadRelays = options?.relayUrls as string[] | undefined
          return [giftWrapEvent("wrap-a")] as never
        }
        return []
      },
      giftUnwrap: async () =>
        directRumor({
          id: "dm-a",
          sender: MERCHANT,
          recipient: BUYER,
          content: "hi",
          createdAt: 101,
        }) as never,
    })

    await getDirectMessageConversationList({ principalPubkey: BUYER })

    expect(giftWrapReadRelays).toContain("wss://inbox.example")
  })

  it("returns a single counterparty thread", async () => {
    __setCommerceTestOverrides({
      fetchEventsFanout: async (filter) =>
        filter.kinds?.includes(EVENT_KINDS.GIFT_WRAP)
          ? ([giftWrapEvent("wrap-a")] as never)
          : [],
      giftUnwrap: async () =>
        directRumor({
          id: "dm-a",
          sender: BUYER,
          recipient: MERCHANT,
          content: "hello",
          createdAt: 101,
        }) as never,
    })

    const result = await getDirectMessageThread({
      principalPubkey: BUYER,
      counterpartyPubkey: MERCHANT,
      transport: "nip17",
    })

    expect(result.data?.counterpartyPubkey).toBe(MERCHANT)
    expect(result.data?.messages).toHaveLength(1)
    expect(result.data?.messages[0]?.content).toBe("hello")
    expect(result.data?.messages[0]?.createdAt).toBe(101_000)
  })

  it("marks only the selected incoming conversation read and is idempotent", async () => {
    directRows = [
      {
        id: "selected-incoming",
        senderPubkey: MERCHANT,
        recipientPubkey: BUYER,
        content: "incoming",
        kind: EVENT_KINDS.DIRECT_MESSAGE,
        createdAt: 101_000,
        read: 0,
      },
      {
        id: "selected-outgoing",
        senderPubkey: BUYER,
        recipientPubkey: MERCHANT,
        content: "outgoing",
        kind: EVENT_KINDS.DIRECT_MESSAGE,
        createdAt: 102_000,
        read: 0,
      },
      {
        id: "other-incoming",
        senderPubkey: "other-merchant",
        recipientPubkey: BUYER,
        content: "other",
        kind: EVENT_KINDS.DIRECT_MESSAGE,
        createdAt: 103_000,
        read: 0,
      },
    ]
    __setCommerceTestOverrides({ fetchEventsFanout: async () => [] })

    const before = await getCachedDirectMessageConversationList({
      principalPubkey: BUYER,
    })
    expect(
      before.data.find((item) => item.id === `nip17:${MERCHANT}`)
        ?.unreadFromCounterparty
    ).toBe(1)

    expect(
      await markDirectMessageConversationRead({
        principalPubkey: BUYER,
        counterpartyPubkey: MERCHANT,
      })
    ).toBe(1)
    expect(
      await markDirectMessageConversationRead({
        principalPubkey: BUYER,
        counterpartyPubkey: MERCHANT,
      })
    ).toBe(0)

    const after = await getCachedDirectMessageConversationList({
      principalPubkey: BUYER,
    })
    expect(
      after.data.find((item) => item.id === `nip17:${MERCHANT}`)
        ?.unreadFromCounterparty
    ).toBe(0)
    expect(
      after.data.find((item) => item.id === "nip17:other-merchant")
        ?.unreadFromCounterparty
    ).toBe(1)
    expect(directRows.find((row) => row.id === "selected-outgoing")?.read).toBe(
      0
    )
  })

  it("marks read state only for the selected transport", async () => {
    directRows = [
      {
        id: "current-incoming",
        senderPubkey: MERCHANT,
        recipientPubkey: BUYER,
        content: "current",
        kind: EVENT_KINDS.DIRECT_MESSAGE,
        createdAt: 102_000,
        read: 0,
      },
      {
        id: "legacy-incoming",
        senderPubkey: MERCHANT,
        recipientPubkey: BUYER,
        content: "legacy",
        kind: EVENT_KINDS.DM_LEGACY,
        createdAt: 101_000,
        read: 0,
      },
    ]

    expect(
      await markDirectMessageConversationRead({
        principalPubkey: BUYER,
        counterpartyPubkey: MERCHANT,
        transport: "nip04",
      })
    ).toBe(1)
    expect(directRows.find((row) => row.id === "legacy-incoming")?.read).toBe(1)
    expect(directRows.find((row) => row.id === "current-incoming")?.read).toBe(
      0
    )

    expect(
      await markDirectMessageConversationRead({
        principalPubkey: BUYER,
        counterpartyPubkey: MERCHANT,
        transport: "nip17",
      })
    ).toBe(1)
    expect(directRows.find((row) => row.id === "current-incoming")?.read).toBe(
      1
    )
  })
})
