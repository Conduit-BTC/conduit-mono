import {
  DexieCheckoutSparkSettledRepository,
  type CheckoutSparkSettledRepositorySnapshot,
} from "@conduit/core"

import {
  listCheckoutSparkSettledPreparations,
  type CheckoutSparkSettledPreparationStorage,
  type StoredCheckoutSparkSettledPreparation,
} from "./checkout-spark-settled-preparation"
import { acquireCheckoutSparkWalletRetentionLock } from "./checkout-spark-wallet-retention-lock"
import type { SparkWalletManager } from "./spark-wallet"

export async function closeUnusedSparkWallets(
  manager: Pick<SparkWalletManager, "closeWalletsExcept">,
  registeredWalletIds: Iterable<string>,
  options: {
    now?: number
    storage?: CheckoutSparkSettledPreparationStorage | null
    listSettledPreparations?: () => StoredCheckoutSparkSettledPreparation[]
    loadSettledSnapshot?: (
      checkoutId: string,
      planDigest: string
    ) => Promise<CheckoutSparkSettledRepositorySnapshot>
  } = {}
): Promise<void> {
  const releaseRetentionLock = await acquireCheckoutSparkWalletRetentionLock()
  try {
    await closeUnusedSparkWalletsUnlocked(manager, registeredWalletIds, options)
  } finally {
    releaseRetentionLock()
  }
}

async function closeUnusedSparkWalletsUnlocked(
  manager: Pick<SparkWalletManager, "closeWalletsExcept">,
  registeredWalletIds: Iterable<string>,
  options: {
    now?: number
    storage?: CheckoutSparkSettledPreparationStorage | null
    listSettledPreparations?: () => StoredCheckoutSparkSettledPreparation[]
    loadSettledSnapshot?: (
      checkoutId: string,
      planDigest: string
    ) => Promise<CheckoutSparkSettledRepositorySnapshot>
  }
): Promise<void> {
  const keep = new Set(registeredWalletIds)
  const now = options.now ?? Date.now()
  const settledWalletIds = new Set<string>()
  if (!Number.isSafeInteger(now) || now < 0) {
    // An invalid clock cannot establish that an ephemeral wallet is unused.
    return
  }
  try {
    const settledPreparations =
      options.listSettledPreparations?.() ??
      listCheckoutSparkSettledPreparations(options.storage)
    const settledRepository = new DexieCheckoutSparkSettledRepository()
    for (const preparation of settledPreparations) {
      const snapshot = await (
        options.loadSettledSnapshot ??
        ((checkoutId, planDigest) =>
          settledRepository.load(checkoutId, planDigest))
      )(preparation.checkoutId, preparation.planDigest)
      if (snapshot.status === "retired") continue
      if (snapshot.status !== "active") return
      const { plan } = snapshot.state
      if (
        plan.checkoutId !== preparation.checkoutId ||
        plan.planDigest !== preparation.planDigest
      ) {
        return
      }
      if (now < plan.takeoverAt) settledWalletIds.add(plan.walletId)
    }
  } catch {
    // An unreadable settled preparation/reconciliation is not proof
    // that an open router wallet is unused. Keep all open wallets for now;
    // the registered-wallet refresh can still proceed.
    return
  }
  for (const walletId of settledWalletIds) keep.add(walletId)
  await manager.closeWalletsExcept(keep)
}
