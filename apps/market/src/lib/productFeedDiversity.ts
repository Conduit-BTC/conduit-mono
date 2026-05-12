import type { Product } from "@conduit/core"

const DEFAULT_DIVERSITY_WINDOW_SIZE = 72

export function diversifyMerchantProductOrder(
  products: Product[],
  options: { windowSize?: number } = {}
): Product[] {
  const windowSize = options.windowSize ?? DEFAULT_DIVERSITY_WINDOW_SIZE
  if (products.length <= 2 || windowSize <= 1) return [...products]

  const diversified: Product[] = []

  for (let start = 0; start < products.length; start += windowSize) {
    const window = products.slice(start, start + windowSize)
    const buckets = new Map<string, Product[]>()

    for (const product of window) {
      const bucket = buckets.get(product.pubkey) ?? []
      bucket.push(product)
      buckets.set(product.pubkey, bucket)
    }

    let activeMerchants = Array.from(buckets.keys()).sort(
      (a, b) =>
        (buckets.get(b)?.[0]?.createdAt ?? 0) -
        (buckets.get(a)?.[0]?.createdAt ?? 0)
    )

    while (activeMerchants.length > 0) {
      const nextRound: string[] = []

      for (const merchant of activeMerchants) {
        const bucket = buckets.get(merchant)
        const nextProduct = bucket?.shift()
        if (nextProduct) diversified.push(nextProduct)
        if (bucket && bucket.length > 0) nextRound.push(merchant)
      }

      activeMerchants = nextRound.sort(
        (a, b) =>
          (buckets.get(b)?.[0]?.createdAt ?? 0) -
          (buckets.get(a)?.[0]?.createdAt ?? 0)
      )
    }
  }

  return diversified
}
