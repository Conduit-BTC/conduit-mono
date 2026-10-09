import {
  isSatsLikeCurrency,
  isSupportedCommercePriceCurrency,
  type CheckoutSparkCommerceQuote,
} from "@conduit/core"
import type { CheckoutSparkQuoteAuthority } from "./checkout-spark-quote-authority"

/**
 * Admit a new quote and keep its exact signed source IDs beside final sats.
 * Recipient allocations and payment endpoints are intentionally resolved later.
 */
export function buildCheckoutSparkCommerceEvidence(
  authority: CheckoutSparkQuoteAuthority
): CheckoutSparkCommerceQuote {
  if (
    authority.lines.length === 0 ||
    authority.lines.length !== authority.pricing.items.length ||
    authority.lines.length !== authority.products.length
  ) {
    throw new Error("Checkout Spark quote evidence is incomplete.")
  }
  const pricedByCoordinate = new Map(
    authority.pricing.items.map((item) => [item.productId, item])
  )
  const productByCoordinate = new Map(
    authority.products.map((product) => [product.id, product])
  )
  if (
    pricedByCoordinate.size !== authority.lines.length ||
    productByCoordinate.size !== authority.lines.length
  ) {
    throw new Error("Checkout Spark quote evidence repeats a product.")
  }
  const lines = authority.lines.map((line) => {
    const priced = pricedByCoordinate.get(line.productCoordinate)
    const product = productByCoordinate.get(line.productCoordinate)
    if (
      !priced ||
      !product ||
      [
        product.currency,
        product.sourcePrice?.currency,
        product.sourcePrice?.normalizedCurrency,
        priced.currency,
        priced.sourcePrice?.currency,
        priced.sourcePrice?.normalizedCurrency,
        priced.sourceShippingCost?.currency,
        priced.sourceShippingCost?.normalizedCurrency,
        priced.shippingPolicyQuote?.currency,
        ...(priced.shippingPolicyQuote?.items.flatMap((quotedItem) => [
          quotedItem.currency,
          ...("shippingHandling" in quotedItem && quotedItem.shippingHandling
            ? [
                quotedItem.shippingHandling.currency,
                quotedItem.shippingHandling.normalizedCurrency,
              ]
            : []),
        ]) ?? []),
      ].some(
        (currency) =>
          currency !== undefined && !isSupportedCommercePriceCurrency(currency)
      ) ||
      product.id !== line.productCoordinate ||
      product.sourceEventId !== line.productEventId ||
      product.pubkey !== line.merchantPubkey ||
      priced.productId !== line.productCoordinate ||
      priced.quantity !== line.quantity ||
      priced.shippingOptionId !== line.shippingOption?.coordinate
    ) {
      throw new Error("Checkout Spark quote lines changed after validation.")
    }
    return {
      ...line,
      unitMerchandiseSats: priced.priceAtPurchase,
      unitShippingSats: priced.shippingCostSats ?? 0,
      ...(priced.sourcePrice &&
      !isSatsLikeCurrency(priced.sourcePrice.normalizedCurrency)
        ? { sourcePrice: structuredClone(priced.sourcePrice) }
        : {}),
      ...(priced.sourceShippingCost &&
      !isSatsLikeCurrency(priced.sourceShippingCost.normalizedCurrency)
        ? { sourceShippingCost: structuredClone(priced.sourceShippingCost) }
        : {}),
      ...(priced.shippingPolicyQuote
        ? {
            shippingPolicy: {
              quote: structuredClone(priced.shippingPolicyQuote),
              allocatedCostSats: priced.shippingAllocatedCostSats!,
            },
          }
        : {}),
      ...(priced.familyProductId !== undefined ||
      priced.selectedSpecifications !== undefined
        ? {
            variation: {
              ...(priced.familyProductId
                ? { familyCoordinate: priced.familyProductId }
                : {}),
              specifications: structuredClone(
                priced.selectedSpecifications ?? []
              ),
            },
          }
        : {}),
    }
  })
  return {
    commerceTotalSats: authority.pricing.totalSats,
    lines,
    ...(authority.pricingAuthority
      ? {
          pricingAuthority: structuredClone(authority.pricingAuthority),
        }
      : {}),
    ...(authority.pricing.quote
      ? {
          pricing: {
            version: 1,
            rate: structuredClone(authority.pricing.quote),
          },
        }
      : {}),
  }
}
