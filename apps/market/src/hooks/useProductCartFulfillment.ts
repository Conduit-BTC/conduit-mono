import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import type { PricingRateInput, Product } from "@conduit/core"
import {
  getProductEventMarketCandidates,
  resolveProductCartFulfillment,
  type ProductCartFulfillmentResolution,
} from "../lib/event-market-adapter"

function rateVersion(rateInput: PricingRateInput): number | null {
  return rateInput && typeof rateInput === "object" ? rateInput.fetchedAt : null
}

function productFulfillmentKey(product: Product): readonly unknown[] {
  return [
    product.id,
    product.updatedAt,
    product.format,
    product.price,
    product.currency,
    product.collectionRefs ?? [],
    product.shippingOptionRefs ?? [],
    product.shippingOptionId ?? null,
  ]
}

function standardResolution(
  product: Product
): ProductCartFulfillmentResolution {
  return {
    status: "standard",
    type: product.format === "digital" ? "digital" : "shipping",
    product,
  }
}

export function useProductCartFulfillment(
  product: Product | null | undefined,
  rateInput: PricingRateInput = null
) {
  const candidates = product ? getProductEventMarketCandidates(product) : []
  const requiresEventResolution = candidates.length > 0
  const query = useQuery({
    queryKey: [
      "product-cart-fulfillment",
      ...(product ? productFulfillmentKey(product) : [null]),
      rateVersion(rateInput),
    ],
    queryFn: () => resolveProductCartFulfillment(product!, rateInput),
    enabled: !!product && requiresEventResolution,
    staleTime: 0,
    refetchOnMount: "always",
    retry: false,
  })

  return {
    resolution:
      query.data ??
      (product && !requiresEventResolution
        ? standardResolution(product)
        : null),
    isChecking:
      requiresEventResolution && (query.isLoading || query.isFetching),
    candidateNaddr: candidates[0]?.canonicalNaddr,
  }
}

export function useProductCartFulfillmentBatch(
  products: readonly Product[],
  rateInput: PricingRateInput = null
) {
  const candidateProducts = products.filter(
    (product) => getProductEventMarketCandidates(product).length > 0
  )
  const query = useQuery({
    queryKey: [
      "product-cart-fulfillment-batch",
      candidateProducts.map(productFulfillmentKey),
      rateVersion(rateInput),
    ],
    queryFn: async () => {
      const resolutions = await Promise.all(
        candidateProducts.map((product) =>
          resolveProductCartFulfillment(product, rateInput)
        )
      )
      return resolutions
    },
    enabled: candidateProducts.length > 0,
    staleTime: 0,
    refetchOnMount: "always",
    retry: false,
  })
  const resolutionsByProductId = useMemo(() => {
    const result = new Map<string, ProductCartFulfillmentResolution>()
    const candidateProductIds = new Set(
      candidateProducts.map((product) => product.id)
    )
    for (const product of products) {
      if (!candidateProductIds.has(product.id)) {
        result.set(product.id, standardResolution(product))
      }
    }
    for (const resolution of query.data ?? []) {
      result.set(resolution.product.id, resolution)
    }
    return result
  }, [candidateProducts, products, query.data])

  return {
    resolutionsByProductId,
    isChecking:
      candidateProducts.length > 0 && (query.isLoading || query.isFetching),
  }
}
