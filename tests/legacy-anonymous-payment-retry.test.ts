import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { indexedDB, IDBKeyRange } from "fake-indexeddb"
import { createSelectedProfileContext } from "@conduit/core"
import { ConduitDB, db, type OrderLifecycle } from "@conduit/core/db"
import { requiresAcceptedOrderPaymentContinuation } from "../apps/market/src/lib/checkout-order-attempt"
import { runOrderRetryPayment } from "../apps/market/src/lib/order-payment-retry"
import {
  runOrderPrivateFallback,
  type OrderPaymentContext,
  type OrderPaymentDependencies,
} from "../apps/market/src/lib/order-payment-service"
import { makeSignedBolt11Fixture } from "./support/signed-bolt11-fixture"

const testDb = new ConduitDB(`anonymous-retry-${crypto.randomUUID()}`, {
  indexedDB,
  IDBKeyRange,
})
const originalOrders = db.orderLifecycles
const originalProfiles = db.profiles
let restoreTransaction: () => void
beforeAll(async () => {
  await testDb.open()
  db.orderLifecycles = testDb.orderLifecycles
  db.profiles = testDb.profiles
  const transaction = spyOn(db, "transaction").mockImplementation(
    testDb.transaction.bind(testDb)
  )
  restoreTransaction = () => transaction.mockRestore()
})
afterAll(async () => {
  restoreTransaction()
  db.orderLifecycles = originalOrders
  db.profiles = originalProfiles
  await testDb.delete()
})

async function fixture(overrides: Partial<OrderLifecycle> = {}) {
  const orderId = crypto.randomUUID()
  const context: OrderPaymentContext = {
    orderId,
    buyerPubkey: "a".repeat(64),
    merchantPubkey: "b".repeat(64),
    merchantLud16: "merchant@wallet.example",
    zapMode: "anonymous_public_zap",
    zapContent: "Legacy public message",
    totalSats: 100,
    totalMsats: 100_000,
    items: [],
    paymentTarget: { type: "manual" },
    shouldContinueBeforePaymentClaim: () => true,
  }
  const lifecycle: OrderLifecycle = {
    orderId,
    buyerPubkey: context.buyerPubkey,
    merchantPubkey: context.merchantPubkey,
    merchantLightningAddress: context.merchantLud16!,
    checkoutMode: context.zapMode,
    publicZapSigner: "anon",
    zapContent: context.zapContent,
    items: [],
    itemSubtotalSats: 100,
    shippingCostSats: 0,
    totalSats: 100,
    totalMsats: 100_000,
    currency: "SATS",
    addressValidity: "not_required",
    shippingZoneEligibility: "not_required",
    orderDeliveryStatus: "sent",
    checkoutRecoveryPending: true,
    invoiceStatus: "not_requested",
    paymentStatus: "not_started",
    proofDeliveryStatus: "not_started",
    zapReceiptStatus: "not_applicable",
    paymentTarget: context.paymentTarget,
    phase: "in_progress",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
  await db.orderLifecycles.put(lifecycle)
  const invoice = makeSignedBolt11Fixture({
    hrp: "lnbc1000n",
    createdAt: Math.floor(Date.now() / 1000),
  })
  const requested: string[] = []
  const dependencies: Partial<OrderPaymentDependencies> = {
    rememberOrderPaymentClaim: () => true,
    clearOrderPaymentClaim: () => true,
    checkOrderPaymentAddressUpdate: async () => ({ status: "unchanged" }),
    loadSelectedProfileContext: async (pubkey) =>
      createSelectedProfileContext({ pubkey }),
    fetchLnurlPayMetadata: async () => ({
      payRequestUrl: "https://wallet.example/.well-known/lnurlp/merchant",
      lnurl: "lnurl1test",
      callback: "https://wallet.example/callback",
      tag: "payRequest",
      minSendable: 1000,
      maxSendable: 1_000_000,
      metadata: "[]",
      allowsNostr: false,
    }),
    requestCheckoutLnurlInvoice: async (params) => {
      requested.push(params.visibility)
      return { invoice, zapRelayUrls: [], shouldWaitForZapReceipt: false }
    },
    payCheckoutInvoice: async () => ({
      status: "manual_required",
      reason: "Pay with a Lightning wallet.",
    }),
  }
  return { context, lifecycle, invoice, requested, dependencies }
}

describe("legacy anonymous order payment recovery", () => {
  it("continues an accepted unstarted order with one private invoice and retains the delivered order", async () => {
    const f = await fixture()
    expect(requiresAcceptedOrderPaymentContinuation(f.lifecycle)).toBe(true)
    const result = await runOrderRetryPayment(
      f.context,
      undefined,
      f.dependencies
    )
    expect(result.error).toBeNull()
    expect(f.requested).toEqual(["private_checkout"])
    const saved = await db.orderLifecycles.get(f.context.orderId)
    expect(saved?.orderDeliveryStatus).toBe("sent")
    expect(saved?.checkoutMode).toBe("private_checkout")
    expect(saved?.publicZapSigner).toBeUndefined()
    expect(saved?.invoice).toBe(f.invoice)
    expect(saved?.paymentStatus).toBe("manual_required")
  })

  it("still recovers a failed anonymous attempt through the explicit private fallback", async () => {
    const f = await fixture({
      invoiceStatus: "failed",
      paymentStatus: "failed",
    })
    expect(requiresAcceptedOrderPaymentContinuation(f.lifecycle)).toBe(false)
    await expect(
      runOrderRetryPayment(f.context, undefined, f.dependencies)
    ).rejects.toThrow("private-invoice recovery")
    expect(f.requested).toEqual([])
    const result = await runOrderPrivateFallback(f.context, f.dependencies)
    expect(result.error).toBeNull()
    expect(f.requested).toEqual(["private_checkout"])
    expect(result.lifecycle?.publicZapFallback).toBe(true)
    expect(result.lifecycle?.invoice).toBe(f.invoice)
    expect(result.lifecycle?.paymentStatus).toBe("manual_required")
  })

  it("does not request another invoice for a payment already awaiting external confirmation", async () => {
    const f = await fixture({
      invoiceStatus: "manual_required",
      paymentStatus: "manual_required",
    })
    await expect(
      runOrderRetryPayment(f.context, undefined, f.dependencies)
    ).rejects.toThrow("private-invoice recovery")
    expect(f.requested).toEqual([])
  })
})
