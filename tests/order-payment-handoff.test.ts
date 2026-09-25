import { describe, expect, it } from "bun:test"
import {
  queueSparkPaymentHandoff,
  takeSparkPaymentHandoff,
} from "../apps/market/src/lib/order-payment-handoff"
import type { OrderPaymentContext } from "../apps/market/src/lib/order-payment-service"

const context = {
  orderId: "accepted-order",
  buyerPubkey: "buyer-a",
} as OrderPaymentContext

describe("Spark payment handoff", () => {
  it("hands the accepted order to its buyer once", async () => {
    const purchaseCleanup = Promise.resolve()
    queueSparkPaymentHandoff(context, purchaseCleanup)

    expect(takeSparkPaymentHandoff("accepted-order", "buyer-b")).toBeNull()
    expect(takeSparkPaymentHandoff("other-order", "buyer-a")).toBeNull()
    expect(takeSparkPaymentHandoff("accepted-order", "buyer-a")).toEqual({
      context,
      purchaseCleanup,
    })
    expect(takeSparkPaymentHandoff("accepted-order", "buyer-a")).toBeNull()
  })
})
