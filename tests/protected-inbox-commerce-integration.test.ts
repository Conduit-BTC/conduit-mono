import {
  __resetFutureMarketHandoffTestState,
  readFutureMarketReadyReceipts,
} from "@conduit/core/protocol/future-market-handoff"
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { finalizeEvent, getEventHash, getPublicKey } from "nostr-tools"
import {
  encrypt as encryptNip04,
  decrypt as decryptNip04,
} from "nostr-tools/nip04"
import { v2 } from "nostr-tools/nip44"
import { wrapEvent } from "nostr-tools/nip59"
import {
  buildFutureMarketPrivateRumor,
  futureMarketReadyReceiptSchema,
  getEventMarketPrivateMessageList,
  fetchSignedEventsFanoutDetailed,
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  closeAllProtectedRelayConnections,
  createInMemoryAccountNetworkLocalStateRepository,
  getBuyerConversationList,
  getDirectMessageConversationList,
  getMerchantConversationList,
} from "@conduit/core"
import { ConduitDB } from "../packages/core/src/db"
import { CommerceInbox } from "../packages/core/src/protocol/commerce-inbox"
import { CommerceInboxStore } from "../packages/core/src/protocol/commerce-inbox-store"
import type {
  NostrKeySigner,
  SignedNostrEvent,
} from "../packages/core/src/protocol/nostr-event-signer"
import { parseOrderMessageRumorEvent } from "../packages/core/src/protocol/orders"
import {
  __resetProtectedReadSigner,
  getProtectedReadAuthorization,
  installProtectedReadSigner,
} from "../packages/core/src/protocol/protected-read-authorization"
import { readProtectedInbox } from "../packages/core/src/protocol/protected-inbox-read"
import {
  activateAccountSigner,
  retireAccountSigner,
  SessionSigner,
} from "../packages/core/src/protocol/session-signer"

const BUYER_KEY = new Uint8Array(32).fill(21)
const MERCHANT_KEY = new Uint8Array(32).fill(22)
const BUYER = getPublicKey(BUYER_KEY)
const MERCHANT = getPublicKey(MERCHANT_KEY)
const RELAY_URL = "wss://protected-commerce.example"

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

