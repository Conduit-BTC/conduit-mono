import {
  fetchLnurlPayMetadata,
  isValidLud16Address,
  normalizeSafeLnurlPayRequestUrl,
} from "./lightning"

export interface CheckoutSparkLnurlPayoutMetadataInput {
  /** Destination already authorized by the frozen signed payment profile. */
  lud16: string
  /** A proven ceiling, not a prediction or promise of the settled allocation. */
  maximumAllocationSats: number
  shouldContinue: () => boolean
}

/**
 * Reject an unavailable endpoint or an obviously impossible whole-sat range
 * before funding. This observation is not payment authority: metadata cannot
 * prove invoice network, future availability, settled credit, or send fees.
 * No invoice is requested and no public-zap capability is required.
 */
export async function assertCheckoutSparkLnurlPayoutMetadata(
  input: CheckoutSparkLnurlPayoutMetadataInput,
  dependencies: { fetchMetadata?: typeof fetchLnurlPayMetadata } = {}
): Promise<void> {
  const { maximumAllocationSats, shouldContinue } = input
  const lud16 = input.lud16.trim()
  const assertCurrent = () => {
    if (!shouldContinue()) {
      throw new Error("Checkout Spark payout authority changed.")
    }
  }
  assertCurrent()
  if (
    !isValidLud16Address(lud16) ||
    !Number.isSafeInteger(maximumAllocationSats) ||
    maximumAllocationSats <= 1
  ) {
    throw new Error("Checkout Spark recipient payment terms are unavailable.")
  }

  let metadata: Awaited<ReturnType<typeof fetchLnurlPayMetadata>>
  try {
    metadata = await (dependencies.fetchMetadata ?? fetchLnurlPayMetadata)(
      lud16
    )
  } catch {
    assertCurrent()
    // The transport's error may contain the recipient address or callback.
    throw new Error("Checkout Spark recipient payment endpoint is unavailable.")
  }
  assertCurrent()
  if (
    metadata.tag !== "payRequest" ||
    !normalizeSafeLnurlPayRequestUrl(metadata.callback) ||
    !Number.isSafeInteger(metadata.minSendable) ||
    !Number.isSafeInteger(metadata.maxSendable) ||
    metadata.minSendable <= 0 ||
    metadata.maxSendable < metadata.minSendable
  ) {
    throw new Error("Checkout Spark recipient payment metadata is invalid.")
  }

  const minimumSats = (BigInt(metadata.minSendable) + 999n) / 1_000n
  const maximumSats = BigInt(metadata.maxSendable) / 1_000n
  // The current executor needs positive room for that leg's own send fees.
  // A smaller actual allocation is still validated after funding settles.
  const invoiceCeiling = BigInt(maximumAllocationSats) - 1n
  if (minimumSats > maximumSats || minimumSats > invoiceCeiling) {
    throw new Error(
      "Checkout Spark recipient has no usable whole-sat payment range."
    )
  }
}
