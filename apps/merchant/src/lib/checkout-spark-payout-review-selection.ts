/**
 * Presentation consent only: changing the selected order invalidates an open or
 * pending manual review, without changing any background recovery authority.
 */
export function createMerchantCheckoutSparkPayoutReviewSelection() {
  let orderId: string | null = null
  let selectionKey: string | null = null
  let revision = 0
  return {
    select(
      nextOrderId: string | null,
      nextSelectionKey: string | null = null
    ): number {
      if (nextOrderId !== orderId || nextSelectionKey !== selectionKey) {
        orderId = nextOrderId
        selectionKey = nextSelectionKey
        revision += 1
      }
      return revision
    },
    capture(
      reviewOrderId: string,
      reviewSelectionKey: string | null = null
    ): () => boolean {
      const capturedRevision = revision
      return () =>
        orderId === reviewOrderId &&
        selectionKey === reviewSelectionKey &&
        revision === capturedRevision
    },
  }
}
