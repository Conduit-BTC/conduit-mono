import type { WalletDescriptor, WalletProviderId } from "@conduit/core"

/**
 * Deduplicates wallet storage initialization across hook consumers while still
 * allowing a failed migration/open to be retried.
 */
export const WALLET_STORAGE_INITIALIZATION_ERROR =
  "Wallet storage could not be initialized on this device."

export const WALLET_STORAGE_SYNCHRONIZATION_ERROR =
  "Wallet changes were saved, but wallet views could not be synchronized. Retry to refresh this device before making another change."

export function reconcileWalletSynchronizationError(
  current: string | null,
  outcome: "succeeded" | "failed"
): string | null {
  if (current === WALLET_STORAGE_INITIALIZATION_ERROR) {
    return current
  }
  if (outcome === "failed") {
    return WALLET_STORAGE_SYNCHRONIZATION_ERROR
  }
  return current === WALLET_STORAGE_SYNCHRONIZATION_ERROR ? null : current
}

export class WalletInitializationCoordinator {
  #inFlight: Promise<void> | null = null

  run(operation: () => Promise<void>): Promise<void> {
    if (this.#inFlight) return this.#inFlight
    const current = operation()
    this.#inFlight = current
    void current.catch(() => {
      if (this.#inFlight === current) {
        this.#inFlight = null
      }
    })
    return current
  }
}

/**
 * Allows overlapping reload reads while making the newest request the sole
 * authority allowed to commit state.
 */
export class LatestWalletReloadCoordinator {
  #generation = 0
  #latestCompletion: Promise<"committed" | "superseded"> | null = null

  run<T>(
    load: () => Promise<T>,
    commit: (value: T) => void
  ): Promise<"committed" | "superseded"> {
    const generation = ++this.#generation
    const completion = this.#run(generation, load, commit)
    this.#latestCompletion = completion
    return completion
  }

  async waitForLatest(): Promise<void> {
    while (this.#latestCompletion) {
      const latestCompletion = this.#latestCompletion
      try {
        await latestCompletion
      } catch (error) {
        if (latestCompletion !== this.#latestCompletion) {
          continue
        }
        throw error
      }
      if (latestCompletion === this.#latestCompletion) {
        return
      }
    }
  }

  async #run<T>(
    generation: number,
    load: () => Promise<T>,
    commit: (value: T) => void
  ): Promise<"committed" | "superseded"> {
    let value: T
    try {
      value = await load()
    } catch (error) {
      if (generation !== this.#generation) return "superseded"
      throw error
    }
    if (generation !== this.#generation) return "superseded"
    commit(value)
    return "committed"
  }
}

export class WalletDescriptorSubscriptionCoordinator {
  #generation = 0
  #terminal = false

  start(): number {
    this.#generation += 1
    this.#terminal = false
    return this.#generation
  }

  markFailed(generation: number): boolean {
    if (generation !== this.#generation) return false
    this.#terminal = true
    return true
  }

  accepts(generation: number, outcome: "succeeded" | "failed"): boolean {
    return (
      generation === this.#generation &&
      (outcome === "failed" || !this.#terminal)
    )
  }

  acceptsCurrent(outcome: "succeeded" | "failed"): boolean {
    return outcome === "failed" || !this.#terminal
  }
}

export function getRemovedWalletIdsForProvider(
  previousWallets: readonly WalletDescriptor[],
  nextWallets: readonly WalletDescriptor[],
  providerId: WalletProviderId
): string[] {
  return previousWallets
    .filter(
      (wallet) =>
        wallet.providerId === providerId &&
        !nextWallets.some(
          (candidate) =>
            candidate.id === wallet.id &&
            candidate.providerId === wallet.providerId
        )
    )
    .map((wallet) => wallet.id)
}
