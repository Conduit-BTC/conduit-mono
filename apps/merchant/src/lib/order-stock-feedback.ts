import { SignedProductDeliveryError } from "./product-publishing"

interface StockDeliveryReference {
  orderId: string
  adjustment: { key: string }
}

function getStockQueueCauseMessage(cause: unknown): string | null {
  if (!(cause instanceof Error)) return null
  // Fixed domain errors only; never expose arbitrary storage/provider details.
  switch (cause.message) {
    case "Reconcile occurrence allocations before changing stock":
      return "This stock change conflicts with the product's event allocations. Review those allocations, then refresh Orders to check the saved status before trying again."
    case "This order already consumed inventory at acceptance":
      return "Stock was already counted when this order was accepted. Refresh Orders to check its saved status; don't subtract it again."
    case "Product changed before the signed local commit":
    case "Committed inventory changed before the product edit":
    case "The listing changed while preparing the stock update. Refresh orders and try again.":
      return "The listing or inventory changed while this update was being prepared. Refresh Orders and review the current stock and saved update before trying again."
    case "Browser storage is unavailable for stock recovery":
    case "Stored stock checkpoints are unreadable":
      return "Saved stock information is unavailable or unreadable in this browser. Check its saved status before continuing; don't clear browser data or repeat the stock update."
    default:
      return null
  }
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
    if (!error.retryable) {
      const causeMessage = getStockQueueCauseMessage(error.deliveryCause)
      if (causeMessage) return causeMessage
    }
    return error.retryable
      ? "Stock update delivery could not be confirmed. Refresh orders to check its saved status before trying again."
      : "Stock update could not be queued safely. Refresh orders to check its saved status before trying again."
  }
  return error instanceof Error
    ? error.message
    : "Failed to update listing stock"
}
