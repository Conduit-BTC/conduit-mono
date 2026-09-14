import { useEffect, useMemo, useRef } from "react"
import { type PricingRateInput, type Product } from "@conduit/core"
import {
  getProductEventMarketCandidates,
  resolveProductCartFulfillmentFromCatalogs,
  takeEventCatalogProductRefreshObservations,
  type ProductCartFulfillmentResolution,
} from "../lib/event-market-adapter"
import { useEventCatalogs } from "./useEventMarket"

// Shared catalog queries retain staleTime: 0 and refetchOnMount: "always".
// Checkout's explicit freshness verification remains a separate live read.
export function useProductCartFulfillmentBatch(
  products: readonly Product[],
  rateInput: PricingRateInput = null
) {
  const references = useMemo(
    () => [
      ...new Set(
        products.flatMap((product) =>
          getProductEventMarketCandidates(product).map(
            (candidate) => candidate.canonicalNaddr
          )
        )
      ),
    ],
    [products]
  )
  const queries = useEventCatalogs(references, rateInput)
  const refreshedRevisions = useRef(new Set<string>())
  useEffect(() => {
    for (let index = 0; index < references.length; index++) {
      const query = queries[index]
      if (!query?.data || query.isFetching) continue
      const relevantProducts = products.filter((product) =>
        getProductEventMarketCandidates(product).some(
          (candidate) => candidate.canonicalNaddr === references[index]
        )
      )
      const pending = takeEventCatalogProductRefreshObservations(
        relevantProducts,
        query.data,
        query.queryIdentity,
        refreshedRevisions.current
      )
      if (pending.length === 0) continue
      void query.refetch({ cancelRefetch: false })
    }
  }, [products, queries, references])
  const catalogs = new Map(
    references.map((reference, index) => [reference, queries[index]])
  )
  const resolutionsByProductId = new Map<
    string,
    ProductCartFulfillmentResolution
  >()
  for (const product of products) {
    const candidates = getProductEventMarketCandidates(product)
    if (
      candidates.some(
        (candidate) => !catalogs.get(candidate.canonicalNaddr)?.data
      )
    )
      continue
    resolutionsByProductId.set(
      product.id,
      resolveProductCartFulfillmentFromCatalogs(
        product,
        candidates.map((candidate) => ({
          candidate,
          catalog: catalogs.get(candidate.canonicalNaddr)!.data!,
        }))
      )
    )
  }
  return {
    resolutionsByProductId,
    isChecking: queries.some(
      (query) => query.isInitialLoading || query.isHydrating
    ),
  }
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
    isChecking: batch.isChecking,
    candidateNaddr: product
      ? getProductEventMarketCandidates(product)[0]?.canonicalNaddr
      : undefined,
  }
}
