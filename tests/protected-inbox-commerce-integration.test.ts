import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { finalizeEvent, getPublicKey } from "nostr-tools"
import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  closeAllProtectedRelayConnections,
  EVENT_KINDS,
  getBuyerConversationList,
  getDirectMessageConversationList,
  getMerchantConversationList,
  isPrivateInboxDeclaredWriteHistoryComplete,
  type CachedOrderMessage,
} from "@conduit/core"
import {
  __resetProtectedReadSigner,
  installProtectedReadSigner,
} from "../packages/core/src/protocol/protected-read-authorization"
import type {
  NostrEventSigner,
  SignedNostrEvent,
} from "../packages/core/src/protocol/nostr-event-signer"

const BUYER_KEY = new Uint8Array(32).fill(21)
const MERCHANT_KEY = new Uint8Array(32).fill(22)
const WRAP_KEY = new Uint8Array(32).fill(23)
const BUYER = getPublicKey(BUYER_KEY)
const MERCHANT = getPublicKey(MERCHANT_KEY)
const RELAY_URL = "wss://protected-commerce.example"

const wraps = new Map(
  [BUYER, MERCHANT].map((recipient, index) => {
    const wrap = finalizeEvent(
      {
        kind: 1_059,
        created_at: 1_700_000_000 + index,
        tags: [["p", recipient]],
        content: `encrypted-${index}`,
      },
      WRAP_KEY
    )
    return [recipient, wrap] as const
  })
)

function orderRumor(recipient: string) {
  const buyer = recipient === MERCHANT ? BUYER : recipient
  const merchant = recipient === MERCHANT ? recipient : MERCHANT
  return {
    id: `rumor-${recipient}`,
    kind: 16,
    pubkey: buyer,
    created_at: 1_700_000_100,
    content: JSON.stringify({
      id: `order-${recipient}`,
      merchantPubkey: merchant,
      buyerPubkey: buyer,
      items: [
        {
          productId: `30402:${merchant}:item`,
          quantity: 1,
          priceAtPurchase: 2_100,
          currency: "SATS",
        },
      ],
      subtotal: 2_100,
      currency: "SATS",
      createdAt: 1_700_000_100_000,
    }),
    tags: [
      ["p", merchant],
      ["type", "order"],
      ["order", `order-${recipient}`],
      ["amount", "2100"],
      ["currency", "SATS"],
    ],
  }
}

let signCalls = 0

function signer(privateKey: Uint8Array): NostrEventSigner {
  const pubkey = getPublicKey(privateKey)
  return {
    authMethod: "nip07",
    getPublicKey: async () => pubkey,
    signEvent: async (event) => {
      signCalls += 1
      return finalizeEvent(event, privateKey)
    },
  }
}

let rejectAuthentication = false
let challengeAuthentication = true
const sockets: CommerceProtectedRelaySocket[] = []

class CommerceProtectedRelaySocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  readyState = CommerceProtectedRelaySocket.CONNECTING
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: Event) => void) | null = null
  readonly sent: unknown[][] = []
  closed = false

  constructor() {
    sockets.push(this)
    queueMicrotask(() => {
      this.readyState = CommerceProtectedRelaySocket.OPEN
      this.onopen?.(new Event("open"))
      if (challengeAuthentication) {
        queueMicrotask(() =>
          this.relay(["AUTH", `challenge-${sockets.length}`])
        )
      }
    })
  }

  send(payload: string): void {
    const frame = JSON.parse(payload) as unknown[]
    this.sent.push(frame)
    if (frame[0] === "AUTH") {
      const event = frame[1] as SignedNostrEvent
      this.relay(["OK", event.id, !rejectAuthentication, ""])
      return
    }
    if (frame[0] !== "REQ") return
    const filter = frame[2] as { "#p"?: string[] }
    const recipient = filter["#p"]?.[0]
    const wrap = recipient ? wraps.get(recipient) : undefined
    if (wrap) this.relay(["EVENT", frame[1], wrap])
    this.relay(["EOSE", frame[1]])
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.readyState = CommerceProtectedRelaySocket.CLOSED
    this.onclose?.(new Event("close"))
  }

  private relay(frame: unknown[]): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent<string>)
  }
}

