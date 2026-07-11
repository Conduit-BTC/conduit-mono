import type { Product } from "@conduit/core"

const RECENT_PRODUCT_WINDOW_MS = 60 * 24 * 60 * 60 * 1_000

type MerchantBucket = {
  cursor: number
  products: Product[]
}

/** Orders a newest-first prepared catalog for merchant-diverse discovery. */
export function diversifyMerchantProductOrder(
  products: readonly Product[],
  options: { nowMs?: number } = {}
): Product[] {
  if (products.length <= 1) return [...products]

  const nowMs = options.nowMs ?? Date.now()
  const recentCutoff = nowMs - RECENT_PRODUCT_WINDOW_MS
  const recentBuckets = new Map<string, MerchantBucket>()
  const nonRecentProducts: Product[] = []

  for (const product of products) {
    if (product.createdAt < recentCutoff || product.createdAt > nowMs) {
      nonRecentProducts.push(product)
      continue
    }

    const bucket = recentBuckets.get(product.pubkey) ?? {
      cursor: 0,
      products: [],
    }
    bucket.products.push(product)
    recentBuckets.set(product.pubkey, bucket)
  }

  const ordered: Product[] = []
  let activeBuckets = Array.from(recentBuckets.values())

  while (activeBuckets.length > 0) {
    const nextRound: MerchantBucket[] = []

    for (const bucket of activeBuckets) {
      ordered.push(bucket.products[bucket.cursor])
      bucket.cursor += 1
      if (bucket.cursor < bucket.products.length) nextRound.push(bucket)
    }

    activeBuckets = nextRound
  }

  return [...ordered, ...nonRecentProducts]
}
