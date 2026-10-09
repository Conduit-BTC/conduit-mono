import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
} from "nostr-tools"
import { v2 } from "nostr-tools/nip44"
import { createWrap, wrapEvent } from "nostr-tools/nip59"
import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  getCachedDirectMessageConversationList,
  getConversationDetail,
  getDirectMessageConversationList,
  getDirectMessageThread,
  markDirectMessageConversationRead,
} from "@conduit/core"
import { ConduitDB } from "../packages/core/src/db"
import { CommerceInbox } from "../packages/core/src/protocol/commerce-inbox"
import { CommerceInboxStore } from "../packages/core/src/protocol/commerce-inbox-store"
import type {
  NostrKeySigner,
  SignedNostrEvent,
} from "../packages/core/src/protocol/nostr-event-signer"
import {
  getProtectedReadAuthorization,
  installProtectedReadSigner,
  __resetProtectedReadSigner,
} from "../packages/core/src/protocol/protected-read-authorization"
import {
  activateAccountSigner,
  retireAccountSigner,
  SessionSigner,
} from "../packages/core/src/protocol/session-signer"
import type {
  ReadProtectedInboxOptions,
  ProtectedInboxReadResult,
} from "../packages/core/src/protocol/protected-inbox-read"

type CacheRow = {
  id: string
  senderPubkey: string
  recipientPubkey: string
  content: string
  kind: number
  createdAt: number
  read: 0 | 1
}

const relay = "wss://inbox.example"
const databases: ConduitDB[] = []
const owners: CommerceInbox[] = []
const signers: SessionSigner[] = []
let cacheRows: CacheRow[] = []

function signedRumor(
  authorSecret: Uint8Array,
  recipientPubkey: string,
  kind: number,
  content: string,
  extraTags: string[][] = [],
  createdAt = 1_700_000_000
): { wrap: SignedNostrEvent; rumorId: string } {
  const draft = {
    kind,
    pubkey: getPublicKey(authorSecret),
    created_at: createdAt,
    tags: [["p", recipientPubkey], ...extraTags],
    content,
  }
  return {
    wrap: wrapEvent(draft, authorSecret, recipientPubkey),
    rumorId: getEventHash(draft),
  }
}

function legacyEvent(
  authorSecret: Uint8Array,
  recipientPubkey: string,
  content: string,
  createdAt: number
): SignedNostrEvent {
  return finalizeEvent(
    {
      kind: 4,
      created_at: createdAt,
      tags: [["p", recipientPubkey]],
      content,
    },
    authorSecret
  )
}

function orderContent(
  orderId: string,
  buyer: string,
  merchant: string
): string {
  return JSON.stringify({
    id: orderId,
    merchantPubkey: merchant,
    buyerPubkey: buyer,
    items: [
      {
        productId: "synthetic-item",
        format: "physical",
        quantity: 1,
        priceAtPurchase: 1,
        currency: "SATS",
      },
    ],
    subtotal: 1,
    currency: "SATS",
    shippingCostSats: 0,
    shippingCostStatus: "not_required",
    createdAt: 1_700_000_000_000,
  })
}

