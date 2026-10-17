import { afterEach, expect, it } from "bun:test"
import type { ConduitDB } from "@conduit/core/db"
import { unwrapPrivateMessageEnvelope } from "@conduit/core/protocol/private-message-primitives"
import { parseEventMarketFreePurchaseRumor } from "@conduit/core/protocol/event-market-free-purchase"
import { GUEST_ORDER_SESSION_TTL_MS } from "../apps/market/src/lib/guest-order-identity"
import {
  EVENT_MARKET_FREE_PURCHASE_STORAGE_KEY,
  listEventMarketFreePurchaseDeliveries,
  markFreePurchaseMerchantDelivered,
  prepareEventMarketFreePurchaseDelivery,
  retryStoredEventMarketFreePurchaseDelivery,
  discardUnsubmittedFreePurchaseDelivery,
} from "../apps/market/src/lib/event-market-free-purchase-delivery"
import { BuyerOrderPublishError } from "../apps/market/src/lib/order-publish"
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
    shouldContinue: () => f.clock.active,
    now: () => f.clock.now,
  }
  return { ...f, storage, input }
}
const relays = ["wss://organizer.inbox.relay.dev"]
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
