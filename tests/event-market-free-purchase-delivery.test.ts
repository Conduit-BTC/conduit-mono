import { createInMemoryInboxDeclarationEvidenceRepository } from "@conduit/core/protocol/inbox-declaration-evidence"
import { admitFixture } from "./helpers/public-event"
import {
  createOrderRelayDeliveryRepository,
  stageOrderRelayDelivery,
  OrderRelayDeliveryStageConflictError,
  retryOrderRelayDelivery,
  buildEventMarketOrderRumorTags,
  serializeOrderRumorContent,
  preparePrivateMessageRecipientWrap,
  type StagedOrderLifecycleInput,
  type PrivateMessageEvent,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import { createEventMarketFreePurchase } from "@conduit/core/protocol/event-market-free-purchase"
import { afterEach, expect, it } from "bun:test"
import type { ConduitDB } from "@conduit/core/db"
import { unwrapPrivateMessageEnvelope } from "@conduit/core/protocol/private-message-primitives"
import { parseEventMarketFreePurchaseRumor } from "@conduit/core/protocol/event-market-free-purchase"
import { GUEST_ORDER_SESSION_TTL_MS } from "../apps/market/src/lib/guest-order-identity"
import {
  EVENT_MARKET_FREE_PURCHASE_STORAGE_KEY,
  listEventMarketFreePurchaseDeliveries,
  loadEventMarketFreePurchaseDeliveries,
  markFreePurchaseMerchantDelivered,
  prepareEventMarketFreePurchaseDelivery,
  retryStoredEventMarketFreePurchaseDelivery,
  discardUnsubmittedFreePurchaseDelivery,
} from "../apps/market/src/lib/event-market-free-purchase-delivery"
import {
  BuyerOrderPublishError,
  publishBuyerOrderMessage,
} from "../apps/market/src/lib/order-publish"
import { eventMarketFreePurchaseFixture } from "./support/event-market-free-purchase-fixture"

class MemoryStorage {
  rows = new Map<string, string>()
  getItem(key: string) {
    return this.rows.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.rows.set(key, value)
  }
}
const databases: ConduitDB[] = []
afterEach(async () => {
  for (const database of databases.splice(0)) await database.delete()
})
async function fixture() {
  const f = await eventMarketFreePurchaseFixture()
  databases.push(f.database)
  const storage = new MemoryStorage()
  const input = {
    payload: f.payload,
    identity: f.identity,
    purchaseId: crypto.randomUUID(),
    purchaseClaimDigest: f.payload.handoffId,
    storage,
    database: f.database,
    shouldContinue: () => f.clock.active,
    now: () => f.clock.now,
  }
  return { ...f, storage, input }
}
const relays = ["wss://organizer.inbox.relay.dev"]

it("does not expose a recoverable organizer attempt before the Merchant order is staged", async () => {
  const f = await fixture()
  await prepareEventMarketFreePurchaseDelivery({
    ...f.input,
    deferPersistence: true,
  })
  // A page can disappear here, before publishBuyerOrderMessage prepares the
  // original Merchant wrap. No pending packet may point at a missing order.
  expect(listEventMarketFreePurchaseDeliveries(f.storage).length).toBe(0)
  expect(await f.database.orderLifecycles.count()).toBe(0)
})

function delivery(success = true) {
  return {
    attemptedRelayUrls: relays,
    successfulRelayUrls: success ? relays : [],
    failedRelayUrls: success ? [] : relays,
    relayFailureMessages: {},
  }
}

it("durably saves an organizer-only encrypted free packet before either order handoff", async () => {
  const f = await fixture()
  const saved = await prepareEventMarketFreePurchaseDelivery(f.input)
  expect(saved.merchantDelivered).toBe(false)
  expect(saved.acknowledged).toBe(false)
  expect(JSON.stringify(listEventMarketFreePurchaseDeliveries(f.storage))).toBe(
    JSON.stringify([saved])
  )
  for (const field of [
    "payload",
    "order",
    "commerceQuote",
    "eventMarket",
    "sourceEvents",
    "wallet",
    "invoice",
    "guestContact",
  ])
    expect(saved).not.toHaveProperty(field)
  const opened = await unwrapPrivateMessageEnvelope(
    saved.wrappedToRecipient,
    f.organizerSigner
  )
  expect(parseEventMarketFreePurchaseRumor(opened)).toEqual(f.payload)
  let sent = false
  await expect(
    retryStoredEventMarketFreePurchaseDelivery({
      ...f.input,
      handoffId: saved.handoffId,
      resolveInboxRelays: async () => relays,
      publishFn: async () => {
        sent = true
        return delivery()
      },
    })
  ).rejects.toThrow("original Merchant")
  expect(sent).toBe(false)
})

it("keeps exact bytes on relay failure and retries after guest signing expiry without any signer", async () => {
  const f = await fixture()
  const prepared = await prepareEventMarketFreePurchaseDelivery(f.input)
  await markFreePurchaseMerchantDelivered({
    ...f.input,
    handoffId: prepared.handoffId,
  })
  const attempted: string[] = []
  const retry = {
    storage: f.storage,
    database: f.database,
    handoffId: prepared.handoffId,
    shouldContinue: () => true,
    resolveInboxRelays: async () => relays,
  }
  await expect(
    retryStoredEventMarketFreePurchaseDelivery({
      ...retry,
      publishFn: async (event) => {
        attempted.push(JSON.stringify(event))
        return delivery(false)
      },
    })
  ).rejects.toThrow()
  expect(
    listEventMarketFreePurchaseDeliveries(f.storage)[0]?.acknowledged
  ).toBe(false)
  f.clock.now = f.identity.createdAt + GUEST_ORDER_SESSION_TTL_MS + 1
  const done = await retryStoredEventMarketFreePurchaseDelivery({
    ...retry,
    publishFn: async (event) => {
      attempted.push(JSON.stringify(event))
      return delivery()
    },
  })
  expect(done.acknowledged).toBe(true)
  expect(attempted).toEqual([
    JSON.stringify(prepared.wrappedToRecipient),
    JSON.stringify(prepared.wrappedToRecipient),
  ])
  await retryStoredEventMarketFreePurchaseDelivery({
    ...retry,
    publishFn: async () => {
      throw new Error("Already acknowledged must not publish")
    },
  })
})

it("does not start relay work with unavailable storage or after session revocation", async () => {
  const f = await fixture()
  const unavailableStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error("Controlled storage denial")
    },
  }
  await expect(
    prepareEventMarketFreePurchaseDelivery({
      ...f.input,
      storage: unavailableStorage,
    })
  ).rejects.toThrow("storage denial")
  expect(listEventMarketFreePurchaseDeliveries(f.storage)).toEqual([])
  f.clock.active = false
  await expect(prepareEventMarketFreePurchaseDelivery(f.input)).rejects.toThrow(
    "session"
  )
})

