/**
 * Preparation writes one shared localStorage record and creates a new wallet,
 * invoice, and order. Serialize the whole read-to-publish operation across
 * tabs, including unrelated checkouts that would otherwise race that record.
 */
export interface CheckoutSparkRouterPreparationLockManager {
  request<T>(
    name: string,
    options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: { name: string } | null) => T | Promise<T>
  ): Promise<T>
}

// Keep the original preparation lock name: every router preparation already
// holds it while mutating this single shared localStorage record.
const STORE_LOCK_NAME = "conduit:checkout-spark-router-preparation"

function browserPreparationLockManager(): CheckoutSparkRouterPreparationLockManager | null {
  if (typeof navigator === "undefined" || !navigator.locks) return null
  return navigator.locks as unknown as CheckoutSparkRouterPreparationLockManager
}

async function runWithStoreLock<T>(
  operation: () => Promise<T>,
  lockManager: CheckoutSparkRouterPreparationLockManager | null,
  requireCrossTabLock: boolean,
  unavailableMessage: string,
  busyMessage: string
): Promise<T> {
  if (!lockManager) {
    if (requireCrossTabLock) throw new Error(unavailableMessage)
    return operation()
  }
  return lockManager.request(
    STORE_LOCK_NAME,
    { mode: "exclusive", ifAvailable: true },
    async (lock) => {
      if (!lock) throw new Error(busyMessage)
      return operation()
    }
  )
}

/**
 * Serialize a funding-progress read/modify/write with preparation writes.
 * Preparation already holds this lock for its full operation; do not nest it.
 */
export function withCheckoutSparkRouterStoreWriteLock<T>(
  operation: () => Promise<T>,
  lockManager: CheckoutSparkRouterPreparationLockManager | null = browserPreparationLockManager(),
  requireCrossTabLock = typeof window !== "undefined"
): Promise<T> {
  return runWithStoreLock(
    operation,
    lockManager,
    requireCrossTabLock,
    "This browser cannot safely coordinate checkout router storage across tabs.",
    "Checkout router storage is active in another tab."
  )
}

export function withCheckoutSparkRouterPreparationLock<T>(
  assertNoExistingPreparation: () => void | Promise<void>,
  operation: () => Promise<T>,
  lockManager: CheckoutSparkRouterPreparationLockManager | null = browserPreparationLockManager()
): Promise<T> {
  return runWithStoreLock(
    async () => {
      await assertNoExistingPreparation()
      return operation()
    },
    lockManager,
    true,
    "This browser cannot safely coordinate checkout preparation across tabs.",
    "Checkout preparation is already active in another tab."
  )
}
