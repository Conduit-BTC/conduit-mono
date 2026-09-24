import type { CheckoutSparkCommerceQuote } from "@conduit/core"
import type { CheckoutSparkQuoteAuthority } from "./checkout-spark-quote-authority"

/**
 * Keep the exact signed source IDs beside the final sat-denominated quote.
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
    }
  })
  return {
    commerceTotalSats: authority.pricing.totalSats,
    lines,
  }
}