it("rejects conflicting, corrupted and oversized saved delivery records rather than resetting them", async () => {
  const f = await fixture()
  const row = await prepareEventMarketFreePurchaseDelivery(f.input)
  const original = f.storage.getItem(EVENT_MARKET_FREE_PURCHASE_STORAGE_KEY)!
  for (const value of [
    JSON.stringify([row, row]),
    JSON.stringify([
      {
        ...row,
        wrappedToRecipient: { ...row.wrappedToRecipient, content: "changed" },
      },
    ]),
    JSON.stringify([{ ...row, organizerPubkey: f.merchantPubkey }]),
    JSON.stringify([{ ...row, acknowledged: true }]),
    "x".repeat(4 * 1024 * 1024 + 1),
  ]) {
    f.storage.setItem(EVENT_MARKET_FREE_PURCHASE_STORAGE_KEY, value)
    expect(() => listEventMarketFreePurchaseDeliveries(f.storage)).toThrow()
    expect(f.storage.getItem(EVENT_MARKET_FREE_PURCHASE_STORAGE_KEY)).toBe(
      value
    )
  }
  f.storage.setItem(EVENT_MARKET_FREE_PURCHASE_STORAGE_KEY, original)
  const exact = await prepareEventMarketFreePurchaseDelivery(f.input)
  expect(JSON.stringify(exact.wrappedToRecipient)).toBe(
    JSON.stringify(row.wrappedToRecipient)
  )
  await expect(
    prepareEventMarketFreePurchaseDelivery({
      ...f.input,
      purchaseId: crypto.randomUUID(),
    })
  ).rejects.toThrow("changed")
})

