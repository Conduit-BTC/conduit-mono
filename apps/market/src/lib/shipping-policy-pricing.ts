import {
  normalizeCommercePrice,
  hasSameShippingPolicyQuote,
  shippingMinorToAmount,
  type PricingRateInput,
} from "@conduit/core"
import type { CartItem } from "./cart-model"

/** Convert once per compatible signed policy revision, then apportion whole sats. */
export function allocateShippingPolicyCosts(
  items: readonly CartItem[],
  rateInput: PricingRateInput
): CartItem[] {
  const result = items.map((item) => ({
    ...item,
    shippingAllocatedCostSats: undefined as number | undefined,
  }))
  const groups = new Map<string, CartItem[]>()
  for (const item of result) {
    const quote = item.shippingPolicyQuote
    if (
      !quote ||
      item.format === "digital" ||
      item.fulfillment?.type === "pickup"
    )
      continue
    const key = `${item.merchantPubkey}:${quote.policyCoordinate}:${quote.policyEventId}`
    const group = groups.get(key) ?? []
    group.push(item)
    groups.set(key, group)
  }
  for (const group of groups.values()) {
    const quote = group[0]!.shippingPolicyQuote!
    if (
      group.some(
        (item) =>
          !item.shippingPolicyQuote ||
          !hasSameShippingPolicyQuote(item.shippingPolicyQuote, quote)
      ) ||
      quote.items.length !== group.length ||
      group.some(
        (item) =>
          !quote.items.some(
            (input) =>
              input.productId === item.productId &&
              input.quantity === item.quantity &&
              input.productEventId === item.productEventId &&
              input.weightGrams === item.shippingWeightGrams
          )
      )
    )
      continue
    const normalized = normalizeCommercePrice(
      shippingMinorToAmount(quote.amountMinor, quote.currency),
      quote.currency,
      rateInput,
      { allowZero: true }
    )
    if (normalized.status !== "ok") continue
    const quantity = group.reduce((sum, item) => sum + item.quantity, 0)
    if (!Number.isSafeInteger(quantity) || quantity <= 0) continue
    const ordered = [...group].sort((a, b) =>
      a.productId.localeCompare(b.productId)
    )
    let allocated = 0
    for (const item of ordered) {
      item.shippingAllocatedCostSats = Number(
        (BigInt(normalized.sats) * BigInt(item.quantity)) / BigInt(quantity)
      )
      allocated += item.shippingAllocatedCostSats
    }
    let remaining = normalized.sats - allocated
    for (const item of ordered) {
      if (remaining-- <= 0) break
      item.shippingAllocatedCostSats! += 1
    }
  }
  return result
}
