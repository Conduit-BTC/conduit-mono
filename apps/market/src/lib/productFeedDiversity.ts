import type { Product } from "@conduit/core"

const DEFAULT_MAX_CONSECUTIVE_PER_MERCHANT = 2

type IndexedProduct = {
  index: number
  product: Product
}

type MerchantBucket = {
  cursor: number
  merchant: string
  products: IndexedProduct[]
}

function nextProductIndex(bucket: MerchantBucket): number {
  return bucket.products[bucket.cursor]?.index ?? Number.MAX_SAFE_INTEGER
}

function pushMerchantBucket(
  heap: MerchantBucket[],
  bucket: MerchantBucket
): void {
  heap.push(bucket)
  let index = heap.length - 1

  while (index > 0) {
    const parentIndex = Math.floor((index - 1) / 2)
    const parent = heap[parentIndex]
    if (nextProductIndex(parent) <= nextProductIndex(bucket)) break

    heap[index] = parent
    index = parentIndex
  }

  heap[index] = bucket
}

function popMerchantBucket(heap: MerchantBucket[]): MerchantBucket | undefined {
  const first = heap[0]
  const last = heap.pop()
  if (!first || !last || heap.length === 0) return first

  let index = 0
  while (true) {
    const leftIndex = index * 2 + 1
    if (leftIndex >= heap.length) break

    const rightIndex = leftIndex + 1
    const childIndex =
      rightIndex < heap.length &&
      nextProductIndex(heap[rightIndex]) < nextProductIndex(heap[leftIndex])
        ? rightIndex
        : leftIndex

    if (nextProductIndex(last) <= nextProductIndex(heap[childIndex])) break
    heap[index] = heap[childIndex]
    index = childIndex
  }

  heap[index] = last
  return first
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
  let runMerchant: string | null = null
  let runLength = 0
  let needsDiversification = false

  for (const product of products) {
    if (product.pubkey === runMerchant) {
      runLength += 1
    } else {
      runMerchant = product.pubkey
      runLength = 1
    }

    if (runLength > maxConsecutive) {
      needsDiversification = true
      break
    }
  }

  if (!needsDiversification) return [...products]

  const buckets = new Map<string, MerchantBucket>()

  for (const [index, product] of products.entries()) {
    const bucket = buckets.get(product.pubkey) ?? {
      cursor: 0,
      merchant: product.pubkey,
      products: [],
    }
    bucket.products.push({ index, product })
    buckets.set(product.pubkey, bucket)
  }

  const diversified: Product[] = []
  const merchantHeap: MerchantBucket[] = []
  for (const bucket of buckets.values()) {
    pushMerchantBucket(merchantHeap, bucket)
  }
  let lastMerchant: string | null = null
  let consecutiveCount = 0

  while (merchantHeap.length > 0) {
    // Preserve the caller's order until the next product would exceed the cap.
    // At that point, promote the nearest alternative publisher and then resume.
    let bucket = popMerchantBucket(merchantHeap)
    if (!bucket) break

    if (
      bucket.merchant === lastMerchant &&
      consecutiveCount >= maxConsecutive &&
      merchantHeap.length > 0
    ) {
      const blockedBucket = bucket
      const alternativeBucket = popMerchantBucket(merchantHeap)
      if (alternativeBucket) {
        bucket = alternativeBucket
        pushMerchantBucket(merchantHeap, blockedBucket)
      }
    }

    const nextProduct = bucket.products[bucket.cursor]
    diversified.push(nextProduct.product)
    bucket.cursor += 1

    if (bucket.merchant === lastMerchant) {
      consecutiveCount += 1
    } else {
      lastMerchant = bucket.merchant
      consecutiveCount = 1
    }

    if (bucket.cursor < bucket.products.length) {
      pushMerchantBucket(merchantHeap, bucket)
    }
  }

  return diversified
}
