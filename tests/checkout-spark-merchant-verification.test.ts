import { describe, expect, it } from "bun:test"
import type {
  CheckoutSparkMerchantSettlementRecord,
  MerchantCheckoutSparkRecoveryCandidate,
} from "@conduit/core"
import { readMerchantCheckoutSparkVerification } from "../apps/merchant/src/lib/checkout-spark-merchant-verification"
import { nativeTreasuryFixture } from "./support/checkout-spark-native-treasury-fixture"

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

function fullyPaidSaved(): CheckoutSparkMerchantSettlementRecord {
  const record = saved()
  return {
    ...record,
    credit: { transferId: "synthetic-credit", creditedSats: 10, observedAt: 1 },
    paidLegs: [record.merchantLegId, record.feeLegId].map((legId, index) => ({
      legId,
      transferId: `synthetic-payout-${index}`,
      allocationSats: 5,
      finalDebitSats: 5,
      finalFeeSats: 0,
      observedAt: 2,
      recipientVerified: true,
    })),
  }
}

describe("Merchant saved provider verification reads", () => {
  it("restores completed recovery only from an exact saved retirement marker", async () => {
    const result = await readMerchantCheckoutSparkVerification(
      MERCHANT,
      [candidate(2, "synthetic-checkout")],
      {
        loadMerchantSettlement: async () => saved(),
        load: async () => ({
          status: "retired",
          planDigest: DIGEST,
          retiredAt: 10,
        }),
      }
    )
    expect(result.retirement[DIGEST]).toBe("retired")
    expect(result.verified[DIGEST]).toBeDefined()
    expect(result.unavailable).toBe(false)
  })

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
        load: async () => ({ status: "absent" }),
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
        load: async () => ({ status: "absent" }),
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
      {
        loadMerchantSettlement: async () => null,
        load: async () => ({ status: "absent" }),
      }
    )
    expect(result).toEqual({
      verified: {},
      retirement: { [DIGEST]: "not_retired" },
      unavailable: false,
    })
  })

  it("returns only coarse projections, not private record identities", async () => {
    const result = await readMerchantCheckoutSparkVerification(
      MERCHANT,
      [candidate(2, "initial")],
      {
        loadMerchantSettlement: async () => saved(),
        load: async () => ({ status: "absent" }),
      }
    )
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(MERCHANT)
    expect(serialized).not.toContain("synthetic-order")
    expect(serialized).not.toContain("merchantLegId")
    expect(serialized).not.toContain("paidLegs")
  })

  it("keeps saved payment facts when the retirement marker cannot be read", async () => {
    const result = await readMerchantCheckoutSparkVerification(
      MERCHANT,
      [candidate(3, "synthetic-checkout")],
      {
        loadMerchantSettlement: async () => fullyPaidSaved(),
        async load() {
          throw new Error("synthetic marker read failure")
        },
      }
    )
    expect(result.verified[DIGEST].commerceVerified).toBe(true)
    expect(result.verified[DIGEST].feePending).toBe(false)
    expect(result.retirement[DIGEST]).toBe("unavailable")
    expect(result.unavailable).toBe(true)
  })

  it("never infers retirement from fully verified payments without a marker", async () => {
    const result = await readMerchantCheckoutSparkVerification(
      MERCHANT,
      [candidate(3, "synthetic-checkout")],
      {
        loadMerchantSettlement: async () => fullyPaidSaved(),
        load: async () => ({ status: "absent" }),
      }
    )
    expect(result.verified[DIGEST].commerceVerified).toBe(true)
    expect(result.verified[DIGEST].feePending).toBe(false)
    expect(result.retirement[DIGEST]).toBe("not_retired")
    expect(result.unavailable).toBe(false)
  })

  it("does not present an active saved plan as retired", async () => {
    const { plan, state, record } = nativeTreasuryFixture()
    const result = await readMerchantCheckoutSparkVerification(
      MERCHANT,
      [
        {
          ...candidate(3, plan.checkoutId),
          orderId: plan.orderId,
          planDigest: plan.planDigest,
        },
      ],
      {
        loadMerchantSettlement: async () => record,
        load: async () => ({ status: "active", revision: 1, state }),
      }
    )
    expect(result.verified[plan.planDigest].merchantVerified).toBe(true)
    expect(result.retirement[plan.planDigest]).toBe("not_retired")
    expect(result.unavailable).toBe(false)
  })

  it("keeps an exact retirement result when a duplicate envelope read is unavailable", async () => {
    let reads = 0
    const result = await readMerchantCheckoutSparkVerification(
      MERCHANT,
      [candidate(2, "synthetic-checkout"), candidate(3, "synthetic-checkout")],
      {
        loadMerchantSettlement: async () => fullyPaidSaved(),
        async load() {
          if (reads++ > 0) throw new Error("synthetic later marker failure")
          return { status: "retired", planDigest: DIGEST, retiredAt: 10 }
        },
      }
    )
    expect(result.verified[DIGEST].commerceVerified).toBe(true)
    expect(result.retirement[DIGEST]).toBe("retired")
    expect(result.unavailable).toBe(true)
  })

  it.each(["digest", "principal", "checkout", "order", "missing"] as const)(
    "never restores retirement from a marker lacking exact %s binding",
    async (mismatch) => {
      const record = saved()
      const result = await readMerchantCheckoutSparkVerification(
        MERCHANT,
        [candidate(2, "synthetic-checkout")],
        {
          loadMerchantSettlement: async () =>
            mismatch === "missing"
              ? null
              : {
                  ...record,
                  merchantPubkey:
                    mismatch === "principal" ? "f".repeat(64) : MERCHANT,
                  checkoutId:
                    mismatch === "checkout"
                      ? "other-checkout"
                      : record.checkoutId,
                  orderId:
                    mismatch === "order" ? "other-order" : record.orderId,
                },
          load: async () => ({
            status: "retired",
            planDigest: mismatch === "digest" ? "f".repeat(64) : DIGEST,
            retiredAt: 10,
          }),
        }
      )
      expect(result.retirement[DIGEST]).toBe("unavailable")
      expect(result.unavailable).toBe(true)
    }
  )
})
