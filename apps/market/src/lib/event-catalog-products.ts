import {
  getProductsByIds,
  getCachedProductsByIds,
  type ProductsByIdsResult,
} from "@conduit/core"

/** Keep each merchant's family/revision checks together, without waiting for
 * unrelated merchants to finish before publishing their completed evidence. */
export async function readEventCatalogProducts(
  coordinates: string[],
  options: NonNullable<Parameters<typeof getProductsByIds>[1]> = {},
  read: typeof getProductsByIds = getProductsByIds,
  readCache: typeof getCachedProductsByIds = getCachedProductsByIds
): Promise<ProductsByIdsResult> {
  const byMerchant = new Map<string, string[]>()
  for (const coordinate of new Set(coordinates)) {
    const merchant = coordinate.split(":")[1] ?? coordinate
    const group = byMerchant.get(merchant) ?? []
    group.push(coordinate)
    byMerchant.set(merchant, group)
  }
  const groups = [...byMerchant.values()]
  if (groups.length <= 1) return read(coordinates, options)
  const snapshots = new Map<number, ProductsByIdsResult>()
  const aggregate = (): ProductsByIdsResult => {
    const results = [...snapshots.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, result]) => result)
    const first = results[0]!
    const diagnostics = results.flatMap((result) => result.diagnostics)
    const observed = new Set(diagnostics.map((entry) => entry.productId))
    return {
      data: results.flatMap((result) => result.data),
      diagnostics: [
        ...diagnostics,
        ...coordinates
          .filter((coordinate) => !observed.has(coordinate))
          .map((coordinate) => ({
            productId: coordinate,
            addressId: coordinate,
            issue: "lookup_partial" as const,
            coverage: {
              listing: "unavailable" as const,
              deletion: "unavailable" as const,
            },
          })),
      ],
      meta: {
        ...first.meta,
        source: results.every((result) => result.meta.source === "local_cache")
          ? "local_cache"
          : "commerce",
        stale:
          snapshots.size < groups.length ||
          results.some((result) => result.meta.stale),
        degraded:
          snapshots.size < groups.length ||
          results.some((result) => result.meta.degraded),
        capped: results.some((result) => result.meta.capped),
        fetchedAt: Math.min(...results.map((result) => result.meta.fetchedAt)),
      },
    }
  }
  // Seed every merchant from the reconciled local cache before publishing
  // partial network batches. Queued merchants keep their browse cards while
  // their diagnostics remain cache-only and cannot authorize pickup.
  try {
    const cached = await readCache(coordinates, {
      includeStale: true,
      includeMarketHidden: true,
    })
    if (options.shouldContinue?.() !== false) {
      for (let index = 0; index < groups.length; index++) {
        const ids = new Set(groups[index])
        snapshots.set(index, {
          ...cached,
          data: cached.data.filter((record) => ids.has(record.product.id)),
          diagnostics: [...ids].map((productId) => ({
            productId,
            addressId: productId,
            issue: "cached_only" as const,
            coverage: {
              listing: "unavailable" as const,
              deletion: "unavailable" as const,
            },
          })),
        })
      }
      options.onProgress?.(aggregate())
    }
  } catch {
    // Unavailable browser storage must not prevent the live reads.
  }
  let next = 0
  const publish = (index: number, result: ProductsByIdsResult) => {
    if (options.shouldContinue?.() === false) return
    snapshots.set(index, result)
    options.onProgress?.(aggregate())
  }
  await Promise.all(
    Array.from({ length: Math.min(4, groups.length) }, async () => {
      while (next < groups.length) {
        if (options.shouldContinue?.() === false)
          throw new DOMException("Event catalog read cancelled", "AbortError")
        const index = next++
        const result = await read(groups[index]!, {
          ...options,
          onProgress: (snapshot) => publish(index, snapshot),
        })
        publish(index, result)
      }
    })
  )
  return aggregate()
}
