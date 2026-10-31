import { afterEach, expect, test } from "bun:test"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import Dexie from "dexie"
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure"
import { ConduitDB, type OrderLifecycle } from "@conduit/core/db"
import {
  createEventGuestReceipt,
  getEventGuestReceiptCommitment,
} from "@conduit/core/protocol/event-guest-checkout"
import { createEventPickupReceiptRepository } from "@conduit/core/protocol/event-pickup-receipt-storage"
import { buildOrderViewModel } from "../apps/market/src/lib/order-view"
import {
  getEventPickupReceiptAccess,
  loadEventPickupReceiptForOrder,
  observeEventPickupReceiptForOrder,
} from "../apps/market/src/lib/order-pickup-receipt"
import { createEventMarketOrderFixture } from "./helpers/event-market-order-fixture"

const databases: ConduitDB[] = []
afterEach(async () => {
  for (const database of databases.splice(0)) {
    database.close()
    await database.delete()
  }
})

function fixture(price = 100) {
  const event = createEventMarketOrderFixture({
    mode: "merchant_present",
    newAssignment: true,
    price,
  })
  const lifecycle: OrderLifecycle = {
    orderId: event.order.id,
    buyerPubkey: event.buyer,
    buyerIdentityKind: "signed_in",
    merchantPubkey: event.merchant,
    pickupReceiptCommitment: "d".repeat(64),
    checkoutMode: "pay_later",
    items: event.order.items,
    itemSubtotalSats: price,
    shippingCostSats: 0,
    totalSats: price,
    totalMsats: price * 1_000,
    currency: "SATS",
    addressValidity: "not_required",
    shippingZoneEligibility: "not_required",
    orderDeliveryStatus: "sent",
    invoiceStatus: "not_requested",
    paymentStatus: "not_started",
    proofDeliveryStatus: "not_started",
    zapReceiptStatus: "not_applicable",
    phase: "pending",
    createdAt: event.order.createdAt,
    updatedAt: event.order.createdAt,
    orderRelayDelivery: {
      rumorId: "e".repeat(64),
      signedRecipientWrap: finalizeEvent(
        {
          kind: 1059,
          created_at: Math.floor(event.order.createdAt / 1_000),
          tags: [["p", event.merchant]],
          content: "synthetic recipient wrap",
        },
        generateSecretKey()
      ),
      route: "declared_inbox",
      relayDelivery: [
        {
          relayUrl: "wss://receipt-orders.conduit.market",
          source: "declared",
          status: "acked",
          attemptCount: 1,
        },
      ],
      deliveryAttemptCount: 1,
      deliveryAttemptGeneration: 1,
      retryCount: 0,
      createdAt: event.order.createdAt,
      updatedAt: event.order.createdAt,
      expiresAt: event.order.createdAt + 24 * 60 * 60 * 1_000,
    },
  }
  const view = () =>
    buildOrderViewModel({
      orderId: lifecycle.orderId,
      merchantPubkey: lifecycle.merchantPubkey,
      lifecycle,
    })
  return { ...event, lifecycle, view }
}

test("a saved receipt is not revealed for unpaid or funding-only routed orders", () => {
  const state = fixture()
  expect(
    getEventPickupReceiptAccess(state.lifecycle, state.view(), state.buyer)
  ).toBeNull()
  state.lifecycle.paymentStatus = "paid"
  expect(
    getEventPickupReceiptAccess(state.lifecycle, state.view(), state.buyer)
  ).not.toBeNull()
  state.lifecycle.checkoutSparkRouterBinding = {
    checkoutId: "pending-router",
    planDigest: "e".repeat(64),
    walletId: "pending-wallet",
  }
  expect(
    getEventPickupReceiptAccess(state.lifecycle, state.view(), state.buyer)
  ).toBeNull()
})