function orderRumor() {
  const draft = {
    kind: 16,
    pubkey: BUYER,
    created_at: 1_700_000_100,
    content: JSON.stringify({
      id: "synthetic-order",
      merchantPubkey: MERCHANT,
      buyerPubkey: BUYER,
      items: [
        {
          productId: `30402:${MERCHANT}:item`,
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
      ["p", MERCHANT],
      ["type", "order"],
      ["order", "synthetic-order"],
      ["amount", "2100"],
      ["currency", "SATS"],
    ],
  }
  return { ...draft, id: getEventHash(draft) }
}

function legacyMessage(): SignedNostrEvent {
  return finalizeEvent(
    {
      kind: 4,
      created_at: 1_700_000_200,
      tags: [["p", BUYER]],
      content: encryptNip04(MERCHANT_KEY, BUYER, "synthetic legacy message"),
    },
    MERCHANT_KEY
  )
}

const wraps = new Map<string, SignedNostrEvent>(
  [BUYER, MERCHANT].map((recipient) => [
    recipient,
    wrapEvent(orderRumor(), BUYER_KEY, recipient),
  ])
)
let paginatedWraps: SignedNostrEvent[] | null = null
let legacyWrap: SignedNostrEvent | undefined
let emitOrderWraps = true
let signCalls = 0
let decryptCalls = 0
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
    const filter = frame[2] as {
      "#p"?: string[]
      kinds?: number[]
      since?: number
      until?: number
      limit?: number
    }
    if (paginatedWraps && filter.kinds?.includes(1059)) {
      for (const event of paginatedWraps
        .filter(
          (event) =>
            (filter.since === undefined || event.created_at >= filter.since) &&
            (filter.until === undefined || event.created_at <= filter.until)
        )
        .slice(0, filter.limit))
        this.relay(["EVENT", frame[1], event])
      this.relay(["EOSE", frame[1]])
      return
    }
    const recipient = filter["#p"]?.[0]
    const event =
      filter.kinds?.includes(1059) && emitOrderWraps
        ? recipient && wraps.get(recipient)
        : filter.kinds?.includes(4)
          ? legacyWrap
          : undefined
    if (event) this.relay(["EVENT", frame[1], event])
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

class GatedInboxStore extends CommerceInboxStore {
  beforeCommit?: () => Promise<void>

  override async commit(...args: Parameters<CommerceInboxStore["commit"]>) {
    if (this.beforeCommit) await this.beforeCommit()
    return await super.commit(...args)
  }
}

interface AccountFixture {
  signer: SessionSigner
  owner: CommerceInbox
  store: GatedInboxStore
  database: ConduitDB
  authority: { current: boolean }
}

const accounts = new Map<string, AccountFixture>()
const databases: ConduitDB[] = []

function installAccount(
  key: Uint8Array,
  options: {
    beforeDecrypt?: () => Promise<void>
    beforeLegacyDecrypt?: () => Promise<void>
  } = {}
): AccountFixture {
  const pubkey = getPublicKey(key)
  const authority = { current: true }
  const provider: NostrKeySigner = {
    pubkey,
    getPublicKey: async () => pubkey,
    signEvent: async (event) => {
      signCalls += 1
      return finalizeEvent(event, key)
    },
    encryptNip44: async (peer, text) =>
      v2.encrypt(text, v2.utils.getConversationKey(key, peer)),
    decryptNip44: async (peer, text) => {
      decryptCalls += 1
      await options.beforeDecrypt?.()
      return v2.decrypt(text, v2.utils.getConversationKey(key, peer))
    },
    decryptLegacy: async (peer, text) => {
      decryptCalls += 1
      await options.beforeLegacyDecrypt?.()
      return decryptNip04(key, peer, text)
    },
  }
  const signer = new SessionSigner(provider, {
    expectedPubkey: pubkey,
    revision: "synthetic-session",
    authMethod: "nip07",
    getCapabilities: () => ({
      signEvent: true,
      nip44: true,
      nip04Decrypt: true,
    }),
    hasAuthority: () => authority.current,
  })
  activateAccountSigner(signer)
  installProtectedReadSigner(signer, pubkey, () => authority.current)
  const authorization = getProtectedReadAuthorization(pubkey)!
  const database = new ConduitDB(`protected-commerce-${crypto.randomUUID()}`, {
    indexedDB: new IDBFactory(),
    IDBKeyRange,
  })
  const store = new GatedInboxStore(authorization, database)
  const owner = new CommerceInbox(authorization, signer, store)
  const fixture = { signer, owner, store, database, authority }
  accounts.set(pubkey, fixture)
  databases.push(database)
  return fixture
}

const originalWebSocket = globalThis.WebSocket

beforeEach(() => {
  paginatedWraps = null
  __resetFutureMarketHandoffTestState()
  rejectAuthentication = false
  challengeAuthentication = true
  legacyWrap = undefined
  emitOrderWraps = true
  signCalls = 0
  decryptCalls = 0
  sockets.splice(0)
  __resetCommerceTestOverrides()
  const accountNetworkLocalStateRepository =
    createInMemoryAccountNetworkLocalStateRepository()
  __setCommerceTestOverrides({
    accountNetworkLocalStateRepository,
    readProtectedInbox: (options) =>
      readProtectedInbox({
        ...options,
        accountNetworkLocalStateRepository,
      }),
    resolveInboxRelayUrls: async () => [RELAY_URL],
    getCommerceInbox: (principal) => {
      const owner = accounts.get(principal)?.owner
      if (!owner) throw new Error("Missing synthetic inbox owner")
      return owner
    },
  })
  __resetProtectedReadSigner()
  closeAllProtectedRelayConnections()
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: CommerceProtectedRelaySocket,
  })
})

afterEach(async () => {
  for (const { owner, signer } of accounts.values()) {
    owner.stop()
    retireAccountSigner(signer)
  }
  accounts.clear()
  __resetCommerceTestOverrides()
  __resetProtectedReadSigner()
  closeAllProtectedRelayConnections()
  for (const database of databases.splice(0)) await database.delete()
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: originalWebSocket,
  })
})

