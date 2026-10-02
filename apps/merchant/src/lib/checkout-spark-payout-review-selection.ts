/**
 * Presentation consent only: changing the selected order invalidates an open or
 * pending manual review, without changing any background recovery authority.
 */
export function createMerchantCheckoutSparkPayoutReviewSelection() {
  let orderId: string | null = null
  let revision = 0
  return {
    select(nextOrderId: string | null): number {
      if (nextOrderId !== orderId) {
        orderId = nextOrderId
        revision += 1
      }
      return revision
    },
    capture(reviewOrderId: string): () => boolean {
      const capturedRevision = revision
      return () => orderId === reviewOrderId && revision === capturedRevision
    },
  }
}
