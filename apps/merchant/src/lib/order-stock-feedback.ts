import { SignedProductDeliveryError } from "./product-publishing"

interface StockDeliveryReference {
  orderId: string
  adjustment: { key: string }
}

export function getOrderStockUpdateErrorMessage(
  error: unknown,
  failedAction?: StockDeliveryReference | null,
  savedDelivery?: StockDeliveryReference | null
): string | null {
  if (!error) return null
  if (error instanceof SignedProductDeliveryError) {
    // A delivery error does not itself prove that a local checkpoint exists.
    // Only the matching saved notice can replace the ordinary error message.
    if (
      failedAction &&
      savedDelivery &&
      savedDelivery.orderId === failedAction.orderId &&
      savedDelivery.adjustment.key === failedAction.adjustment.key
    ) {
      return null
    }
    return error.retryable
      ? "Stock update delivery could not be confirmed. Refresh orders to check its saved status before trying again."
      : "Stock update could not be queued safely. Refresh orders to check its saved status before trying again."
  }
  return error instanceof Error
    ? error.message
    : "Failed to update listing stock"
}