describe("Market and Merchant protected inbox integration", () => {
  it("reads genuine encrypted order wraps for both roles without a relay challenge", async () => {
    challengeAuthentication = false
    const merchant = installAccount(MERCHANT_KEY)
    const merchantResult = await getMerchantConversationList({
      principalPubkey: MERCHANT,
    })
    const merchantSockets = [...sockets]
    const buyer = installAccount(BUYER_KEY)
    const buyerResult = await getBuyerConversationList({
      principalPubkey: BUYER,
    })

    expect(
      merchantResult.data.map((conversation) => conversation.orderId)
    ).toEqual(["synthetic-order"])
    expect(
      buyerResult.data.map((conversation) => conversation.orderId)
    ).toEqual(["synthetic-order"])
    for (const result of [merchantResult, buyerResult]) {
      expect(result.meta.inbox?.coverage).toBe("complete")
      expect(result.meta.inbox?.authentication?.state).toBe("not_challenged")
    }
    expect(signCalls).toBe(0)
    expect(decryptCalls).toBe(4)
    expect(merchantSockets.every((socket) => socket.closed)).toBe(true)
    expect(
      sockets
        .flatMap((socket) => socket.sent)
        .some((frame) => frame[0] === "AUTH")
    ).toBe(false)
    expect(
      sockets
        .flatMap((socket) => socket.sent)
        .filter((frame) => frame[0] === "REQ").length
    ).toBeGreaterThanOrEqual(2)
    expect(await merchant.database.commerceInboxRecords.count()).toBe(1)
    expect(await buyer.database.commerceInboxRecords.count()).toBe(1)
  })

  it("authenticates socket reads and persists only encrypted projections", async () => {
    const merchant = installAccount(MERCHANT_KEY)
    const merchantResult = await getMerchantConversationList({
      principalPubkey: MERCHANT,
    })
    const merchantSockets = [...sockets]
    installAccount(BUYER_KEY)
    const buyerResult = await getBuyerConversationList({
      principalPubkey: BUYER,
    })

    expect(merchantResult.data).toHaveLength(1)
    expect(buyerResult.data).toHaveLength(1)
    expect(merchantResult.meta.inbox?.authentication?.state).toBe(
      "authenticated"
    )
    expect(buyerResult.meta.inbox?.authentication?.state).toBe("authenticated")
    expect(signCalls).toBeGreaterThanOrEqual(2)
    expect(merchantSockets.every((socket) => socket.closed)).toBe(true)
    for (const socket of sockets) {
      const frames = socket.sent.map((frame) => frame[0])
      expect(frames).toContain("AUTH")
      expect(frames).toContain("REQ")
      expect(frames.indexOf("AUTH")).toBeLessThan(frames.indexOf("REQ"))
    }
    const stored = JSON.stringify(
      await merchant.database.commerceInboxRecords.toArray()
    )
    expect(stored).not.toContain("synthetic-order")
    expect(stored).not.toContain(RELAY_URL)
    expect(stored).not.toContain("challenge-")
    expect(stored).not.toContain("22242")
  })

  it("keeps an encrypted cached order visible when every relay rejects AUTH", async () => {
    rejectAuthentication = true
    const { owner, store, database } = installAccount(MERCHANT_KEY)
    await owner.initialize()
    await store.putProjection(
      { kind: "order", message: parseOrderMessageRumorEvent(orderRumor()) },
      1
    )
    await owner.refresh()
    const result = await getMerchantConversationList({
      principalPubkey: MERCHANT,
    })

    expect(result.data.map((conversation) => conversation.orderId)).toEqual([
      "synthetic-order",
    ])
    expect(result.meta.stale).toBe(true)
    expect(result.meta.degraded).toBe(true)
    expect(result.meta.inbox?.coverage).toBe("unavailable")
    expect(result.meta.inbox?.authentication).toMatchObject({
      state: "unavailable",
      failure: "authentication_rejected",
    })
    expect(decryptCalls).toBe(0)
    expect(await database.commerceInboxRecords.count()).toBe(1)
  })

  it("does not start a relay read or decrypt after session authority is revoked", async () => {
    const { authority, database } = installAccount(MERCHANT_KEY)
    authority.current = false
    await expect(
      getMerchantConversationList({ principalPubkey: MERCHANT })
    ).rejects.toBeDefined()
    expect(sockets).toHaveLength(0)
    expect(decryptCalls).toBe(0)
    expect(await database.commerceInboxRecords.count()).toBe(0)
  })

  it("fences a late NIP-44 decrypt after session revocation", async () => {
    const entered = deferred()
    const gate = deferred()
    const { authority, database } = installAccount(MERCHANT_KEY, {
      beforeDecrypt: async () => {
        entered.release()
        await gate.promise
      },
    })
    const pending = getMerchantConversationList({ principalPubkey: MERCHANT })
    await entered.promise
    authority.current = false
    gate.release()
    await expect(pending).rejects.toBeDefined()
    expect(await database.commerceInboxRecords.count()).toBe(0)
    expect(decryptCalls).toBe(1)
  })

  it("aborts projection storage when authority changes before commit", async () => {
    const entered = deferred()
    const gate = deferred()
    const { authority, store, database } = installAccount(MERCHANT_KEY)
    store.beforeCommit = async () => {
      entered.release()
      await gate.promise
    }
    const pending = getMerchantConversationList({ principalPubkey: MERCHANT })
    await entered.promise
    authority.current = false
    gate.release()
    await expect(pending).rejects.toBeDefined()
    expect(await database.commerceInboxRecords.count()).toBe(0)
    expect(decryptCalls).toBe(2)
  })

  it("fences genuine legacy NIP-04 plaintext after a late provider response", async () => {
    emitOrderWraps = false
    legacyWrap = legacyMessage()
    const entered = deferred()
    const gate = deferred()
    const { authority, database } = installAccount(BUYER_KEY, {
      beforeLegacyDecrypt: async () => {
        entered.release()
        await gate.promise
      },
    })
    const pending = getDirectMessageConversationList({ principalPubkey: BUYER })
    await entered.promise
    authority.current = false
    gate.release()
    await expect(pending).rejects.toBeDefined()
    expect(await database.commerceInboxRecords.count()).toBe(0)
    expect(decryptCalls).toBe(1)
  })

  it("aborts legacy NIP-04 projection storage after session revocation", async () => {
    emitOrderWraps = false
    legacyWrap = legacyMessage()
    const entered = deferred()
    const gate = deferred()
    const { authority, store, database } = installAccount(BUYER_KEY)
    store.beforeCommit = async () => {
      entered.release()
      await gate.promise
    }
    const pending = getDirectMessageConversationList({ principalPubkey: BUYER })
    await entered.promise
    authority.current = false
    gate.release()
    await expect(pending).rejects.toBeDefined()
    expect(await database.commerceInboxRecords.count()).toBe(0)
    expect(decryptCalls).toBe(1)
  })
})

