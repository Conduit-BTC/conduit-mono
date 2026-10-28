import {
  DexieCheckoutSparkSettledRepository,
  type CheckoutSparkSettledRepositorySnapshot,
} from "../protocol/checkout-spark-settled-router-repository"

import {
  listCheckoutSparkSettledPreparations,
  type CheckoutSparkSettledPreparationStorage,
  type StoredCheckoutSparkSettledPreparation,
} from "./checkout-spark-settled-preparation-storage"
import { acquireCheckoutSparkWalletRetentionLock } from "./checkout-spark-wallet-retention-lock"
import type { SparkWalletManager } from "./spark-wallet"
import { getCheckoutSparkBuyerTakeoverAt } from "../protocol/checkout-spark-buyer-activation"

export async function closeUnusedSparkWallets(
  manager: Pick<SparkWalletManager, "closeWalletsExcept">,
  registeredWalletIds: Iterable<string>,
  options: {
    now?: number
    shouldContinue?: () => boolean
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
    shouldContinue?: () => boolean
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
      const takeoverAt = getCheckoutSparkBuyerTakeoverAt(
        plan,
        snapshot.state.buyerActivation
      )
      if (
        plan.checkoutId !== preparation.checkoutId ||
        plan.planDigest !== preparation.planDigest
      ) {
        return
      }
      if (
        (takeoverAt !== null &&
          (!Number.isSafeInteger(takeoverAt) || takeoverAt < 0)) ||
        !Number.isSafeInteger(plan.funding.expiresAt) ||
        plan.funding.expiresAt < 0
      ) {
        return
      }
      // Keeping this RAM credential grants no outgoing authority. New dispatch
      // still ends at takeover, while the same exact invoice and admitted
      // attempts remain inspectable through their original bounded lifetime.
      // Historical plans retain their longer saved takeover where applicable.
      if (now < Math.max(takeoverAt ?? 0, plan.funding.expiresAt)) {
        settledWalletIds.add(plan.walletId)
      }
    }
  } catch {
    // An unreadable settled preparation/reconciliation is not proof
    // that an open router wallet is unused. Keep all open wallets for now;
    // the registered-wallet refresh can still proceed.
    return
  }
  for (const walletId of settledWalletIds) keep.add(walletId)
  // Retention locks and history reads may outlive the caller's reload/session.
  // Recheck that lifetime at the actual cleanup dispatch, not before awaiting.
  if (options.shouldContinue && !options.shouldContinue()) return
  await manager.closeWalletsExcept(keep)
}
