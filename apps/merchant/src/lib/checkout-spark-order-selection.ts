import {
  getOrderConversationId,
  type MerchantCheckoutSparkRecoveryCandidate,
  type MerchantConversationSummary,
} from "@conduit/core"

export type MerchantCheckoutSparkSelectedOrder = Pick<
  MerchantConversationSummary,
  "orderId" | "buyerPubkey" | "merchantPubkey"
>

const HEX_64 = /^[0-9a-f]{64}$/
const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  value.trim() === value

/** Presentation/consent identity only; never substitutes for provider authority. */
export function getMerchantCheckoutSparkOrderSelectionKey(
  selected: MerchantCheckoutSparkSelectedOrder | null | undefined
): string | null {
  return selected &&
    HEX_64.test(selected.merchantPubkey) &&
    HEX_64.test(selected.buyerPubkey) &&
    validId(selected.orderId)
    ? getOrderConversationId(selected)
    : null
}

/** Match the selected participant tuple before exposing any recovery action. */
export function getMerchantCheckoutSparkCandidateSelectionKey(
  selected: MerchantCheckoutSparkSelectedOrder | null | undefined,
  candidate: MerchantCheckoutSparkRecoveryCandidate
): string | null {
  const conversationKey = getMerchantCheckoutSparkOrderSelectionKey(selected)
  if (
    !conversationKey ||
    !selected ||
    candidate.initialBuyerPubkey !== selected.buyerPubkey ||
    candidate.orderId !== selected.orderId ||
    !validId(candidate.checkoutId) ||
    !HEX_64.test(candidate.planDigest)
  )
    return null
  return JSON.stringify([
    conversationKey,
    candidate.checkoutId,
    candidate.planDigest,
  ])
}

export function selectMerchantCheckoutSparkOrderRecovery(
  selected: MerchantCheckoutSparkSelectedOrder | null | undefined,
  candidates: readonly MerchantCheckoutSparkRecoveryCandidate[]
): {
  candidate: MerchantCheckoutSparkRecoveryCandidate | null
  matchingCount: number
} {
  const matching = candidates.filter((candidate) =>
    getMerchantCheckoutSparkCandidateSelectionKey(selected, candidate)
  )
  return {
    candidate: matching.length === 1 ? matching[0]! : null,
    matchingCount: matching.length,
  }
}
