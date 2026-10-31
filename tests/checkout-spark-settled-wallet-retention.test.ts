import { describe, expect, it } from "bun:test"
import type { CheckoutSparkSettledRepositorySnapshot } from "@conduit/core"

import { closeUnusedSparkWallets } from "@conduit/core/wallets/checkout-spark-router-wallet-retention"
import { acquireCheckoutSparkWalletRetentionLock } from "../apps/market/src/lib/checkout-spark-wallet-retention-lock"
import { acquireCheckoutSparkWalletRetentionLock as acquireSharedRetentionLock } from "@conduit/core/wallets/checkout-spark-wallet-retention-lock"
import type { StoredCheckoutSparkSettledPreparation } from "../apps/market/src/lib/checkout-spark-settled-preparation"
import {
  SparkWalletManager,
  type SparkSdkClient,
} from "@conduit/core/wallets/spark-wallet"
import { MemorySparkDirectTransferSafetyStore } from "@conduit/core/wallets/spark-direct-transfer-safety"
import {
  bolt11PaymentHashField,
  makeBolt11Fixture,
} from "./support/bolt11-fixture"

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
  takeoverAt: number,
  fundingExpiresAt = NOW + 900_000
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
        funding: { expiresAt: fundingExpiresAt },
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
  it("uses one preparation serialization lock across app and Core callers", () => {
    expect(acquireCheckoutSparkWalletRetentionLock).toBe(
      acquireSharedRetentionLock
    )
  })

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
      loadSettledSnapshot: async () =>
        activeSnapshot(NOW + 1_200_000, NOW + 300_000),
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

  it("preserves a historical longer takeover and releases the known wallet when both saved windows end", async () => {
    const { open, manager } = openWallets()
    await closeUnusedSparkWallets(manager, ["registered-wallet"], {
      now: NOW + 1_200_000,
      listSettledPreparations: () => [saved],
      loadSettledSnapshot: async () => activeSnapshot(NOW + 1_200_000),
    } as Parameters<typeof closeUnusedSparkWallets>[2])
    expect(open).toEqual(new Set(["registered-wallet"]))
  })

  it("does not close wallets when the caller becomes stale during retained-history inspection", async () => {
    const { open, manager } = openWallets()
    let current = true
    let started!: () => void
    const reading = new Promise<void>((resolve) => {
      started = resolve
    })
    let resume!: (snapshot: CheckoutSparkSettledRepositorySnapshot) => void
    const pending = new Promise<CheckoutSparkSettledRepositorySnapshot>(
      (resolve) => {
        resume = resolve
      }
    )
    const cleanup = closeUnusedSparkWallets(manager, ["registered-wallet"], {
      now: NOW + 900_001,
      listSettledPreparations: () => [saved],
      loadSettledSnapshot: async () => {
        started()
        return pending
      },
      shouldContinue: () => current,
    })
    try {
      await reading
      current = false
      resume(activeSnapshot(NOW + 120_000))
      await cleanup
      expect(open).toEqual(
        new Set(["registered-wallet", "settled-wallet", "unrelated-wallet"])
      )
    } finally {
      resume(activeSnapshot(NOW + 120_000))
      await cleanup
    }
  })

  it("does not close wallets when the caller becomes stale while waiting for the retention lock", async () => {
    const { open, manager } = openWallets()
    const release = await acquireCheckoutSparkWalletRetentionLock()
    let current = true
    const cleanup = closeUnusedSparkWallets(manager, ["registered-wallet"], {
      now: NOW + 900_001,
      listSettledPreparations: () => [],
      shouldContinue: () => current,
    })
    try {
      current = false
      release()
      await cleanup
      expect(open).toEqual(
        new Set(["registered-wallet", "settled-wallet", "unrelated-wallet"])
      )
    } finally {
      release()
      await cleanup
    }
  })

  it("closes unused wallets after retained-history inspection while the caller remains current", async () => {
    const { open, manager } = openWallets()
    await closeUnusedSparkWallets(manager, ["registered-wallet"], {
      now: NOW + 900_001,
      listSettledPreparations: () => [saved],
      loadSettledSnapshot: async () => activeSnapshot(NOW + 120_000),
      shouldContinue: () => true,
    })
    expect(open).toEqual(new Set(["registered-wallet"]))
  })

  it("preserves the original fifteen-minute funding window after new two-minute takeover without extending it on reload", async () => {
    const { open, manager } = openWallets()
    const reload = (now: number) =>
      closeUnusedSparkWallets(manager, ["registered-wallet"], {
        now,
        listSettledPreparations: () => [saved],
        loadSettledSnapshot: async () => activeSnapshot(NOW + 120_000),
      })
    for (const now of [NOW + 120_000, NOW + 300_000, NOW + 899_999]) {
      await reload(now)
      expect(open).toEqual(new Set(["registered-wallet", "settled-wallet"]))
    }
    await reload(NOW + 900_000)
    expect(open).toEqual(new Set(["registered-wallet"]))
  })

  it.each(["lightning", "native", "query", "native_query"] as const)(
    "registry cleanup preserves an entered %s operation through handoff and original expiry, then releases it after drain",
    async (mode) => {
      const queryOnly = mode === "query" || mode === "native_query"
      let now = NOW + 119_000
      let submitted = 0
      let disconnected = 0
      let finish!: () => void
      const drain = new Promise<void>((resolve) => {
        finish = resolve
      })
      const invoice = makeBolt11Fixture({
        hrp: "lnbc10000n",
        fields: [bolt11PaymentHashField(new Uint8Array(32).fill(7))],
      })
      const intent = {
        network: "mainnet" as const,
        transferId: "018f6d8e-8b7c-7ca2-9d5a-000000000001",
        paymentRequest: invoice,
        amountSats: 1_000,
        maxFeeSats: 2,
        assertBeforeSend: async () => {
          if (now >= NOW + 120_000) throw new Error("Buyer authority ended.")
        },
      }
      const client: SparkSdkClient = {
        async disconnect() {
          disconnected += 1
        },
        async getInfo() {
          return { balanceSats: 0 }
        },
        async listPayments() {
          return { payments: [] }
        },
        async prepareSendPayment() {
          throw new Error("No fresh payment may be prepared.")
        },
        async sendPayment() {
          throw new Error("No ordinary payment may be sent.")
        },
        async receivePayment() {
          throw new Error("No replacement invoice may be created.")
        },
        async sendCheckoutLightningObligation(request) {
          await request.assertBeforeSend?.()
          submitted += 1
          await drain
          return { status: "ambiguous" }
        },
        async sendCheckoutTreasury(request) {
          await request.assertBeforeSend?.()
          submitted += 1
          await drain
          return { status: "ambiguous" }
        },
        async reconcileLightningSend() {
          await drain
          return { status: "not_found" }
        },
        async inspectCheckoutTreasury(request) {
          await drain
          return {
            invoiceId: request.nativeTreasury.invoiceId,
            status: "lookup_unavailable",
          }
        },
      }
      const manager = new SparkWalletManager(
        { network: "mainnet", open: async () => client },
        async () => ({ release: async () => {} }),
        new MemorySparkDirectTransferSafetyStore(),
        () => now
      )
      await manager.openWithMnemonic({
        walletId: "settled-wallet",
        mnemonic: ["synthetic", "noncredential", "input"].join("-"),
        accountNumber: 1,
      })
      const native = {
        network: "mainnet" as const,
        nativeTreasury: {
          schemaVersion: 1 as const,
          sparkAddress: "synthetic-receiver",
          receiverIdentityPublicKey: "synthetic-receiver-identity",
          senderIdentityPublicKey: "synthetic-sender-identity",
          invoiceId: "synthetic-invoice-id",
          invoiceRequest: "synthetic-invoice-request",
          feePolicy: "zero_required" as const,
          residualPolicy: "unused_commerce_reserves" as const,
        },
        amountSats: 111,
        authorizedDebitSats: 111,
        priorSendMayHaveOccurred: false,
        assertBeforeSend: intent.assertBeforeSend,
      }
      const work =
        mode === "lightning"
          ? manager.sendCheckoutLightningObligation("settled-wallet", intent)
          : mode === "native"
            ? manager.sendCheckoutTreasury("settled-wallet", native)
            : mode === "native_query"
              ? manager.inspectCheckoutTreasury("settled-wallet", native)
              : manager.reconcileInvoiceAttempt("settled-wallet", {
                  schemaVersion: 1,
                  walletId: "settled-wallet",
                  createdAt: NOW,
                  ...intent,
                })
      await Promise.resolve()
      const reload = () =>
        closeUnusedSparkWallets(manager, [], {
          now,
          listSettledPreparations: () => [saved],
          loadSettledSnapshot: async () => activeSnapshot(NOW + 120_000),
        })
      try {
        now = NOW + 120_001
        await reload()
        expect(manager.isOpen("settled-wallet")).toBe(true)
        now = NOW + 900_001
        await reload()
        expect(manager.isOpen("settled-wallet")).toBe(true)
        expect(disconnected).toBe(0)
        expect(submitted).toBe(queryOnly ? 0 : 1)
        // Retaining RAM is not renewed buyer dispatch authority.
        await expect(
          manager.sendCheckoutLightningObligation("settled-wallet", intent)
        ).rejects.toThrow("Buyer authority ended")
        expect(submitted).toBe(queryOnly ? 0 : 1)
        finish()
        expect((await work).status).toBe(
          mode === "query"
            ? "not_found"
            : mode === "native_query"
              ? "lookup_unavailable"
              : "ambiguous"
        )
        await reload()
        expect(manager.isOpen("settled-wallet")).toBe(false)
        expect(disconnected).toBe(1)
        expect(submitted).toBe(queryOnly ? 0 : 1)
      } finally {
        finish()
        await work
        await manager.close("settled-wallet")
      }
    }
  )
})
