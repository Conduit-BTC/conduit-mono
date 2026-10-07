import { describe, expect, it } from "bun:test"
import type { OrderSchema } from "@conduit/core"
import {
  confirmMerchantPayment,
  type MerchantPaymentConfirmationInput,
} from "../apps/merchant/src/lib/order-payment-release"
const order: OrderSchema = {
  id: "order-a",
  merchantPubkey: "b".repeat(64),
  buyerPubkey: "c".repeat(64),
  items: [],
  subtotal: 10,
  currency: "SAT",
  createdAt: 1,
}
const input: MerchantPaymentConfirmationInput = {
  merchantPubkey: order.merchantPubkey,
  buyerPubkey: order.buyerPubkey,
  orderId: order.id,
  delivery: "buyer_and_self",
  order,
}
describe("merchant settlement confirmation", () => {
  it("returns accepted delivery with unavailable local history without retrying paid status", async () => {
    let attempts = 0
    const delivery = {
      recipient: "accepted" as const,
      selfCopy: "pending" as const,
      localHistory: "unavailable" as const,
      checkpointFailure: true as const,
      deliveryRoute: "declared_inbox" as const,
    }
    const result = await confirmMerchantPayment(input, {
      publishPaid: async () => {
        attempts += 1
        return delivery
      },
    })
    expect(result).toEqual({ payment: "confirmed", delivery })
    expect(attempts).toBe(1)
  })

  it("publishes only the paid transition", async () => {
    let paid = 0
    expect(
      await confirmMerchantPayment(input, {
        publishPaid: async () => {
          paid += 1
        },
      })
    ).toEqual({ payment: "confirmed" })
    expect(paid).toBe(1)
  })
  it("captures the order and authority before publication", async () => {
    const shouldContinue = () => true
    const captured = { ...structuredClone(input), shouldContinue }
    await confirmMerchantPayment(captured, {
      publishPaid: async (target) => {
        captured.order!.id = "other"
        expect(target.orderId).toBe("order-a")
        expect(target.order?.id).toBe("order-a")
        expect(target.shouldContinue).toBe(shouldContinue)
      },
    })
  })
  it.each(["orderId", "merchantPubkey", "buyerPubkey"] as const)(
    "rejects mismatched %s before publication",
    async (field) => {
      let paid = 0
      await expect(
        confirmMerchantPayment(
          { ...input, [field]: "other" },
          {
            publishPaid: async () => {
              paid += 1
            },
          }
        )
      ).rejects.toThrow("exact captured order")
      expect(paid).toBe(0)
    }
  )
  it("preserves a failed paid transition for retry", async () => {
    await expect(
      confirmMerchantPayment(input, {
        publishPaid: async () => {
          throw new Error("status delivery failed")
        },
      })
    ).rejects.toThrow("status delivery failed")
  })
  it("preserves the guest self-only lane without requiring an order projection", async () => {
    let delivery: string | undefined
    await confirmMerchantPayment(
      { ...input, order: null, delivery: "self_only" },
      {
        publishPaid: async (target) => {
          delivery = target.delivery
        },
      }
    )
    expect(delivery).toBe("self_only")
  })
})
