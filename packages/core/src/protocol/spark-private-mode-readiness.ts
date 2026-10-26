/**
 * The minimum Spark surface needed to establish private-mode readiness.
 * SDK initialization and cleanup remain with the caller.
 */
export interface SparkPrivateModeWallet {
  setPrivacyEnabled(enabled: boolean): Promise<unknown>
  getWalletSettings(): Promise<{ privateEnabled: boolean } | undefined>
  getSparkAddress(): Promise<string>
}

export interface SparkPrivateModePublicReader {
  getAvailableBalance(sparkAddress: string): Promise<bigint>
  getOwnedBalance(sparkAddress: string): Promise<bigint>
  getTransfers(input: {
    sparkAddress: string
    limit?: number
    offset?: number
  }): Promise<{ transfers: readonly unknown[] }>
}

export interface SparkPrivateModeReadinessInput {
  wallet: SparkPrivateModeWallet
  createPublicReader: () => SparkPrivateModePublicReader
  convergenceTimeoutMs: number
  readTimeoutMs: number
  observationIntervalMs: number
  requiredConsecutiveObservations: number
  readWithTimeout: <T>(
    read: Promise<T>,
    timeoutMs: number,
    label: string
  ) => Promise<T>
  wait: (milliseconds: number) => Promise<void>
  now: () => number
}

/**
 * Require private-mode confirmation and repeated public invisibility before
 * exposing a Spark wallet to its owner or accepting funding for it.
 */
export async function ensureSparkPrivateModeReady(
  input: SparkPrivateModeReadinessInput
): Promise<void> {
  await input.wallet.setPrivacyEnabled(true)
  const settings = await input.wallet.getWalletSettings()
  if (settings?.privateEnabled !== true) {
    throw new Error("Spark private mode could not be verified.")
  }

  const sparkAddress = await input.wallet.getSparkAddress()
  const publicReader = input.createPublicReader()
  const deadline = input.now() + input.convergenceTimeoutMs
  let consecutiveHiddenObservations = 0

  /*
   * Zero/empty public reads cannot cryptographically prove privacy for a
   * brand-new wallet with no balance or history. Requiring multiple spaced
   * observations still gives the provider setting time to converge before
   * Conduit exposes the address for display or funding. Restored wallets with
   * funds or history positively verify that those public records become hidden.
   */
  while (input.now() < deadline) {
    const remainingMs = deadline - input.now()
    const readTimeoutMs = Math.min(input.readTimeoutMs, remainingMs)

    try {
      const [availableBalance, ownedBalance, history] = await Promise.all([
        input.readWithTimeout(
          publicReader.getAvailableBalance(sparkAddress),
          readTimeoutMs,
          "Spark public available-balance read"
        ),
        input.readWithTimeout(
          publicReader.getOwnedBalance(sparkAddress),
          readTimeoutMs,
          "Spark public owned-balance read"
        ),
        input.readWithTimeout(
          publicReader.getTransfers({
            sparkAddress,
            limit: 1,
            offset: 0,
          }),
          readTimeoutMs,
          "Spark public transfer-history read"
        ),
      ])
      const isHidden =
        availableBalance === 0n &&
        ownedBalance === 0n &&
        history.transfers.length === 0
      consecutiveHiddenObservations = isHidden
        ? consecutiveHiddenObservations + 1
        : 0
      if (
        consecutiveHiddenObservations >= input.requiredConsecutiveObservations
      ) {
        return
      }
    } catch {
      consecutiveHiddenObservations = 0
    }

    const remainingAfterReadMs = deadline - input.now()
    if (remainingAfterReadMs <= 0) break
    await input.wait(
      Math.min(input.observationIntervalMs, remainingAfterReadMs)
    )
  }

  throw new Error(
    "Spark private mode could not be confirmed before the readiness deadline."
  )
}
