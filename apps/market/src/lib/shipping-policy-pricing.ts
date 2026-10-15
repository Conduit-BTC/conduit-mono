import {
  allocateCheckoutSparkShippingPolicySats,
  hasSameShippingPolicyQuote,
} from "@conduit/core"
import type { CartItem } from "./cart-model"

function handlingFingerprint(value: CartItem["shippingHandling"]): string {
  return JSON.stringify(
    value ? [value.amount, value.currency, value.normalizedCurrency] : null
  )
}

/** Convert once per compatible signed policy revision, then apportion whole sats. */
export function allocateShippingPolicyCosts(
  items: readonly CartItem[]
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
      item.fulfillment?.type === "event_market_pickup"
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
              input.weightGrams === item.shippingWeightGrams &&
              (quote.version !== 2 ||
                ((("shippingWeightAllowanceGrams" in input
                  ? input.shippingWeightAllowanceGrams
                  : undefined) ?? 0) ===
                  (item.shippingWeightAllowanceGrams ?? 0) &&
                  handlingFingerprint(
                    ("shippingHandling" in input
                      ? input.shippingHandling
                      : undefined) as CartItem["shippingHandling"]
                  ) === handlingFingerprint(item.shippingHandling)))
          )
      )
    )
      continue
    // Converted quotes retain the exact settlement amount.
    // A later display-rate refresh must not reinterpret its agreed result.
    try {
      const allocations = allocateCheckoutSparkShippingPolicySats(quote)
      for (const item of group)
        item.shippingAllocatedCostSats = allocations.get(item.productId)
    } catch {
      continue
    }
  }
  return result
}