it("allows a definite pre-submission failure to reset only its unsent organizer wrap, never an ambiguous or acknowledged order", async () => {
  const f = await fixture()
  const row = await prepareEventMarketFreePurchaseDelivery(f.input)
  await expect(
    discardUnsubmittedFreePurchaseDelivery({
      ...f.input,
      handoffId: row.handoffId,
      originalOrderFailure: new BuyerOrderPublishError(
        "Controlled ambiguous send",
        "write_started",
        null
      ),
    })
  ).rejects.toThrow("non-submission")
  expect(listEventMarketFreePurchaseDeliveries(f.storage)).toHaveLength(1)
  await discardUnsubmittedFreePurchaseDelivery({
    ...f.input,
    handoffId: row.handoffId,
    originalOrderFailure: new BuyerOrderPublishError(
      "Controlled no-submission",
      "not_staged",
      null
    ),
  })
  expect(listEventMarketFreePurchaseDeliveries(f.storage)).toEqual([])
  const fresh = await prepareEventMarketFreePurchaseDelivery(f.input)
  await markFreePurchaseMerchantDelivered({
    ...f.input,
    handoffId: fresh.handoffId,
  })
  await expect(
    discardUnsubmittedFreePurchaseDelivery({
      ...f.input,
      handoffId: fresh.handoffId,
      originalOrderFailure: new BuyerOrderPublishError(
        "Unrelated prior error",
        "not_staged",
        null
      ),
    })
  ).rejects.toThrow("cannot be discarded")
})

