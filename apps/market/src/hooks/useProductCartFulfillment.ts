import { useMemo } from "react"
import { type PricingRateInput, type Product } from "@conduit/core"
import {
  resolveProductCartFulfillment,
  type ProductCartFulfillmentResolution,
} from "../lib/product-cart-fulfillment"

/** Ordinary shop fulfillment. Event pickup is explicitly selected and verified on the event surface. */
export function useProductCartFulfillmentBatch(
  products: readonly Product[],
  _rateInput: PricingRateInput = null
) {
  void _rateInput
  const resolutionsByProductId = useMemo(
    () =>
      new Map<string, ProductCartFulfillmentResolution>(
        products.map((product) => [
          product.id,
          resolveProductCartFulfillment(product),
        ])
      ),
    [products]
  )
  return { resolutionsByProductId, isChecking: false }
}

export function useProductCartFulfillment(
  product: Product | null | undefined,
  rateInput: PricingRateInput = null
) {
  const products = useMemo(() => (product ? [product] : []), [product])
  const batch = useProductCartFulfillmentBatch(products, rateInput)
  return {
    resolution: product
      ? (batch.resolutionsByProductId.get(product.id) ?? null)
      : null,
    isChecking: false,
    candidateNaddr: undefined,
  }
}
