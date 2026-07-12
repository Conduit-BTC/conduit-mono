import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  EVENT_KINDS,
  getDirectMessageConversationList,
  getDirectMessageThread,
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

function giftWrapEvent(id: string) {
  return {
    id,
    kind: EVENT_KINDS.GIFT_WRAP,
    pubkey: MERCHANT,
    created_at: 100,
    content: "wrapped",
    tags: [["p", BUYER]],
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

beforeEach(() => {
  __resetCommerceTestOverrides()
  directRows = []
  __setCommerceTestOverrides({
    now: () => 1_700_000_000_000,
    requireNdkConnected: async () => ({ signer: {} }) as never,
    getCachedDirectMessages: async () => directRows as never,
    putCachedDirectMessages: async (rows) => {
      for (const row of rows as Row[]) {
        directRows = [
          ...directRows.filter((existing) => existing.id !== row.id),
          row,
        ]
      }
    },
  })
})

afterEach(() => {
  __resetCommerceTestOverrides()
  directRows = []
})

describe("general direct-message gateway", () => {
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
    })

    expect(result.data?.counterpartyPubkey).toBe(MERCHANT)
    expect(result.data?.messages).toHaveLength(1)
    expect(result.data?.messages[0]?.content).toBe("hello")
    expect(result.data?.messages[0]?.createdAt).toBe(101_000)
  })
})
