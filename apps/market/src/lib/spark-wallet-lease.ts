export interface SparkWalletSessionLease {
  release(): Promise<void>
}

export interface SparkWalletSessionLockManager {
  request<T>(
    name: string,
    options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: { name: string } | null) => T | Promise<T>
  ): Promise<T>
}

export interface SparkWalletOperationLockManager {
  request<T>(
    name: string,
    options: { mode: "exclusive" },
    callback: (lock: { name: string } | null) => T | Promise<T>
  ): Promise<T>
}

export class SparkWalletSessionLeaseUnavailableError extends Error {
  constructor(
    message = "This Portable Wallet is open in another tab. Close that tab, then try again."
  ) {
    super(message)
    this.name = "SparkWalletSessionLeaseUnavailableError"
  }
}

const NOOP_LEASE: SparkWalletSessionLease = {
  async release() {},
}

export async function acquireSparkWalletManagerSessionLease(
  walletId: string,
  identityKey: string,
  lockManager: SparkWalletSessionLockManager | null = getBrowserLockManager(),
  requireCrossTabLock = typeof window !== "undefined"
): Promise<SparkWalletSessionLease> {
  const registrationLease = await acquireSparkWalletSessionLease(
    `registration:${walletId}`,
    lockManager,
    requireCrossTabLock
  )
  try {
    const identityLease = await acquireSparkWalletSessionLease(
      `identity:${identityKey}`,
      lockManager,
      requireCrossTabLock
    )
    return {
      async release() {
        const results = await Promise.allSettled([
          identityLease.release(),
          registrationLease.release(),
        ])
        const errors = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : []
        )
        if (errors.length === 1) throw errors[0]
        if (errors.length > 1) {
          throw new AggregateError(
            errors,
            "Portable Wallet session locks could not be released."
          )
        }
      },
    }
  } catch (error) {
    try {
      await registrationLease.release()
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        "Portable Wallet identity lock failed and its registration lock could not be released.",
        { cause: releaseError }
      )
    }
    throw error
  }
}

export async function assertSparkWalletRegistrationSessionAvailable(
  walletId: string,
  lockManager: SparkWalletSessionLockManager | null = getBrowserLockManager(),
  requireCrossTabLock = typeof window !== "undefined"
): Promise<void> {
  const lease = await acquireSparkWalletSessionLease(
    `registration:${walletId}`,
    lockManager,
    requireCrossTabLock
  )
  await lease.release()
}

export async function runWithSparkWalletOperationLock<T>(
  walletId: string,
  operation: () => Promise<T>,
  lockManager: SparkWalletOperationLockManager | null = getBrowserWalletOperationLockManager(),
  requireCrossTabLock = typeof window !== "undefined"
): Promise<T> {
  if (!lockManager) {
    if (requireCrossTabLock) {
      throw new SparkWalletSessionLeaseUnavailableError(
        "This browser cannot safely coordinate Portable Wallet operations across tabs."
      )
    }
    return operation()
  }

  return lockManager.request(
    `conduit:spark-wallet-operation:${walletId}`,
    { mode: "exclusive" },
    async (lock) => {
      if (!lock) {
        throw new SparkWalletSessionLeaseUnavailableError(
          "Could not safely coordinate this Portable Wallet operation."
        )
      }
      return operation()
    }
  )
}

export async function acquireSparkWalletSessionLease(
  sessionKey: string,
  lockManager: SparkWalletSessionLockManager | null = getBrowserLockManager(),
  requireCrossTabLock = typeof window !== "undefined"
): Promise<SparkWalletSessionLease> {
  if (!lockManager) {
    if (requireCrossTabLock) {
      throw new SparkWalletSessionLeaseUnavailableError(
        "This browser cannot safely coordinate Portable Wallet sessions across tabs."
      )
    }
    return NOOP_LEASE
  }

  let resolveGrant: (lease: SparkWalletSessionLease) => void = () => undefined
  let rejectGrant: (error: unknown) => void = () => undefined
  let grantSettled = false
  const grant = new Promise<SparkWalletSessionLease>((resolve, reject) => {
    resolveGrant = resolve
    rejectGrant = reject
  })
  const resolveOnce = (lease: SparkWalletSessionLease) => {
    if (!grantSettled) {
      grantSettled = true
      resolveGrant(lease)
    }
  }
  const rejectOnce = (error: unknown) => {
    if (!grantSettled) {
      grantSettled = true
      rejectGrant(error)
    }
  }

  let completion: Promise<void> = Promise.resolve()
  let completionError: unknown
  try {
    const request = lockManager.request(
      getSparkWalletSessionLockName(sessionKey),
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (!lock) {
          rejectOnce(new SparkWalletSessionLeaseUnavailableError())
          return
        }

        let releaseHold: () => void = () => undefined
        let released = false
        const hold = new Promise<void>((resolve) => {
          releaseHold = resolve
        })
        resolveOnce({
          async release() {
            if (!released) {
              released = true
              releaseHold()
            }
            await completion
            if (completionError) {
              throw completionError
            }
          },
        })
        await hold
      }
    )
    completion = request.then(
      () => undefined,
      (error: unknown) => {
        completionError = error
        rejectOnce(error)
      }
    )
  } catch (error) {
    completionError = error
    rejectOnce(error)
  }

  return grant
}

function getSparkWalletSessionLockName(sessionKey: string): string {
  return `conduit:spark-wallet-session:${sessionKey}`
}

function getBrowserLockManager(): SparkWalletSessionLockManager | null {
  if (
    typeof navigator === "undefined" ||
    !("locks" in navigator) ||
    !navigator.locks
  ) {
    return null
  }
  return navigator.locks as unknown as SparkWalletSessionLockManager
}

function getBrowserWalletOperationLockManager(): SparkWalletOperationLockManager | null {
  if (
    typeof navigator === "undefined" ||
    !("locks" in navigator) ||
    !navigator.locks
  ) {
    return null
  }
  return navigator.locks as unknown as SparkWalletOperationLockManager
}
