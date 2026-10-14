import type { CartPurchaseClaim } from "./cart-repository"
import type { StoredCheckoutSparkSettledPreparation } from "./checkout-spark-settled-preparation"

const LEGACY_PREPARATION_WINDOW_MS = 45 * 60_000

/**
 * The cart batch identities distinguish an intentional second purchase of the
 * same product from a second invoice for the original cart. Only the digest is
 * persisted; neither product details nor the raw cart identifiers are stored.
 */
export async function createCheckoutSparkPurchaseClaimDigest(
  claim: Pick<CartPurchaseClaim, "allocations">
): Promise<string> {
  if (!globalThis.crypto?.subtle || claim.allocations.length === 0) {
    throw new Error("The checkout purchase cannot be safely identified.")
  }
  const canonical = claim.allocations
    .map((allocation) => {
      if (!allocation.lineId || allocation.batches.length === 0) {
        throw new Error("The checkout purchase cannot be safely identified.")
      }
      const batches = allocation.batches.map((batch) => {
        if (!batch.id) {
          throw new Error("The checkout purchase cannot be safely identified.")
        }
        return batch.id
      })
      return [allocation.lineId, batches.sort()] as const
    })
    .sort((left, right) => left[0].localeCompare(right[0]))
  const encoded = new TextEncoder().encode(
    JSON.stringify(["conduit-router-cart-batches-v1", canonical])
  )
  const hash = await globalThis.crypto.subtle.digest(
    "SHA-256",
    encoded.slice().buffer as ArrayBuffer
  )
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}

/** Old preparations did not bind a cart claim, so retain their original guard. */
export function findBlockingCheckoutSparkPreparation(
  preparations: readonly StoredCheckoutSparkSettledPreparation[],
  purchaseClaimDigest: string,
  nowMs: number
): boolean {
  if (
    !/^[0-9a-f]{64}$/.test(purchaseClaimDigest) ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0
  ) {
    return true
  }
  return preparations.some((saved) =>
    saved.purchaseClaimDigest
      ? saved.purchaseClaimDigest === purchaseClaimDigest
      : nowMs < saved.savedAt + LEGACY_PREPARATION_WINDOW_MS
  )
}