function eventMarketReadyRumor() {
  return buildFutureMarketPrivateRumor(
    futureMarketReadyReceiptSchema.parse({
      version: 2,
      type: "future_market_ready",
      releaseAuthorized: true,
      claimRef: "a".repeat(64),
      merchantPubkey: MERCHANT,
      organizerPubkey: BUYER,
      market: {
        coordinate: `30409:${BUYER}:market`,
        eventId: "b".repeat(64),
        createdAt: 100_000,
      },
      calendar: {
        coordinate: `31923:${BUYER}:market-day`,
        eventId: "c".repeat(64),
        createdAt: 100_000,
      },
      grant: { eventId: "d".repeat(64), createdAt: 99_000 },
      items: [
        {
          product: {
            coordinate: `30402:${MERCHANT}:coffee`,
            eventId: "e".repeat(64),
            createdAt: 101_000,
          },
          quantity: 1,
        },
      ],
      issuedAt: 1_700_000_100,
    })
  )
}

it("reads paginated strict recovery through production AUTH transport and retains exact signed provenance", async () => {
  installAccount(BUYER_KEY)
  const rumor = eventMarketReadyRumor()
  paginatedWraps = Array.from({ length: 51 }, (_, index) =>
    wrapEvent(
      index === 0
        ? rumor
        : {
            kind: 14,
            pubkey: MERCHANT,
            created_at: 100 + index,
            tags: [["p", BUYER]],
            content: "synthetic history",
          },
      MERCHANT_KEY,
      BUYER
    )
  ).sort((a, b) => b.created_at - a.created_at)
  const first = await getEventMarketPrivateMessageList(BUYER)
  const second = await getEventMarketPrivateMessageList(BUYER)
  expect(first.inbox?.coverage).toBe("partial")
  expect(second.inbox?.coverage).toBe("partial")
  expect(second.messages.map((m) => m.id)).toContain(rumor.id)
  expect(JSON.parse(JSON.stringify(paginatedWraps))).toContainEqual(
    second.authenticatedWraps![rumor.id!]
  )
  const frames = sockets.flatMap((socket) => socket.sent)
  expect(frames.some((frame) => frame[0] === "AUTH")).toBe(true)
  const filters = frames
    .filter((frame) => frame[0] === "REQ")
    .map(
      (frame) => frame[2] as { since?: number; until?: number; kinds: number[] }
    )
  expect(
    filters.some(
      (filter) => filter.since !== undefined && filter.since === filter.until
    )
  ).toBe(true)
  await expect(
    fetchSignedEventsFanoutDetailed(
      { kinds: [1059] },
      { relayUrls: [RELAY_URL] }
    )
  ).rejects.toThrow("protected inbox")
}, 30_000)