function cachedOrderRow(): CachedOrderMessage {
  const message = {
    id: "cached-rumor",
    orderId: "cached-order",
    type: "order" as const,
    createdAt: 1_700_000_050_000,
    senderPubkey: BUYER,
    recipientPubkey: MERCHANT,
    rawContent: JSON.stringify({
      id: "cached-order",
      merchantPubkey: MERCHANT,
      buyerPubkey: BUYER,
      items: [],
      subtotal: 0,
      currency: "SATS",
      createdAt: 1_700_000_050_000,
    }),
    payload: {
      id: "cached-order",
      merchantPubkey: MERCHANT,
      buyerPubkey: BUYER,
      items: [],
      subtotal: 0,
      currency: "SATS",
      createdAt: 1_700_000_050_000,
    },
  }
  return {
    id: message.id,
    orderId: message.orderId,
    type: message.type,
    senderPubkey: message.senderPubkey,
    recipientPubkey: message.recipientPubkey,
    createdAt: message.createdAt,
    rawContent: JSON.stringify(message),
    cachedAt: message.createdAt,
  }
}

function emptyProtectedRead() {
  return {
    events: [],
    coverage: "complete" as const,
    auth: {
      state: "not_challenged" as const,
      challengedCount: 0,
      succeededCount: 0,
      failedCount: 0,
    },
    relayResult: {
      status: "success" as const,
      observations: [],
      relays: [],
      attemptedCount: 1,
      completedCount: 1,
      failedCount: 0,
      authoritativeEmpty: true,
    },
  }
}

function protectedReadWithFailures(
  relayUrls: readonly string[],
  failedRelayUrls: ReadonlySet<string>,
  events: SignedNostrEvent[] = []
) {
  const relays = relayUrls.map((relayUrl, relayIndex) => ({
    relayIndex,
    status: failedRelayUrls.has(relayUrl)
      ? ("failed" as const)
      : ("success" as const),
    auth: "not_challenged" as const,
    eventCount: 0,
    duplicateCount: 0,
    malformedCount: 0,
    unusableCount: 0,
  }))
  const failedCount = relays.filter((relay) => relay.status === "failed").length
  return {
    ...emptyProtectedRead(),
    events,
    coverage: failedCount > 0 ? ("partial" as const) : ("complete" as const),
    relayResult: {
      ...emptyProtectedRead().relayResult,
      status: failedCount > 0 ? ("partial" as const) : ("success" as const),
      relays,
      attemptedCount: relayUrls.length,
      completedCount: relayUrls.length - failedCount,
      failedCount,
      authoritativeEmpty: events.length === 0 && failedCount === 0,
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

function legacyDirectMessage() {
  return {
    id: "legacy-authority-fence",
    kind: 4,
    pubkey: MERCHANT,
    created_at: 1_700_000_200,
    content: "encrypted-legacy-message",
    tags: [["p", BUYER]],
  }
}

const originalWebSocket = globalThis.WebSocket

beforeEach(() => {
  rejectAuthentication = false
  challengeAuthentication = true
  signCalls = 0
  sockets.splice(0)
  __resetCommerceTestOverrides()
  __resetProtectedReadSigner()
  closeAllProtectedRelayConnections()
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: CommerceProtectedRelaySocket,
  })
})

afterEach(() => {
  __resetCommerceTestOverrides()
  __resetProtectedReadSigner()
  closeAllProtectedRelayConnections()
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: originalWebSocket,
  })
})

