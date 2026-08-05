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

export async function finalizeCommittedWalletMutation(input: {
  notifyChanged(): void
  reload(): Promise<void>
}): Promise<"refreshed" | "refresh_failed"> {
  let notificationFailed = false
  try {
    input.notifyChanged()
  } catch {
    notificationFailed = true
  }

  try {
    await input.reload()
    return notificationFailed ? "refresh_failed" : "refreshed"
  } catch {
    return "refresh_failed"
  }
}
