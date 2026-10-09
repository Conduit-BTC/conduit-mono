import { describe, expect, it } from "bun:test"
import type {
  CheckoutSparkMerchantSettlementRecord,
  MerchantCheckoutSparkRecoveryCandidate,
} from "@conduit/core"
import { readMerchantCheckoutSparkVerification } from "../apps/merchant/src/lib/checkout-spark-merchant-verification"

const MERCHANT = "a".repeat(64)
const DIGEST = "b".repeat(64)

function candidate(
  schemaVersion: 1 | 2 | 3,
  checkoutId: string
): MerchantCheckoutSparkRecoveryCandidate {
  return {
    schemaVersion,
    checkoutId,
    orderId: "synthetic-order",
    planDigest: DIGEST,
    wrapId: "c".repeat(64),
    takeoverAt: 1,
    preparedAt: 0,
  }
}

function saved(): CheckoutSparkMerchantSettlementRecord {
  return {
    schemaVersion: 1,
    merchantPubkey: MERCHANT,
    checkoutId: "synthetic-checkout",
    orderId: "synthetic-order",
    planDigest: DIGEST,
    merchantLegId: "d".repeat(64),
    requiredCommerceLegIds: ["d".repeat(64)],
    feeLegId: "e".repeat(64),
    credit: null,
    paidLegs: [],
  }
}

describe("Merchant saved provider verification reads", () => {
  it("handles mixed legacy, initial settled, and progressed settled envelopes", async () => {
    const loaded: string[] = []
    const result = await readMerchantCheckoutSparkVerification(
      MERCHANT,
      [
        candidate(1, "legacy"),
        candidate(2, "initial"),
        candidate(3, "progress"),
      ],
      {
        async loadMerchantSettlement(principal, checkoutId, digest) {
          expect(principal).toBe(MERCHANT)
          expect(digest).toBe(DIGEST)
          if (checkoutId === "legacy") throw new Error("incompatible plan")
          loaded.push(checkoutId)
          return saved()
        },
      }
    )
    expect(loaded).toEqual(["initial", "progress"])
    expect(result.unavailable).toBe(false)
    expect(result.verified[DIGEST]).toEqual({
      creditVerified: false,
      merchantVerified: false,
      commerceVerified: false,
      feePending: false,
      recipientUnverified: false,
    })
  })

  it("retains a valid result when another local row cannot be read", async () => {
    const result = await readMerchantCheckoutSparkVerification(
      MERCHANT,
      [candidate(2, "broken"), candidate(3, "available")],
      {
        async loadMerchantSettlement(_principal, checkoutId) {
          if (checkoutId === "broken")
            throw new Error("synthetic storage failure")
          return saved()
        },
      }
    )
    expect(result.unavailable).toBe(true)
    expect(Object.keys(result.verified)).toEqual([DIGEST])
  })

  it("does not emit a negative replacement for an absent saved record", async () => {
    const result = await readMerchantCheckoutSparkVerification(
      MERCHANT,
      [candidate(2, "not-yet-verified")],
      { loadMerchantSettlement: async () => null }
    )
    expect(result).toEqual({ verified: {}, unavailable: false })
  })

  it("returns only coarse projections, not private record identities", async () => {
    const result = await readMerchantCheckoutSparkVerification(
      MERCHANT,
      [candidate(2, "initial")],
      { loadMerchantSettlement: async () => saved() }
    )
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(MERCHANT)
    expect(serialized).not.toContain("synthetic-order")
    expect(serialized).not.toContain("merchantLegId")
    expect(serialized).not.toContain("paidLegs")
  })
})