test("a verified zero-total Event receipt needs successful exact delivery, not a fabricated paid flag", () => {
  const state = fixture(0)
  expect(
    getEventPickupReceiptAccess(state.lifecycle, state.view(), state.buyer)
  ).not.toBeNull()
  expect(state.lifecycle.paymentStatus).toBe("not_started")
  state.lifecycle.orderDeliveryStatus = "pending"
  expect(
    getEventPickupReceiptAccess(state.lifecycle, state.view(), state.buyer)
  ).toBeNull()
  state.lifecycle.orderDeliveryStatus = "sent"
  state.lifecycle.orderRelayDelivery!.relayDelivery[0]!.status = "pending"
  expect(
    getEventPickupReceiptAccess(state.lifecycle, state.view(), state.buyer)
  ).toBeNull()
})

test("another buyer or a missing Event commitment cannot reveal a receipt", () => {
  const state = fixture()
  state.lifecycle.paymentStatus = "paid"
  expect(
    getEventPickupReceiptAccess(state.lifecycle, state.view(), state.organizer)
  ).toBeNull()
  state.lifecycle.pickupReceiptCommitment = undefined
  expect(
    getEventPickupReceiptAccess(state.lifecycle, state.view(), state.buyer)
  ).toBeNull()
})

async function storedFixture() {
  const state = fixture(0)
  const receipt = createEventGuestReceipt(state.merchant)
  state.lifecycle.orderId = receipt.orderId
  state.lifecycle.pickupReceiptCommitment =
    getEventGuestReceiptCommitment(receipt)
  const database = new ConduitDB(`receipt-view-${crypto.randomUUID()}`, {
    indexedDB,
    IDBKeyRange,
  })
  databases.push(database)
  const now = () => state.fulfillment.calendar.start
  const repository = createEventPickupReceiptRepository({ database, now })
  const saved = await repository.save({
    receipt,
    buyerScope: { kind: "signed_in", pubkey: state.buyer },
    occurrenceCoordinate: state.fulfillment.calendar.coordinate,
    occurrenceEnd: state.fulfillment.calendar.end,
  })
  const access = getEventPickupReceiptAccess(
    state.lifecycle,
    state.view(),
    state.buyer
  )!
  return { ...state, database, now, repository, saved, access }
}

test("the revealed receipt must match the exact commitment and selected occurrence end", async () => {
  const state = await storedFixture()
  const options = { database: state.database, now: state.now }
  expect(
    (await loadEventPickupReceiptForOrder(state.access, options))?.orderId
  ).toBe(state.saved.orderId)
  await expect(
    loadEventPickupReceiptForOrder(
      { ...state.access, occurrenceEnd: state.access.occurrenceEnd + 1_000 },
      options
    )
  ).rejects.toThrow("The saved pickup receipt does not match this order.")
  await expect(
    loadEventPickupReceiptForOrder(
      { ...state.access, commitment: "0".repeat(64) },
      options
    )
  ).rejects.toThrow("The saved pickup receipt does not match this order.")
})

test("Delete updates an already-open receipt observation instead of reviving a stale private copy", async () => {
  const state = await storedFixture()
  // Match the browser's global IndexedDB capability as well as the injected
  // database. Dexie liveQuery intentionally stays silent without this boundary.
  const previousFactory = Dexie.dependencies.indexedDB
  const previousKeyRange = Dexie.dependencies.IDBKeyRange
  Dexie.dependencies.indexedDB = indexedDB
  Dexie.dependencies.IDBKeyRange = IDBKeyRange
  let unsubscribe = () => {}
  let removing = false
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(new Error("Receipt deletion observation did not complete.")),
        2_000
      )
      unsubscribe = observeEventPickupReceiptForOrder(
        state.access,
        (saved) => {
          if (saved && !removing) {
            removing = true
            void state.repository
              .remove(saved.orderId, state.access.buyerScope)
              .catch(() => reject(new Error("Receipt deletion failed.")))
          } else if (!saved && removing) {
            clearTimeout(timeout)
            resolve()
          }
        },
        () => {
          clearTimeout(timeout)
          reject(new Error("Receipt observation failed."))
        },
        { database: state.database, now: state.now }
      )
    })
    expect(
      await loadEventPickupReceiptForOrder(state.access, {
        database: state.database,
        now: state.now,
      })
    ).toBeNull()
  } finally {
    unsubscribe()
    Dexie.dependencies.indexedDB = previousFactory
    Dexie.dependencies.IDBKeyRange = previousKeyRange
  }
})
