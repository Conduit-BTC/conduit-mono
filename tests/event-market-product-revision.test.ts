import { expect, test } from "bun:test"
import { finalizeEvent, getPublicKey } from "nostr-tools"
import { assertReviewedEventMarketProductRevision } from "../apps/market/src/lib/event-market-product-revision"
import {
  cacheSignedProductListingEvent,
  getCachedProductDetail,
  __setCommerceTestOverrides,
  __resetCommerceTestOverrides,
} from "../packages/core/src/protocol/commerce"
import { __resetPublicEventVerificationForTests } from "../packages/core/src/protocol/verified-public-event"
import type { CachedProduct } from "../packages/core/src/db"

test("authority-only revision is retained before rejecting a purchase and stale feed refresh cannot restore old terms", async () => {
  const originalWorker = globalThis.Worker
  globalThis.Worker = undefined as unknown as typeof Worker
  __resetPublicEventVerificationForTests()
  const key = new Uint8Array(32).fill(24)
  const pubkey = getPublicKey(key)
  const productId = `30402:${pubkey}:revision-review`
  const listing = (created_at: number, price: string) =>
    finalizeEvent(
      {
        kind: 30402,
        created_at,
        content: "",
        tags: [
          ["image", "https://example.com/coffee.png"],
          ["d", "revision-review"],
          ["title", "Coffee"],
          ["price", price, "SATS"],
          ["type", "simple", "digital"],
        ],
      },
      key
    )
  const oldFeedRevision = listing(10, "10")
  const authorityRevision = listing(20, "20")
  let rows: CachedProduct[] = []
  __setCommerceTestOverrides({
    now: () => 100_000,
    getCachedProducts: async () => rows,
    putCachedProducts: async (next) => {
      rows = next
    },
    getCachedProductTombstones: async () => [],
    putCachedProductTombstones: async () => {},
  })
  try {
    await cacheSignedProductListingEvent(oldFeedRevision)
    await expect(
      assertReviewedEventMarketProductRevision(
        oldFeedRevision.id,
        authorityRevision
      )
    ).rejects.toThrow("Review the refreshed item")
    const refreshed = await getCachedProductDetail({
      productId,
      includeMarketHidden: true,
    })
    expect(refreshed.data?.product.sourceEventId).toBe(authorityRevision.id)
    expect(refreshed.data?.product.price).toBe(20)
    await cacheSignedProductListingEvent(oldFeedRevision)
    const next = await getCachedProductDetail({
      productId,
      includeMarketHidden: true,
    })
    expect(next.data?.product.sourceEventId).toBe(authorityRevision.id)
    await assertReviewedEventMarketProductRevision(
      next.data?.product.sourceEventId,
      authorityRevision
    )
  } finally {
    __resetCommerceTestOverrides()
    __resetPublicEventVerificationForTests()
    globalThis.Worker = originalWorker
  }
})
