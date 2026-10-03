import { describe, expect, it } from "bun:test"
import type { CheckoutSparkSettledRepositorySnapshot } from "@conduit/core"

import { closeUnusedSparkWallets } from "../apps/market/src/lib/checkout-spark-router-wallet-retention"
import type { StoredCheckoutSparkSettledPreparation } from "../apps/market/src/lib/checkout-spark-settled-preparation"

const NOW = 1_800_000_000_000
const PLAN_DIGEST = "a".repeat(64)
const saved: StoredCheckoutSparkSettledPreparation = {
  schemaVersion: 3,
  checkoutId: "settled-checkout",
  planDigest: PLAN_DIGEST,
  recoveryHandoffId: "merchant-recovery",
  fundingInvoiceExposedAt: NOW,
  fundingSubmissionState: "not_started",
  savedAt: NOW,
}

class MemoryStorage {
  private readonly values = new Map<string, string>()
  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
  removeItem(key: string): void {
    this.values.delete(key)
  }
}

function activeSnapshot(
  takeoverAt: number
): CheckoutSparkSettledRepositorySnapshot {
  return {
    status: "active",
    revision: 1,
    state: {
      plan: {
        checkoutId: saved.checkoutId,
        planDigest: saved.planDigest,
        walletId: "settled-wallet",
        takeoverAt,
      },
    },
  } as CheckoutSparkSettledRepositorySnapshot
}

function openWallets() {
  const open = new Set([
    "registered-wallet",
    "settled-wallet",
    "unrelated-wallet",
  ])
  const manager = {
    async closeWalletsExcept(walletIds: ReadonlySet<string>) {
      for (const walletId of open) {
        if (!walletIds.has(walletId)) open.delete(walletId)
      }
    },
  }
  return { open, manager }
}

describe("settled checkout wallet retention during regular-wallet reload", () => {
  it("keeps a saved, active settled wallet through Orders navigation", async () => {
    const { open, manager } = openWallets()
    const storage = new MemoryStorage()
    storage.setItem(
      "conduit:checkout-spark-settled-preparations:v3",
      JSON.stringify([saved])
    )
    await closeUnusedSparkWallets(manager, ["registered-wallet"], {
      now: NOW + 301_000,
      storage,
      loadSettledSnapshot: async () => activeSnapshot(NOW + 1_200_000),
    } as Parameters<typeof closeUnusedSparkWallets>[2])
    // The invoice may have expired, but could still settle; a wallet-registry
    // refresh must not close the temporary wallet before buyer takeover.
    expect(open).toEqual(new Set(["registered-wallet", "settled-wallet"]))
  })

  it("skips cleanup when settled preparation or reconciliation cannot be read", async () => {
    for (const broken of ["preparation", "reconciliation"] as const) {
      const { open, manager } = openWallets()
      await closeUnusedSparkWallets(manager, ["registered-wallet"], {
        now: NOW,
        listSettledPreparations: () => {
          if (broken === "preparation") throw new Error("unreadable")
          return [saved]
        },
        loadSettledSnapshot: async () => {
          throw new Error("unreadable")
        },
      } as Parameters<typeof closeUnusedSparkWallets>[2])
      expect(open).toEqual(
        new Set(["registered-wallet", "settled-wallet", "unrelated-wallet"])
      )
    }
  })

  it("releases a known settled wallet at its takeover boundary", async () => {
    const { open, manager } = openWallets()
    await closeUnusedSparkWallets(manager, ["registered-wallet"], {
      now: NOW + 1_200_000,
      listSettledPreparations: () => [saved],
      loadSettledSnapshot: async () => activeSnapshot(NOW + 1_200_000),
    } as Parameters<typeof closeUnusedSparkWallets>[2])
    expect(open).toEqual(new Set(["registered-wallet"]))
  })
})