describe("Market and Merchant protected inbox integration", () => {
  it("starts a new inbox generation after a pre-existing sync", async () => {
    const firstRead = deferred<ReturnType<typeof emptyProtectedRead>>()
    let readCount = 0
    const cachedRows: CachedOrderMessage[] = []
    __setCommerceTestOverrides({
      getNdk: async () => ({ signer: {} }) as never,
      resolveInboxRelayUrls: async () => [RELAY_URL],
      getCachedOrderMessages: async () => [...cachedRows],
      putCachedOrderMessages: async (rows) => cachedRows.push(...rows),
      getCachedDirectMessages: async () => [],
      putCachedDirectMessages: async () => undefined,
      giftUnwrap: async () => orderRumor(MERCHANT) as never,
      readProtectedInbox: async () => {
        readCount += 1
        return readCount === 1 ? await firstRead.promise : emptyProtectedRead()
      },
    })
    installProtectedReadSigner(signer(MERCHANT_KEY), MERCHANT, () => true)

    const older = getMerchantConversationList({ principalPubkey: MERCHANT })
    while (readCount === 0) await Promise.resolve()
    let freshSettled = false
    const fresh = getMerchantConversationList({
      principalPubkey: MERCHANT,
      forceFresh: true,
    }).finally(() => {
      freshSettled = true
    })
    await Promise.resolve()
    expect(readCount).toBe(1)
    expect(freshSettled).toBe(false)

    firstRead.resolve({
      ...emptyProtectedRead(),
      events: [wraps.get(MERCHANT)!],
    })
    await older
    const result = await fresh
    expect(readCount).toBe(2)
    expect(result.data).toHaveLength(1)
    expect(result.meta.inbox?.coverage).toBe("complete")
  })

  it("rediscovers the inbox declaration for a force-fresh conversation read", async () => {
    const rotatedRelayUrl = "wss://rotated-protected-commerce.example"
    const declarations = [
      finalizeEvent(
        {
          kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
          created_at: 1_700_000_000,
          tags: [["relay", RELAY_URL]],
          content: "",
        },
        MERCHANT_KEY
      ),
      finalizeEvent(
        {
          kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
          created_at: 1_700_000_001,
          tags: [["relay", rotatedRelayUrl]],
          content: "",
        },
        MERCHANT_KEY
      ),
    ]
    const cachedRows: CachedOrderMessage[] = []
    let declarationReads = 0
    let latestInboxReadRelayUrls: string[] = []
    __setCommerceTestOverrides({
      getNdk: async () => ({ signer: {} }) as never,
      getCachedOrderMessages: async () => [...cachedRows],
      putCachedOrderMessages: async (rows) => cachedRows.push(...rows),
      getCachedDirectMessages: async () => [],
      putCachedDirectMessages: async () => undefined,
      giftUnwrap: async () => orderRumor(MERCHANT) as never,
      fetchEventsFanoutWithDiagnostics: async (filter, options) => {
        const relayUrls = [...(options?.relayUrls ?? [])]
        const declarationRead = filter.kinds?.includes(
          EVENT_KINDS.PRIVATE_MESSAGE_RELAYS
        )
        if (declarationRead) {
          declarationReads += 1
        } else {
          latestInboxReadRelayUrls = relayUrls
        }
        return {
          events: declarationRead
            ? ([declarations[Math.min(declarationReads - 1, 1)]!] as never)
            : ([wraps.get(MERCHANT)!] as never),
          attemptedRelayUrls: relayUrls,
          successfulRelayUrls: relayUrls,
          failedRelayUrls: [],
        }
      },
    })
    installProtectedReadSigner(signer(MERCHANT_KEY), MERCHANT, () => true)

    await getMerchantConversationList({ principalPubkey: MERCHANT })
    await getMerchantConversationList({ principalPubkey: MERCHANT })
    expect(declarationReads).toBe(1)

    await getMerchantConversationList({
      principalPubkey: MERCHANT,
      forceFresh: true,
    })
    expect(declarationReads).toBe(2)
    expect(latestInboxReadRelayUrls.slice(0, 2)).toEqual([
      rotatedRelayUrl,
      RELAY_URL,
    ])
  })

  it("marks a saturated protected inbox snapshot as capped", async () => {
    __setCommerceTestOverrides({
      getNdk: async () => ({ signer: {} }) as never,
      resolveInboxRelayUrls: async () => [RELAY_URL],
      getCachedOrderMessages: async () => [],
      getCachedDirectMessages: async () => [],
      readProtectedInbox: async () => ({
        ...emptyProtectedRead(),
        relayResult: {
          ...emptyProtectedRead().relayResult,
          relays: [
            {
              relayIndex: 0,
              status: "success",
              auth: "not_challenged",
              eventCount: 399,
              duplicateCount: 1,
              malformedCount: 0,
              unusableCount: 0,
            },
          ],
        },
      }),
    })
    installProtectedReadSigner(signer(MERCHANT_KEY), MERCHANT, () => true)

    const result = await getMerchantConversationList({
      principalPubkey: MERCHANT,
    })

    expect(result.data).toEqual([])
    expect(result.meta.capped).toBe(true)
    expect(result.meta.degraded).toBe(true)
  })

  it("keeps declared write history complete when an optional discovery relay fails", async () => {
    __setCommerceTestOverrides({
      getNdk: async () => ({ signer: {} }) as never,
      resolveInboxRelayUrls: async () => [RELAY_URL],
      getCachedOrderMessages: async () => [],
      putCachedOrderMessages: async () => undefined,
      getCachedDirectMessages: async () => [],
      putCachedDirectMessages: async () => undefined,
      giftUnwrap: async () => orderRumor(MERCHANT) as never,
      readProtectedInbox: async (options) => {
        return protectedReadWithFailures(
          options.relayUrls,
          new Set(["wss://inbox.azzamo.net"]),
          [wraps.get(MERCHANT)!]
        )
      },
    })
    installProtectedReadSigner(signer(MERCHANT_KEY), MERCHANT, () => true)

    const result = await getMerchantConversationList({
      principalPubkey: MERCHANT,
    })

    expect(result.data).toHaveLength(1)
    expect(result.meta.inbox?.coverage).toBe("partial")
    expect(result.meta.inbox?.declarationStale).toBe(false)
    expect(result.meta.inbox?.declaredWritePlan).toEqual({
      coverage: "complete",
      capped: false,
    })
    expect(result.meta.degraded).toBe(true)
    expect(isPrivateInboxDeclaredWriteHistoryComplete(result.meta)).toBe(true)
  })

  it("keeps declared write history complete when declaration discovery degrades", async () => {
    const declaration = finalizeEvent(
      {
        kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
        created_at: 1_700_000_000,
        tags: [["relay", RELAY_URL]],
        content: "",
      },
      MERCHANT_KEY
    )
    const cachedRows: CachedOrderMessage[] = []
    let declarationReads = 0

    __setCommerceTestOverrides({
      getNdk: async () => ({ signer: {} }) as never,
      getCachedOrderMessages: async () => [...cachedRows],
      putCachedOrderMessages: async (rows) => cachedRows.push(...rows),
      getCachedDirectMessages: async () => [],
      putCachedDirectMessages: async () => undefined,
      giftUnwrap: async () => orderRumor(MERCHANT) as never,
      fetchEventsFanoutWithDiagnostics: async (filter, options) => {
        const relayUrls = [...(options?.relayUrls ?? [])]
        const declarationRead = filter.kinds?.includes(
          EVENT_KINDS.PRIVATE_MESSAGE_RELAYS
        )
        if (declarationRead) {
          declarationReads += 1
        }
        const failedRelayUrls = declarationRead
          ? declarationReads === 1
            ? []
            : relayUrls.slice(-1)
          : relayUrls.filter((url) => url === "wss://inbox.azzamo.net")
        return {
          events: declarationRead
            ? declarationReads < 3
              ? ([declaration] as never)
              : []
            : ([wraps.get(MERCHANT)!] as never),
          attemptedRelayUrls: relayUrls,
          successfulRelayUrls: relayUrls.filter(
            (url) => !failedRelayUrls.includes(url)
          ),
          failedRelayUrls,
        }
      },
    })
    installProtectedReadSigner(signer(MERCHANT_KEY), MERCHANT, () => true)

    await getMerchantConversationList({ principalPubkey: MERCHANT })
    const reobservedResult = await getMerchantConversationList({
      principalPubkey: MERCHANT,
      forceFresh: true,
    })

    expect(declarationReads).toBe(2)
    expect(reobservedResult.data).toHaveLength(1)
    expect(reobservedResult.meta.stale).toBe(true)
    expect(reobservedResult.meta.inbox?.coverage).toBe("partial")
    expect(reobservedResult.meta.inbox?.declarationStale).toBe(true)
    expect(reobservedResult.meta.inbox?.declarationEvidenceCurrent).toBe(true)
    expect(reobservedResult.meta.inbox?.declaredWritePlan).toEqual({
      coverage: "complete",
      capped: false,
    })
    expect(reobservedResult.meta.degraded).toBe(true)
    expect(
      isPrivateInboxDeclaredWriteHistoryComplete(reobservedResult.meta)
    ).toBe(true)

    const cachedFallbackResult = await getMerchantConversationList({
      principalPubkey: MERCHANT,
      forceFresh: true,
    })

    expect(declarationReads).toBe(3)
    expect(cachedFallbackResult.data).toHaveLength(1)
    expect(cachedFallbackResult.meta.stale).toBe(true)
    expect(cachedFallbackResult.meta.inbox?.declarationStale).toBe(true)
    expect(cachedFallbackResult.meta.inbox?.declarationEvidenceCurrent).toBe(
      false
    )
    expect(cachedFallbackResult.meta.inbox?.declaredWritePlan).toEqual({
      coverage: "complete",
      capped: false,
    })
    expect(
      isPrivateInboxDeclaredWriteHistoryComplete(cachedFallbackResult.meta)
    ).toBe(false)
  })

  it("does not mark a complete empty declaration lookup current", async () => {
    __setCommerceTestOverrides({
      getNdk: async () => ({ signer: {} }) as never,
      getCachedOrderMessages: async () => [],
      putCachedOrderMessages: async () => undefined,
      getCachedDirectMessages: async () => [],
      putCachedDirectMessages: async () => undefined,
      giftUnwrap: async () => orderRumor(MERCHANT) as never,
      fetchEventsFanoutWithDiagnostics: async (filter, options) => {
        const relayUrls = [...(options?.relayUrls ?? [])]
        const declarationRead = filter.kinds?.includes(
          EVENT_KINDS.PRIVATE_MESSAGE_RELAYS
        )
        return {
          events: declarationRead ? [] : ([wraps.get(MERCHANT)!] as never),
          attemptedRelayUrls: relayUrls,
          successfulRelayUrls: relayUrls,
          failedRelayUrls: [],
        }
      },
    })
    installProtectedReadSigner(signer(MERCHANT_KEY), MERCHANT, () => true)

    const result = await getMerchantConversationList({
      principalPubkey: MERCHANT,
      forceFresh: true,
    })

    expect(result.data).toHaveLength(1)
    expect(result.meta.inbox?.declarationState).toBe("not_observed")
    expect(result.meta.inbox?.declarationEvidenceCurrent).toBe(false)
    expect(result.meta.inbox?.declaredWritePlan.coverage).toBe("unavailable")
    expect(isPrivateInboxDeclaredWriteHistoryComplete(result.meta)).toBe(false)
  })

  it("fails declared write history closed when the current write route fails", async () => {
    __setCommerceTestOverrides({
      getNdk: async () => ({ signer: {} }) as never,
      resolveInboxRelayUrls: async () => [RELAY_URL],
      getCachedOrderMessages: async () => [],
      putCachedOrderMessages: async () => undefined,
      getCachedDirectMessages: async () => [],
      putCachedDirectMessages: async () => undefined,
      giftUnwrap: async () => orderRumor(MERCHANT) as never,
      readProtectedInbox: async (options) => {
        return protectedReadWithFailures(
          options.relayUrls,
          new Set([RELAY_URL]),
          [wraps.get(MERCHANT)!]
        )
      },
    })
    installProtectedReadSigner(signer(MERCHANT_KEY), MERCHANT, () => true)

    const result = await getMerchantConversationList({
      principalPubkey: MERCHANT,
    })

    expect(result.data).toHaveLength(1)
    expect(result.meta.inbox?.coverage).toBe("partial")
    expect(result.meta.inbox?.declaredWritePlan).toEqual({
      coverage: "unavailable",
      capped: false,
    })
    expect(isPrivateInboxDeclaredWriteHistoryComplete(result.meta)).toBe(false)
  })

  it("marks a caller-truncated Merchant conversation snapshot unsafe for invoice history", async () => {
    __setCommerceTestOverrides({
      getNdk: async () => ({ signer: {} }) as never,
      resolveInboxRelayUrls: async () => [RELAY_URL],
      getCachedOrderMessages: async () => [],
      putCachedOrderMessages: async () => undefined,
      getCachedDirectMessages: async () => [],
      putCachedDirectMessages: async () => undefined,
      giftUnwrap: async () => orderRumor(MERCHANT) as never,
      fetchEventsFanoutWithDiagnostics: async (_filter, options) => {
        const relayUrls = [...(options?.relayUrls ?? [])]
        return {
          events: [wraps.get(MERCHANT)!] as never,
          attemptedRelayUrls: relayUrls,
          successfulRelayUrls: relayUrls,
          failedRelayUrls: [],
        }
      },
    })
    installProtectedReadSigner(signer(MERCHANT_KEY), MERCHANT, () => true)

    const result = await getMerchantConversationList({
      principalPubkey: MERCHANT,
      limit: 0,
    })

    expect(result.data).toEqual([])
    expect(result.meta.capped).toBe(true)
    expect(result.meta.inbox?.declaredWritePlan).toEqual({
      coverage: "complete",
      capped: true,
    })
    expect(isPrivateInboxDeclaredWriteHistoryComplete(result.meta)).toBe(false)
  })

  it("keeps both account roles working on relays that do not challenge", async () => {
    challengeAuthentication = false
    __setCommerceTestOverrides({
      getNdk: async () => ({ signer: {} }) as never,
      resolveInboxRelayUrls: async () => [RELAY_URL],
      getCachedOrderMessages: async () => [],
      putCachedOrderMessages: async () => undefined,
      getCachedDirectMessages: async () => [],
      putCachedDirectMessages: async () => undefined,
      giftUnwrap: async (event) => {
        const recipient = event.tags.find((tag) => tag[0] === "p")?.[1]
        return recipient ? (orderRumor(recipient) as never) : null
      },
    })

    installProtectedReadSigner(signer(MERCHANT_KEY), MERCHANT, () => true)
    const merchantResult = await getMerchantConversationList({
      principalPubkey: MERCHANT,
    })
    installProtectedReadSigner(signer(BUYER_KEY), BUYER, () => true)
    const buyerResult = await getBuyerConversationList({
      principalPubkey: BUYER,
    })

    for (const result of [merchantResult, buyerResult]) {
      expect(result.data).toHaveLength(1)
      expect(result.meta.inbox?.coverage).toBe("complete")
      expect(result.meta.inbox?.authentication?.state).toBe("not_challenged")
    }
    expect(signCalls).toBe(0)
    expect(
      sockets
        .flatMap((socket) => socket.sent)
        .some((frame) => frame[0] === "AUTH")
    ).toBe(false)
    const requestFrames = sockets
      .flatMap((socket) => socket.sent)
      .filter((frame) => frame[0] === "REQ")
    expect(requestFrames).toHaveLength(sockets.length)
    expect(requestFrames.length).toBeGreaterThanOrEqual(2)
  })

  it("authenticates the actual shared kind-1059 path for both account roles", async () => {
    const persistedRows: CachedOrderMessage[] = []
    __setCommerceTestOverrides({
      getNdk: async () => ({ signer: {} }) as never,
      resolveInboxRelayUrls: async () => [RELAY_URL],
      getCachedOrderMessages: async () => [],
      putCachedOrderMessages: async (rows) => persistedRows.push(...rows),
      getCachedDirectMessages: async () => [],
      putCachedDirectMessages: async () => undefined,
      giftUnwrap: async (event) => {
        const recipient = event.tags.find((tag) => tag[0] === "p")?.[1]
        return recipient ? (orderRumor(recipient) as never) : null
      },
    })

    installProtectedReadSigner(signer(MERCHANT_KEY), MERCHANT, () => true)
    const merchantResult = await getMerchantConversationList({
      principalPubkey: MERCHANT,
    })
    const merchantSockets = [...sockets]
    installProtectedReadSigner(signer(BUYER_KEY), BUYER, () => true)
    const buyerResult = await getBuyerConversationList({
      principalPubkey: BUYER,
    })

    expect(merchantResult.data).toHaveLength(1)
    expect(buyerResult.data).toHaveLength(1)
    expect(merchantResult.meta.inbox?.authentication?.state).toBe(
      "authenticated"
    )
    expect(buyerResult.meta.inbox?.authentication?.state).toBe("authenticated")
    expect(merchantSockets.length).toBeGreaterThan(0)
    expect(sockets.length).toBeGreaterThan(merchantSockets.length)
    expect(merchantSockets.every((socket) => socket.closed)).toBe(true)
    for (const socket of sockets) {
      expect(socket.sent.map((frame) => frame[0])).toEqual([
        "AUTH",
        "REQ",
        "CLOSE",
      ])
    }
    const persisted = JSON.stringify(persistedRows)
    expect(persisted).not.toContain(RELAY_URL)
    expect(persisted).not.toContain("challenge-")
    expect(persisted).not.toContain("22242")
    expect(persisted).not.toContain("authentication")
  })

  it("keeps cached orders visible when every relay rejects authentication", async () => {
    rejectAuthentication = true
    __setCommerceTestOverrides({
      getNdk: async () => ({ signer: {} }) as never,
      resolveInboxRelayUrls: async () => [RELAY_URL],
      getCachedOrderMessages: async () => [cachedOrderRow()],
      putCachedOrderMessages: async () => undefined,
      getCachedDirectMessages: async () => [],
      putCachedDirectMessages: async () => undefined,
      giftUnwrap: async () => null,
    })
    installProtectedReadSigner(signer(MERCHANT_KEY), MERCHANT, () => true)

    const result = await getMerchantConversationList({
      principalPubkey: MERCHANT,
    })

    expect(result.data.map((conversation) => conversation.orderId)).toEqual([
      "cached-order",
    ])
    expect(result.meta.stale).toBe(true)
    expect(result.meta.degraded).toBe(true)
    expect(result.meta.inbox?.coverage).toBe("unavailable")
    expect(result.meta.inbox?.authentication).toMatchObject({
      state: "unavailable",
      failure: "authentication_rejected",
    })
  })

  it("does not return decrypted inbox data when session authority changes during unwrap", async () => {
    let authorityCurrent = true
    let unwrapStarted!: () => void
    const started = new Promise<void>((resolve) => {
      unwrapStarted = resolve
    })
    let releaseUnwrap!: () => void
    const unwrapGate = new Promise<void>((resolve) => {
      releaseUnwrap = resolve
    })
    const written: CachedOrderMessage[] = []
    __setCommerceTestOverrides({
      getNdk: async () => ({ signer: {} }) as never,
      resolveInboxRelayUrls: async () => [RELAY_URL],
      getCachedOrderMessages: async () => [],
      putCachedOrderMessages: async (rows) => written.push(...rows),
      getCachedDirectMessages: async () => [],
      putCachedDirectMessages: async () => undefined,
      giftUnwrap: async (event) => {
        unwrapStarted()
        await unwrapGate
        const recipient = event.tags.find((tag) => tag[0] === "p")?.[1]
        return recipient ? (orderRumor(recipient) as never) : null
      },
    })
    installProtectedReadSigner(
      signer(MERCHANT_KEY),
      MERCHANT,
      () => authorityCurrent
    )

    const pending = getMerchantConversationList({
      principalPubkey: MERCHANT,
    })
    await started
    authorityCurrent = false
    releaseUnwrap()

    await expect(pending).rejects.toThrow("authority changed")
    expect(written).toEqual([])
  })

  it("aborts the protected cache transaction when authority changes during persistence", async () => {
    let authorityCurrent = true
    let persistenceStarted!: () => void
    const started = new Promise<void>((resolve) => {
      persistenceStarted = resolve
    })
    let releasePersistence!: () => void
    const persistenceGate = new Promise<void>((resolve) => {
      releasePersistence = resolve
    })
    let committed = false
    __setCommerceTestOverrides({
      getNdk: async () => ({ signer: {} }) as never,
      resolveInboxRelayUrls: async () => [RELAY_URL],
      getCachedOrderMessages: async () => [],
      getCachedDirectMessages: async () => [],
      giftUnwrap: async (event) => {
        const recipient = event.tags.find((tag) => tag[0] === "p")?.[1]
        return recipient ? (orderRumor(recipient) as never) : null
      },
      persistProtectedInboxMessages: async (
        _orders,
        _direct,
        assertAuthority
      ) => {
        assertAuthority()
        persistenceStarted()
        await persistenceGate
        assertAuthority()
        committed = true
      },
    })
    installProtectedReadSigner(
      signer(MERCHANT_KEY),
      MERCHANT,
      () => authorityCurrent
    )

    const pending = getMerchantConversationList({
      principalPubkey: MERCHANT,
    })
    await started
    authorityCurrent = false
    releasePersistence()

    await expect(pending).rejects.toThrow("authority changed")
    expect(committed).toBe(false)
  })

  it("does not return or persist legacy plaintext when authority changes during decrypt", async () => {
    let authorityCurrent = true
    let decryptStarted!: () => void
    const started = new Promise<void>((resolve) => {
      decryptStarted = resolve
    })
    let releaseDecrypt!: () => void
    const decryptGate = new Promise<void>((resolve) => {
      releaseDecrypt = resolve
    })
    const written: unknown[] = []
    __setCommerceTestOverrides({
      getNdk: async () =>
        ({
          signer: {
            decrypt: async () => {
              decryptStarted()
              await decryptGate
              return "legacy plaintext"
            },
          },
        }) as never,
      readProtectedInbox: async () => emptyProtectedRead(),
      fetchEventsFanout: async (filter) =>
        filter.kinds?.includes(4) ? ([legacyDirectMessage()] as never) : [],
      getCachedOrderMessages: async () => [],
      putCachedOrderMessages: async () => undefined,
      getCachedDirectMessages: async () => [],
      putCachedDirectMessages: async (rows) => {
        written.push(...rows)
      },
    })
    installProtectedReadSigner(signer(BUYER_KEY), BUYER, () => authorityCurrent)

    const pending = getDirectMessageConversationList({ principalPubkey: BUYER })
    await started
    authorityCurrent = false
    releaseDecrypt()

    await expect(pending).rejects.toThrow("authority changed")
    expect(written).toEqual([])
  })

  it("aborts the legacy plaintext cache transaction when authority changes during persistence", async () => {
    let authorityCurrent = true
    let persistenceStarted!: () => void
    const started = new Promise<void>((resolve) => {
      persistenceStarted = resolve
    })
    let releasePersistence!: () => void
    const persistenceGate = new Promise<void>((resolve) => {
      releasePersistence = resolve
    })
    let committed = false
    __setCommerceTestOverrides({
      getNdk: async () =>
        ({ signer: { decrypt: async () => "legacy plaintext" } }) as never,
      readProtectedInbox: async () => emptyProtectedRead(),
      fetchEventsFanout: async (filter) =>
        filter.kinds?.includes(4) ? ([legacyDirectMessage()] as never) : [],
      getCachedOrderMessages: async () => [],
      putCachedOrderMessages: async () => undefined,
      getCachedDirectMessages: async () => [],
      persistLegacyDirectMessages: async (_rows, assertAuthority) => {
        assertAuthority()
        persistenceStarted()
        await persistenceGate
        assertAuthority()
        committed = true
      },
    })
    installProtectedReadSigner(signer(BUYER_KEY), BUYER, () => authorityCurrent)

    const pending = getDirectMessageConversationList({ principalPubkey: BUYER })
    await started
    authorityCurrent = false
    releasePersistence()

    await expect(pending).rejects.toThrow("authority changed")
    expect(committed).toBe(false)
  })

  it("refuses cached order plaintext when no current protected lease exists", async () => {
    let cachedReads = 0
    __setCommerceTestOverrides({
      getNdk: async () => ({ signer: {} }) as never,
      getCachedOrderMessages: async () => {
        cachedReads += 1
        return [cachedOrderRow()]
      },
    })
    installProtectedReadSigner(signer(MERCHANT_KEY), MERCHANT, () => false)

    await expect(
      getMerchantConversationList({ principalPubkey: MERCHANT })
    ).rejects.toThrow("authority changed")
    expect(cachedReads).toBe(0)
  })

  it("does not return cached DM plaintext when authority changes during cache load", async () => {
    let authorityCurrent = true
    let cacheStarted!: () => void
    const started = new Promise<void>((resolve) => {
      cacheStarted = resolve
    })
    let releaseCache!: () => void
    const cacheGate = new Promise<void>((resolve) => {
      releaseCache = resolve
    })
    __setCommerceTestOverrides({
      getNdk: async () => ({ signer: {} }) as never,
      getCachedDirectMessages: async () => {
        cacheStarted()
        await cacheGate
        return []
      },
    })
    installProtectedReadSigner(signer(BUYER_KEY), BUYER, () => authorityCurrent)

    const pending = getDirectMessageConversationList({ principalPubkey: BUYER })
    await started
    authorityCurrent = false
    releaseCache()

    await expect(pending).rejects.toThrow("authority changed")
  })
})
