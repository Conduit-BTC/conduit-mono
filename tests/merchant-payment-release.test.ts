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
  authorizeOrganizerRelease: true,
}

describe("merchant payment and optional organizer release", () => {
  it("confirms payment only when readiness is not explicitly authorized", async () => {
    const calls: string[] = []
    const result = await confirmMerchantPayment(
      { ...input, authorizeOrganizerRelease: false, order: null },
      {
        publishPaid: async () => {
          calls.push("paid")
        },
        release: async () => {
          calls.push("release")
          return "delivered"
        },
      }
    )
    expect(calls).toEqual(["paid"])
    expect(result).toEqual({ payment: "confirmed", release: "not_requested" })
  })

  it("waits for the captured order's paid transition before release", async () => {
    const calls: string[] = []
    const captured = structuredClone(input)
    const result = await confirmMerchantPayment(captured, {
      publishPaid: async (target) => {
        expect(target.orderId).toBe("order-a")
        expect(target.delivery).toBe("buyer_and_self")
        calls.push("paid")
        // A UI selection change cannot change the in-flight release target.
        captured.order!.id = "order-b"
        captured.orderId = "order-b"
      },
      release: async (target) => {
        expect(target.order!.id).toBe("order-a")
        expect(target.orderId).toBe("order-a")
        calls.push("release")
        return "delivered"
      },
    })
    expect(calls).toEqual(["paid", "release"])
    expect(result).toEqual({ payment: "confirmed", release: "delivered" })
  })

  it("never releases when the paid transition fails", async () => {
    let releases = 0
    await expect(
      confirmMerchantPayment(input, {
        publishPaid: async () => {
          throw new Error("status delivery failed")
        },
        release: async () => {
          releases++
          return "delivered"
        },
      })
    ).rejects.toThrow("status delivery failed")
    expect(releases).toBe(0)
  })

  it.each(["orderId", "merchantPubkey", "buyerPubkey"] as const)(
    "rejects mismatched %s before any publication",
    async (field) => {
      let publications = 0
      await expect(
        confirmMerchantPayment(
          { ...input, [field]: "other" },
          {
            publishPaid: async () => {
              publications++
            },
            release: async () => {
              publications++
              return "delivered"
            },
          }
        )
      ).rejects.toThrow("captured order")
      expect(publications).toBe(0)
    }
  )

  it("keeps payment confirmed when receipt creation or delivery fails", async () => {
    let paid = 0
    const result = await confirmMerchantPayment(input, {
      publishPaid: async () => {
        paid++
      },
      release: async () => {
        throw new Error("private detail must not escape")
      },
    })
    expect(paid).toBe(1)
    expect(result).toEqual({ payment: "confirmed", release: "needs_attention" })
    expect(JSON.stringify(result)).not.toContain("private detail")
  })

  it("preserves partial receipt delivery without reporting complete success", async () => {
    const result = await confirmMerchantPayment(input, {
      publishPaid: async () => {},
      release: async () => "needs_attention",
    })
    expect(result).toEqual({ payment: "confirmed", release: "needs_attention" })
  })

  it("keeps guest confirmation on the captured self-only delivery lane", async () => {
    let delivery: string | undefined
    await confirmMerchantPayment(
      { ...input, delivery: "self_only" },
      {
        publishPaid: async (target) => {
          delivery = target.delivery
        },
        release: async () => "delivered",
      }
    )
    expect(delivery).toBe("self_only")
  })
})