function setup() {
  const buyerSecret = generateSecretKey()
  const merchantSecret = generateSecretKey()
  const buyer = getPublicKey(buyerSecret)
  const merchant = getPublicKey(merchantSecret)
  let decrypts = 0
  const provider: NostrKeySigner = {
    pubkey: buyer,
    authMethod: "nip07",
    getPublicKey: async () => buyer,
    signEvent: async (event) => finalizeEvent(event, buyerSecret),
    encryptNip44: async (peer, content) =>
      v2.encrypt(content, v2.utils.getConversationKey(buyerSecret, peer)),
    decryptNip44: async (peer, content) => {
      decrypts += 1
      return v2.decrypt(content, v2.utils.getConversationKey(buyerSecret, peer))
    },
    decryptLegacy: async (_peer, content) => `plain:${content}`,
  }
  let current = true
  const signer = new SessionSigner(provider, {
    expectedPubkey: buyer,
    revision: crypto.randomUUID(),
    authMethod: "nip07",
    getCapabilities: () => ({
      signEvent: true,
      nip44: true,
      nip04Decrypt: true,
    }),
    hasAuthority: () => current,
  })
  activateAccountSigner(signer)
  signers.push(signer)
  installProtectedReadSigner(signer, buyer, () => current)
  const authorization = getProtectedReadAuthorization(buyer)!
  const database = new ConduitDB(`dm-gateway-${crypto.randomUUID()}`, {
    indexedDB: new IDBFactory(),
    IDBKeyRange,
  })
  databases.push(database)
  const owner = new CommerceInbox(
    authorization,
    signer,
    new CommerceInboxStore(authorization, database)
  )
  owners.push(owner)
  const events: SignedNostrEvent[] = []
  const reads: ReadProtectedInboxOptions["transport"][] = []
  const read = async (
    options: ReadProtectedInboxOptions
  ): Promise<ProtectedInboxReadResult> => {
    reads.push(options.transport)
    const selected = events.filter((event) => {
      if (options.transport === "nip17")
        return (
          event.kind === 1059 &&
          event.tags.some((tag) => tag[0] === "p" && tag[1] === buyer)
        )
      if (options.transport === "nip04_incoming")
        return (
          event.kind === 4 &&
          event.pubkey !== buyer &&
          event.tags.some((tag) => tag[0] === "p" && tag[1] === buyer)
        )
      return event.kind === 4 && event.pubkey === buyer
    })
    return {
      events: selected,
      coverage: "complete",
      auth: {
        state: "not_challenged",
        challengedCount: 0,
        succeededCount: 0,
        failedCount: 0,
      },
      relayResult: {
        status: "success",
        observations: [],
        attemptedCount: 1,
        completedCount: 1,
        failedCount: 0,
        authoritativeEmpty: selected.length === 0,
        relays: [
          {
            relayIndex: 0,
            status: "success",
            auth: "not_challenged",
            eventCount: selected.length,
            duplicateCount: 0,
            malformedCount: 0,
            unusableCount: 0,
          },
        ],
      },
    }
  }
  __setCommerceTestOverrides({
    getCommerceInbox: (principal) => {
      if (principal !== buyer) throw new Error("Wrong account owner")
      return owner
    },
    getAccountSigner: () => signer,
    resolveInboxRelayUrls: async () => [relay],
    readProtectedInbox: read,
  })
  return {
    buyer,
    merchant,
    buyerSecret,
    merchantSecret,
    owner,
    database,
    events,
    reads,
    decrypts: () => decrypts,
    retire: () => {
      current = false
      retireAccountSigner(signer)
    },
  }
}

beforeEach(() => {
  __resetCommerceTestOverrides()
  cacheRows = []
})

afterEach(async () => {
  __resetCommerceTestOverrides()
  for (const owner of owners.splice(0)) owner.stop()
  __resetProtectedReadSigner()
  for (const signer of signers.splice(0)) retireAccountSigner(signer)
  for (const database of databases.splice(0)) await database.delete()
})