it("commits both exact recipient records before publication and resumes them after reopening", async () => {
  const f = await fixture()
  const order = {
    ...f.order,
    buyerIdentityKind: "guest_ephemeral" as const,
    guestContact: { email: "synthetic@example.test", phone: "+15550101001" },
  }
  const payload = createEventMarketFreePurchase({
    order,
    commerceQuote: f.payload.commerceQuote,
    eventMarket: f.payload.eventMarket,
    sourceEvents: f.payload.sourceEvents,
  })
  const packet = await prepareEventMarketFreePurchaseDelivery({
    ...f.input,
    payload,
    deferPersistence: true,
  })
  const repository = createOrderRelayDeliveryRepository(f.database)
  const lifecycle: StagedOrderLifecycleInput = {
    orderId: order.id,
    createdAt: order.createdAt,
    buyerPubkey: order.buyerPubkey,
    buyerIdentityKind: "guest_ephemeral",
    merchantPubkey: order.merchantPubkey,
    checkoutMode: "pay_later",
    items: order.items,
    itemSubtotalSats: 0,
    shippingCostSats: 0,
    totalSats: 0,
    totalMsats: 0,
    currency: "SATS",
    addressValidity: "not_required",
    shippingZoneEligibility: "not_required",
    eventMarketFreePurchaseDelivery: packet,
  }
  const rumor: PrivateMessageEvent = {
    id: "",
    pubkey: order.buyerPubkey,
    kind: 16,
    created_at: Math.floor(order.createdAt / 1000),
    tags: [
      ["p", order.merchantPubkey],
      ["type", "order"],
      ["order", order.id],
      ["amount", "0"],
      ["currency", "SATS"],
      ...order.items.map((item) => [
        "item",
        item.productId,
        String(item.quantity),
      ]),
      ...buildEventMarketOrderRumorTags(order),
    ],
    content: serializeOrderRumorContent(order),
  }
  const merchantRelay = "wss://merchant.inbox.relay.dev"
  const declaration = f.signMerchant({
    kind: 10050,
    created_at: Math.floor(f.clock.now / 1000),
    tags: [["relay", merchantRelay]],
    content: "",
  })
  let merchantWrap: SignedPublicNostrEvent | undefined
  await expect(
    publishBuyerOrderMessage(rumor, order.merchantPubkey, f.identity, {
      shouldContinue: () => true,
      orderLifecycle: lifecycle,
      orderRelayDeliveryRepository: repository,
      rememberCheckoutOrderAttemptFn: () => {},
      publishPrivateMessageFn: async (input) => {
        const prepared = await preparePrivateMessageRecipientWrap(input)
        merchantWrap = prepared.wrappedToRecipient as SignedPublicNostrEvent
        await input.onRecipientPrepared!({
          ...prepared,
          deliveryRoute: "declared_inbox",
          routingAuthority: {
            eventId: declaration.id,
            eventCreatedAt: declaration.created_at,
            pubkey: declaration.pubkey,
            kind: 10050,
            relayUrls: [merchantRelay],
          },
          relayPlan: [{ relayUrl: merchantRelay, source: "declared" }],
        })
        throw new Error(
          "Controlled interruption after atomic staging, before any relay write"
        )
      },
    })
  ).rejects.toThrow("Controlled interruption")
  expect(listEventMarketFreePurchaseDeliveries(f.storage).length).toBe(0)
  f.database.close()
  await f.database.open()
  const restored = await loadEventMarketFreePurchaseDeliveries(f.input)
  expect(restored.length).toBe(1)
  expect(
    restored[0]?.wrappedToRecipient.id === packet.wrappedToRecipient.id
  ).toBe(true)
  const stored = await f.database.orderLifecycles.get(order.id)
  expect(
    stored?.orderRelayDelivery?.signedRecipientWrap.id === merchantWrap?.id
  ).toBe(true)
  expect(
    stored?.eventMarketFreePurchaseDelivery?.handoffId === packet.handoffId
  ).toBe(true)
  expect(stored?.guestContact).toBeUndefined()
  expect(stored?.shippingAddress).toBeUndefined()
  const inboxEvidence = createInMemoryInboxDeclarationEvidenceRepository()
  await inboxEvidence.merge({
    pubkey: order.merchantPubkey,
    signedEvent: await admitFixture(declaration),
  })
  let merchantSends = 0
  await retryOrderRelayDelivery(order.id, order.buyerPubkey, {
    repository,
    allowGuest: true,
    now: () => f.clock.now,
    shouldContinue: () => true,
    accountNetworkLocalStateRepository: { get: async () => null },
    inboxDeclarationEvidenceRepository: inboxEvidence,
    publisher: async ({ signedEvent }) => {
      expect(signedEvent.id === merchantWrap?.id).toBe(true)
      merchantSends++
      return "acked"
    },
  })
  expect(merchantSends).toBe(1)
  await markFreePurchaseMerchantDelivered({
    ...f.input,
    handoffId: packet.handoffId,
  })
  let organizerSends = 0
  await retryStoredEventMarketFreePurchaseDelivery({
    ...f.input,
    handoffId: packet.handoffId,
    resolveInboxRelays: async () => relays,
    publishFn: async (event) => {
      expect(event.id === packet.wrappedToRecipient.id).toBe(true)
      organizerSends++
      return delivery()
    },
  })
  f.database.close()
  await f.database.open()
  expect(
    (await loadEventMarketFreePurchaseDeliveries(f.input))[0]?.acknowledged
  ).toBe(true)
  await retryStoredEventMarketFreePurchaseDelivery({
    ...f.input,
    handoffId: packet.handoffId,
    publishFn: async () => {
      organizerSends++
      return delivery()
    },
  })
  expect(organizerSends).toBe(1)
  // A second preparation can have started before the first finished. A completed
  // claim still cannot acquire a second order ID when that late stage resumes.
  const competingId = crypto.randomUUID()
  let duplicateRejected = false
  try {
    await stageOrderRelayDelivery(
      {
        lifecycle: {
          ...lifecycle,
          orderId: competingId,
          eventMarketFreePurchaseDelivery: {
            ...packet,
            orderId: competingId,
            handoffId: "f".repeat(64),
          },
        },
        prepared: {
          rumorId: stored!.orderRelayDelivery!.rumorId,
          signedRecipientWrap: merchantWrap!,
          route: "declared_inbox",
          routingAuthority: stored!.orderRelayDelivery!.routingAuthority,
          relayPlan: [{ relayUrl: merchantRelay, source: "declared" }],
        },
        leaseOwner: "late-preparation",
      },
      { repository, now: () => f.clock.now }
    )
  } catch (cause) {
    duplicateRejected = cause instanceof OrderRelayDeliveryStageConflictError
  }
  expect(duplicateRejected).toBe(true)
  expect(await f.database.orderLifecycles.count()).toBe(1)
})
