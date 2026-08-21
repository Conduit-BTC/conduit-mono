import { describe, expect, it } from "bun:test"

import {
  savePaymentAttempt,
  updatePaymentAttempt,
} from "../apps/market/src/lib/payment-attempts"
import { db, type StoredPaymentAttempt } from "../packages/core/src/db"

describe("payment attempt proof delivery", () => {
  it("does not downgrade a sent proof from stale retry work", async () => {
    let stored: StoredPaymentAttempt = {
      id: "attempt-sent",
      orderId: "attempt-sent",
      buyerPubkey: "buyer",
      merchantPubkey: "merchant",
      amountMsats: 1_000,
      currency: "SATS",
      invoice: "lnbc1test",
      proofDeliveryStatus: "sent",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    }
    const table = db.paymentAttempts as typeof db.paymentAttempts & {
      get: typeof db.paymentAttempts.get
      update: typeof db.paymentAttempts.update
    }
    const database = db as typeof db & { transaction: typeof db.transaction }
    const originalGet = table.get
    const originalUpdate = table.update
    const originalTransaction = database.transaction

    table.get = (async () => stored) as typeof table.get
    table.update = (async (
      _id: string,
      patch: Partial<StoredPaymentAttempt>
    ) => {
      stored = { ...stored, ...patch }
      return 1
    }) as typeof table.update
    database.transaction = (async (...args: unknown[]) => {
      const scope = args.at(-1) as () => Promise<unknown>
      return scope()
    }) as typeof database.transaction

    try {
      await updatePaymentAttempt(stored.id, {
        proofDeliveryStatus: "retry_needed",
      })
      expect(stored.proofDeliveryStatus).toBe("sent")
      expect(stored.updatedAt).toBeGreaterThan(1_700_000_000_000)
    } finally {
      table.get = originalGet
      table.update = originalUpdate
      database.transaction = originalTransaction
    }
  })

  it("merges receipt evidence without erasing sent wallet proof", async () => {
    let stored: StoredPaymentAttempt = {
      id: "attempt-merged",
      orderId: "attempt-merged",
      buyerPubkey: "buyer",
      merchantPubkey: "merchant",
      amountMsats: 1_000,
      currency: "SATS",
      invoice: "lnbc1test",
      paymentHash: "payment-hash",
      preimage: "payment-preimage",
      proofDeliveryStatus: "sent",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_100,
    }
    const table = db.paymentAttempts as typeof db.paymentAttempts & {
      get: typeof db.paymentAttempts.get
      put: typeof db.paymentAttempts.put
    }
    const database = db as typeof db & { transaction: typeof db.transaction }
    const originalGet = table.get
    const originalPut = table.put
    const originalTransaction = database.transaction

    table.get = (async () => stored) as typeof table.get
    table.put = (async (next: StoredPaymentAttempt) => {
      stored = next
      return next.id
    }) as typeof table.put
    database.transaction = (async (...args: unknown[]) => {
      const scope = args.at(-1) as () => Promise<unknown>
      return scope()
    }) as typeof database.transaction

    try {
      await savePaymentAttempt({
        id: stored.id,
        orderId: stored.orderId,
        buyerPubkey: stored.buyerPubkey,
        merchantPubkey: stored.merchantPubkey,
        amountMsats: stored.amountMsats,
        currency: "SATS",
        invoice: stored.invoice,
        zapRequestId: "zap-request-current",
        zapReceiptId: "zap-receipt-current",
        proofDeliveryStatus: "pending",
        createdAt: 1_700_000_000_200,
        updatedAt: 1_700_000_000_200,
      })

      expect(stored).toMatchObject({
        paymentHash: "payment-hash",
        preimage: "payment-preimage",
        zapReceiptId: "zap-receipt-current",
        proofDeliveryStatus: "sent",
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_200,
      })
    } finally {
      table.get = originalGet
      table.put = originalPut
      database.transaction = originalTransaction
    }
  })
})