describe("shared direct-message gateway", () => {
  it("reads incoming and outgoing legacy events into distinct transport threads", async () => {
    const h = setup()
    h.events.push(
      signedRumor(h.merchantSecret, h.buyer, 14, "current message").wrap,
      legacyEvent(h.merchantSecret, h.buyer, "legacy-incoming", 1_700_000_001),
      legacyEvent(h.buyerSecret, h.merchant, "legacy-outgoing", 1_700_000_002)
    )
    const result = await getDirectMessageConversationList({
      principalPubkey: h.buyer,
    })
    expect(h.reads).toContain("nip04_incoming")
    expect(h.reads).toContain("nip04_outgoing")
    expect(result.data.map((item) => item.id).sort()).toEqual([
      `nip04:${h.merchant}`,
      `nip17:${h.merchant}`,
    ])
    const legacy = result.data.find((item) => item.transport === "nip04")
    expect(legacy?.messages.map((message) => message.content).sort()).toEqual([
      "plain:legacy-incoming",
      "plain:legacy-outgoing",
    ])
    expect(await h.database.messages.count()).toBe(0)
    expect(
      JSON.stringify(await h.database.commerceInboxRecords.toArray())
    ).not.toContain("plain:legacy")
  })

  it("shares one authenticated decode across concurrent direct and order consumers", async () => {
    const h = setup()
    h.events.push(
      signedRumor(h.merchantSecret, h.buyer, 14, "hello").wrap,
      signedRumor(
        h.merchantSecret,
        h.buyer,
        16,
        JSON.stringify({ note: "order note" }),
        [
          ["type", "message"],
          ["order", "order-1"],
        ],
        1_700_000_001
      ).wrap
    )
    const [direct, orders] = await Promise.all([
      getDirectMessageConversationList({ principalPubkey: h.buyer }),
      getConversationDetail({ principalPubkey: h.buyer, orderId: "order-1" }),
    ])
    expect(direct.data[0]?.messageCount).toBe(1)
    expect(orders.data?.messages).toHaveLength(1)
    expect(h.decrypts()).toBe(4)
    await getDirectMessageConversationList({ principalPubkey: h.buyer })
    expect(h.decrypts()).toBe(4)
    expect(await h.database.commerceInboxWrappers.count()).toBe(2)
    expect(await h.database.commerceInboxRecords.count()).toBe(2)
  })

  it("keeps exact companion hidden only after its matching order is authenticated", async () => {
    const h = setup()
    const order = signedRumor(
      h.merchantSecret,
      h.buyer,
      16,
      orderContent("order-1", h.buyer, h.merchant),
      [
        ["type", "order"],
        ["order", "order-1"],
      ]
    )
    const copy =
      "A new order was sent to you through Conduit Market.\n" +
      "Review it at: https://sell.conduit.market/orders?order=order-1"
    h.events.push(
      signedRumor(h.merchantSecret, h.buyer, 14, copy, [
        ["subject", "conduit-order-notification"],
        ["order", "order-1"],
        ["conduit", "order-companion", "1", order.rumorId],
        ["client", "Conduit Market"],
      ]).wrap
    )
    const first = await getDirectMessageConversationList({
      principalPubkey: h.buyer,
    })
    expect(first.data).toHaveLength(1)
    h.events.push(order.wrap)
    const second = await getDirectMessageConversationList({
      principalPubkey: h.buyer,
    })
    expect(second.data).toHaveLength(0)
    expect(h.owner.getSnapshot().orderMessages).toHaveLength(1)
    expect(h.owner.getSnapshot().directMessages).toHaveLength(0)
  })

  it("isolates an invalid signed wrapper while retaining a valid neighbor", async () => {
    const h = setup()
    const malformedSeal = finalizeEvent(
      {
        kind: 13,
        created_at: 1_700_000_001,
        tags: [],
        content: v2.encrypt(
          "not-a-rumor",
          v2.utils.getConversationKey(h.merchantSecret, h.buyer)
        ),
      },
      h.merchantSecret
    )
    h.events.push(
      signedRumor(h.merchantSecret, h.buyer, 14, "readable").wrap,
      createWrap(malformedSeal, h.buyer)
    )
    const result = await getDirectMessageConversationList({
      principalPubkey: h.buyer,
    })
    expect(result.data).toHaveLength(1)
    expect(h.owner.getSnapshot().diagnostics.states.invalid_envelope).toBe(1)
    expect(h.owner.getSnapshot().directMessages[0]?.content).toBe("readable")
  })

  it("groups the authenticated thread and marks only incoming selected messages read", async () => {
    const h = setup()
    h.events.push(
      signedRumor(h.merchantSecret, h.buyer, 14, "incoming").wrap,
      signedRumor(
        h.buyerSecret,
        h.buyer,
        14,
        "outgoing self-copy",
        [["p", h.merchant]],
        1_700_000_001
      ).wrap
    )
    const thread = await getDirectMessageThread({
      principalPubkey: h.buyer,
      counterpartyPubkey: h.merchant,
      transport: "nip17",
    })
    expect(thread.data?.messages.map((message) => message.content)).toEqual([
      "incoming",
      "outgoing self-copy",
    ])
    expect(
      await markDirectMessageConversationRead({
        principalPubkey: h.buyer,
        counterpartyPubkey: h.merchant,
        transport: "nip17",
      })
    ).toBe(1)
    expect(
      await markDirectMessageConversationRead({
        principalPubkey: h.buyer,
        counterpartyPubkey: h.merchant,
        transport: "nip17",
      })
    ).toBe(0)
  })

  it("retains extra recipients as metadata while replies and read state stay in one counterparty thread", async () => {
    const h = setup()
    const third = getPublicKey(generateSecretKey())
    h.events.push(
      signedRumor(h.merchantSecret, h.buyer, 14, "group reply", [
        ["p", third],
        ["e", "synthetic-parent"],
      ]).wrap
    )
    const result = await getDirectMessageConversationList({
      principalPubkey: h.buyer,
    })
    const participants = [h.buyer, h.merchant, third].sort()
    expect(result.data).toHaveLength(1)
    expect(result.data[0]?.participants).toEqual(participants)
    expect(result.data[0]?.messages[0]?.replyTo).toBe("synthetic-parent")
    h.events.push(
      signedRumor(
        h.buyerSecret,
        h.buyer,
        14,
        "two-party reply",
        [["p", h.merchant]],
        1_700_000_001
      ).wrap
    )
    const replied = await getDirectMessageConversationList({
      principalPubkey: h.buyer,
    })
    expect(replied.data).toHaveLength(1)
    expect(replied.data[0]?.id).toBe(`nip17:${h.merchant}`)
    expect(
      replied.data[0]?.messages?.map((message) => message.content)
    ).toEqual(["group reply", "two-party reply"])
    expect(
      await markDirectMessageConversationRead({
        principalPubkey: h.buyer,
        counterpartyPubkey: h.merchant,
        transport: "nip17",
        conversationId: `nip17:${h.merchant}`,
      })
    ).toBe(1)
    const cached = await getCachedDirectMessageConversationList({
      principalPubkey: h.buyer,
    })
    expect(cached.data).toHaveLength(1)
    expect(cached.data[0]?.messageCount).toBe(2)
    expect(cached.data[0]?.unreadFromCounterparty).toBe(0)
  })

  it("fences old-account state after a session change", async () => {
    const first = setup()
    first.events.push(
      signedRumor(first.merchantSecret, first.buyer, 14, "first account").wrap
    )
    expect(
      (await getDirectMessageConversationList({ principalPubkey: first.buyer }))
        .data
    ).toHaveLength(1)
    first.retire()
    __resetProtectedReadSigner()
    const second = setup()
    second.events.push(
      signedRumor(second.merchantSecret, second.buyer, 14, "second account")
        .wrap
    )
    expect(
      (
        await getDirectMessageConversationList({
          principalPubkey: second.buyer,
        })
      ).data[0]?.preview
    ).toBe("second account")
    expect(first.owner.getSnapshot().directMessages).toHaveLength(0)
    expect(() => first.owner.assertCurrent()).toThrow()
  })

  it("keeps the cache-only projection limited to supplied local rows", async () => {
    const h = setup()
    cacheRows = [
      {
        id: "cached",
        senderPubkey: h.merchant,
        recipientPubkey: h.buyer,
        content: "cached preview",
        kind: 14,
        createdAt: 1_700_000_000_000,
        read: 0,
      },
    ]
    __setCommerceTestOverrides({
      getCachedDirectMessages: async () => cacheRows as never,
    })
    const list = await getCachedDirectMessageConversationList({
      principalPubkey: h.buyer,
    })
    expect(list.data[0]?.preview).toBe("cached preview")
    expect(list.data[0]?.unreadFromCounterparty).toBe(1)
    expect(await h.database.commerceInboxWrappers.count()).toBe(0)
  })
})
