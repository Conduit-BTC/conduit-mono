import { describe, expect, it } from "bun:test"

import { db } from "../packages/core/src/db"
import {
  isOrderPaymentRunning,
  runOrderPayment,
  type OrderPaymentContext,
} from "../apps/market/src/lib/order-payment-service"

function basePaymentContext(
  overrides: Partial<OrderPaymentContext> = {}
): OrderPaymentContext {
  return {
    orderId: "order-payment-lock-test",
    buyerPubkey: "buyer",
    merchantPubkey: "merchant",
    merchantLud16: null,
    visibility: "public_zap",
    zapContent: "",
    totalSats: 1,
    totalMsats: 1_000,
    walletConnection: null,
    tryNwc: false,
    ...overrides,
  }
}

describe("runOrderPayment", () => {
  it("releases the order in-flight lock when lifecycle patching fails", async () => {
    const ctx = basePaymentContext({
      orderId: "order-payment-lock-test-patch-failure",
    })
    const table = db.orderLifecycles as typeof db.orderLifecycles & {
      get: typeof db.orderLifecycles.get
    }
    const originalGet = table.get

    table.get = (async () => {
      throw new Error("IndexedDB unavailable")
    }) as typeof table.get

    try {
      await expect(runOrderPayment(ctx)).rejects.toThrow(
        "IndexedDB unavailable"
      )
      expect(isOrderPaymentRunning(ctx.orderId)).toBe(false)
    } finally {
      table.get = originalGet
    }
  })
})