it("canonicalizes protected wire extras before handoff storage and encrypted reload recovery", async () => {
  installAccount(BUYER_KEY)
  const rumor = eventMarketReadyRumor()
  const signed = wrapEvent(rumor, MERCHANT_KEY, BUYER)
  paginatedWraps = [
    {
      ...signed,
      padding: "x".repeat(1024 * 1024 + 1),
      __conduitSourceRelayUrls: ["wss://forged.example"],
      rawEvent: "hostile",
    } as SignedNostrEvent,
  ]
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  })
  try {
    const read = await getEventMarketPrivateMessageList(BUYER)
    expect(read.authenticatedWraps![rumor.id!]).toEqual(
      JSON.parse(JSON.stringify(signed))
    )
    const first = await readFutureMarketReadyReceipts({
      organizerPubkey: BUYER,
    })
    expect(first.claims).toHaveLength(1)
    const stored = JSON.parse(
      storage.getItem(`conduit:future-market-handoff-observed:v2:${BUYER}`) ??
        "{}"
    )
    expect(stored[rumor.id!]).toEqual(JSON.parse(JSON.stringify(signed)))
    __resetFutureMarketHandoffTestState()
    __setCommerceTestOverrides({ resolveInboxRelayUrls: async () => [] })
    const recovered = await readFutureMarketReadyReceipts({
      organizerPubkey: BUYER,
    })
    expect(recovered.claims).toHaveLength(1)
    expect(recovered.claims[0]!.receipt.id).toBe(rumor.id)
  } finally {
    __resetFutureMarketHandoffTestState()
    if (descriptor)
      Object.defineProperty(globalThis, "localStorage", descriptor)
    else Reflect.deleteProperty(globalThis, "localStorage")
  }
})
