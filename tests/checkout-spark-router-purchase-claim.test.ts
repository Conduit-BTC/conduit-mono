import { describe, expect, test } from "bun:test"

import {
  createCheckoutSparkPurchaseClaimDigest,
  findBlockingCheckoutSparkPreparation,
} from "../apps/market/src/lib/checkout-spark-router-purchase-claim"
import {
  getCheckoutSparkSettledPreparation,
  saveCheckoutSparkSettledPreparation,
  type StoredCheckoutSparkSettledPreparation,
} from "../apps/market/src/lib/checkout-spark-settled-preparation"

const NOW = 1_800_000_000_000

function saved(
  purchaseClaimDigest?: string,
  savedAt = NOW - 46 * 60_000
): StoredCheckoutSparkSettledPreparation {
  return {
    schemaVersion: 3,
    checkoutId: "checkout-a",
    planDigest: "a".repeat(64),
    recoveryHandoffId: "handoff-a",
    fundingInvoiceExposedAt: savedAt,
    fundingSubmissionState: "not_started",
    purchaseClaimDigest,
    savedAt,
  }
}

describe("router purchase-claim duplicate guard", () => {
  test("binds to the exact cart batches, independent of allocation order", async () => {
    const first = await createCheckoutSparkPurchaseClaimDigest({
      allocations: [
        { lineId: "line-b", batches: [{ id: "batch-b", quantity: 1 }] },
        { lineId: "line-a", batches: [{ id: "batch-a", quantity: 2 }] },
      ],
    })
    const reordered = await createCheckoutSparkPurchaseClaimDigest({
      allocations: [
        { lineId: "line-a", batches: [{ id: "batch-a", quantity: 2 }] },
        { lineId: "line-b", batches: [{ id: "batch-b", quantity: 1 }] },
      ],
    })
    const newCartBatch = await createCheckoutSparkPurchaseClaimDigest({
      allocations: [
        { lineId: "line-a", batches: [{ id: "batch-new", quantity: 2 }] },
        { lineId: "line-b", batches: [{ id: "batch-b", quantity: 1 }] },
      ],
    })
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(reordered).toBe(first)
    expect(newCartBatch).not.toBe(first)
  })

  test("blocks the same cart batches even after the old global cooldown", async () => {
    const digest = await createCheckoutSparkPurchaseClaimDigest({
      allocations: [
        { lineId: "line-a", batches: [{ id: "batch-a", quantity: 1 }] },
      ],
    })
    expect(
      findBlockingCheckoutSparkPreparation([saved(digest)], digest, NOW)
    ).toBe(true)
  })

  test("permits an independent purchase while an older order is saved", async () => {
    const oldDigest = "a".repeat(64)
    const newDigest = "b".repeat(64)
    expect(
      findBlockingCheckoutSparkPreparation(
        [saved(oldDigest, NOW - 1_000)],
        newDigest,
        NOW
      )
    ).toBe(false)
  })

  test("keeps the old fail-closed window for pre-migration preparations", () => {
    expect(
      findBlockingCheckoutSparkPreparation(
        [saved(undefined, NOW - 1_000)],
        "b".repeat(64),
        NOW
      )
    ).toBe(true)
    expect(
      findBlockingCheckoutSparkPreparation(
        [saved(undefined, NOW - 46 * 60_000)],
        "b".repeat(64),
        NOW
      )
    ).toBe(false)
  })

  test("preserves the claim binding through later funding updates", () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
      },
      removeItem: (key: string) => {
        values.delete(key)
      },
    }
    const original = saved("a".repeat(64))
    saveCheckoutSparkSettledPreparation(original, storage)
    saveCheckoutSparkSettledPreparation(
      { ...original, fundingSubmissionState: "provisional", savedAt: NOW },
      storage
    )
    expect(
      getCheckoutSparkSettledPreparation(original.checkoutId, storage)
        ?.purchaseClaimDigest
    ).toBe("a".repeat(64))
    expect(() =>
      saveCheckoutSparkSettledPreparation(
        {
          ...original,
          purchaseClaimDigest: "b".repeat(64),
          fundingSubmissionState: "provisional",
          savedAt: NOW + 1,
        },
        storage
      )
    ).toThrow("conflicts with prior state")
  })
})
