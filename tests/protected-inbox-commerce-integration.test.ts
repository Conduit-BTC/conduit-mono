import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { finalizeEvent, getPublicKey } from "nostr-tools"
import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  closeAllProtectedRelayConnections,
  getBuyerConversationList,
  getDirectMessageConversationList,
  getMerchantConversationList,
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

function signer(privateKey: Uint8Array): NostrEventSigner {
  const pubkey = getPublicKey(privateKey)
  return {
    authMethod: "nip07",
    getPublicKey: async () => pubkey,
    signEvent: async (event) => finalizeEvent(event, privateKey),
  }
}

let rejectAuthentication = false
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
      queueMicrotask(() => this.relay(["AUTH", `challenge-${sockets.length}`]))
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
  it("authenticates the actual shared kind-1059 path for both account roles", async () => {
    const persistedRows: CachedOrderMessage[] = []
    __setCommerceTestOverrides({
      requireNdkConnected: async () => ({ signer: {} }) as never,
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
      requireNdkConnected: async () => ({ signer: {} }) as never,
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
      requireNdkConnected: async () => ({ signer: {} }) as never,
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
      requireNdkConnected: async () => ({ signer: {} }) as never,
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
      requireNdkConnected: async () =>
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
      requireNdkConnected: async () =>
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
      requireNdkConnected: async () => ({ signer: {} }) as never,
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
      requireNdkConnected: async () => ({ signer: {} }) as never,
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
