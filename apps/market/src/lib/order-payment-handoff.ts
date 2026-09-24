import type { OrderPaymentContext } from "./order-payment-service"

// Spark's fee decision belongs to the focused payment surface. Keep the
// checkout's transient payment preparation in this tab only until that surface
// mounts; a reload falls back to the accepted-order recovery action.
let pendingSparkPayment: {
  context: OrderPaymentContext
  purchaseCleanup: Promise<void>
  expiresAt: number
} | null = null

export function queueSparkPaymentHandoff(
  context: OrderPaymentContext,
  purchaseCleanup: Promise<void>
): void {
  const pending = {
    context,
    purchaseCleanup,
    expiresAt: Date.now() + 60_000,
  }
  pendingSparkPayment = pending
  globalThis.setTimeout(() => {
    if (pendingSparkPayment === pending) pendingSparkPayment = null
  }, 60_000)
}

export function takeSparkPaymentHandoff(
  orderId: string,
  buyerPubkey: string
): { context: OrderPaymentContext; purchaseCleanup: Promise<void> } | null {
  const pending = pendingSparkPayment
  if (!pending) return null
  if (Date.now() > pending.expiresAt) {
    pendingSparkPayment = null
    return null
  }
  if (
    pending.context.orderId !== orderId ||
    pending.context.buyerPubkey !== buyerPubkey
  ) {
    return null
  }
  pendingSparkPayment = null
  return {
    context: pending.context,
    purchaseCleanup: pending.purchaseCleanup,
  }
}
