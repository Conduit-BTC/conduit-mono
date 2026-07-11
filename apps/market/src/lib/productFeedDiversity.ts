import type { Product } from "@conduit/core"

const DEFAULT_MAX_CONSECUTIVE_PER_MERCHANT = 2

type IndexedProduct = {
  index: number
  product: Product
}

type MerchantBucket = {
  cursor: number
  products: IndexedProduct[]
}

export function diversifyMerchantProductOrder(
  products: Product[],
  options: { maxConsecutivePerMerchant?: number } = {}
): Product[] {
  if (products.length <= 1) return [...products]

  const maxConsecutive = Math.max(
    1,
    Math.floor(
      options.maxConsecutivePerMerchant ?? DEFAULT_MAX_CONSECUTIVE_PER_MERCHANT
    )
  )
  const buckets = new Map<string, MerchantBucket>()

  for (const [index, product] of products.entries()) {
    const bucket = buckets.get(product.pubkey) ?? { cursor: 0, products: [] }
    bucket.products.push({ index, product })
    buckets.set(product.pubkey, bucket)
  }

  const diversified: Product[] = []
  const activeMerchants = Array.from(buckets.keys())
  let lastMerchant: string | null = null
  let consecutiveCount = 0

  while (activeMerchants.length > 0) {
    // Preserve the caller's order until the next product would exceed the cap.
    // At that point, promote the nearest alternative publisher and then resume.
    activeMerchants.sort((a, b) => {
      const aBucket = buckets.get(a)
      const bBucket = buckets.get(b)
      return (
        (aBucket?.products[aBucket.cursor]?.index ?? Number.MAX_SAFE_INTEGER) -
        (bBucket?.products[bBucket.cursor]?.index ?? Number.MAX_SAFE_INTEGER)
      )
    })

    let selectedMerchantIndex = 0
    if (
      activeMerchants[0] === lastMerchant &&
      consecutiveCount >= maxConsecutive
    ) {
      const alternativeIndex = activeMerchants.findIndex(
        (merchant) => merchant !== lastMerchant
      )
      if (alternativeIndex >= 0) selectedMerchantIndex = alternativeIndex
    }

    const merchant = activeMerchants[selectedMerchantIndex]
    const bucket = buckets.get(merchant)
    const nextProduct = bucket?.products[bucket.cursor]
    if (!bucket || !nextProduct) {
      activeMerchants.splice(selectedMerchantIndex, 1)
      continue
    }

    diversified.push(nextProduct.product)
    bucket.cursor += 1

    if (merchant === lastMerchant) {
      consecutiveCount += 1
    } else {
      lastMerchant = merchant
      consecutiveCount = 1
    }

    if (bucket.cursor >= bucket.products.length) {
      activeMerchants.splice(selectedMerchantIndex, 1)
    }
  }

  return diversified
}
