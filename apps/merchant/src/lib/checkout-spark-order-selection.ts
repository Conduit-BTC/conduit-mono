import {
  getOrderConversationId,
  type MerchantCheckoutSparkRecoveryCandidate,
  type MerchantCheckoutSparkRecoveryDiscoveryResult,
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

type MerchantCheckoutSparkDiscoverySelection = {
  orderKey: string | null
  selectionKey: string | null
}

/**
 * Keep selected-order consent through ordinary pagination after Continue opens
 * a fresh scan. This retains only a UI identity, never a recovery candidate or
 * payment authority. The worker must receive only the current page candidates.
 */
export function resolveMerchantCheckoutSparkDiscoverySelection(input: {
  selected: MerchantCheckoutSparkSelectedOrder | null | undefined
  page: MerchantCheckoutSparkRecoveryDiscoveryResult | null
  previous: MerchantCheckoutSparkDiscoverySelection | null
}): MerchantCheckoutSparkDiscoverySelection {
  const orderKey = getMerchantCheckoutSparkOrderSelectionKey(input.selected)
  if (!orderKey) return { orderKey: null, selectionKey: null }
  if (
    input.page &&
    (input.page.conflictCount > 0 || input.page.history.retentionLimitReached)
  ) {
    return { orderKey, selectionKey: orderKey }
  }
  const current = selectMerchantCheckoutSparkOrderRecovery(
    input.selected,
    input.page?.candidates.filter(
      (candidate) => candidate.schemaVersion !== 1
    ) ?? []
  ).candidate
  if (current) {
    return {
      orderKey,
      selectionKey: getMerchantCheckoutSparkCandidateSelectionKey(
        input.selected,
        current
      ),
    }
  }
  if (
    input.previous?.orderKey === orderKey &&
    input.page?.candidates.length === 0 &&
    input.page.history.hasMore &&
    !input.page.history.retentionLimitReached &&
    input.page.conflictCount === 0
  ) {
    return input.previous
  }
  // Conclusive absence, conflicting/capped discovery, or another selection
  // cannot preserve an earlier exact-plan consent.
  return { orderKey, selectionKey: orderKey }
}
