import { describe, expect, it } from "bun:test"

import {
  captureMerchantPaymentConfirmationTarget,
  resolveMerchantPaymentConfirmationSelection,
} from "../apps/merchant/src/lib/order-action-view"

const confirmPaymentActions = [
  {
    action: "confirm_payment" as const,
    status: "paid" as const,
  },
]

describe("merchant payment confirmation selection", () => {
  it("keeps confirmation bound to the exact conversation and order", () => {
    const orderA = { id: "conversation-a", orderId: "order-a" }
    const orderB = { id: "conversation-b", orderId: "order-b" }
    const target = captureMerchantPaymentConfirmationTarget(orderA)

    expect(
      resolveMerchantPaymentConfirmationSelection({
        target,
        selected: orderA,
        actions: confirmPaymentActions,
      })
    ).toBe(orderA)
    expect(
      resolveMerchantPaymentConfirmationSelection({
        target,
        selected: orderB,
        actions: confirmPaymentActions,
      })
    ).toBeNull()
  })

  it("rejects a reused conversation id for a different order", () => {
    const target = captureMerchantPaymentConfirmationTarget({
      id: "conversation-a",
      orderId: "order-a",
    })

    expect(
      resolveMerchantPaymentConfirmationSelection({
        target,
        selected: { id: "conversation-a", orderId: "order-b" },
        actions: confirmPaymentActions,
      })
    ).toBeNull()
  })

  it("rejects confirmation when the exact order is no longer eligible", () => {
    const orderA = { id: "conversation-a", orderId: "order-a" }
    const target = captureMerchantPaymentConfirmationTarget(orderA)

    expect(
      resolveMerchantPaymentConfirmationSelection({
        target,
        selected: orderA,
        actions: [],
      })
    ).toBeNull()
  })
})
