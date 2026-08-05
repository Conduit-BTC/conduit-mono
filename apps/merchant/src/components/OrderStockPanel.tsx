import { Button, StatusPill } from "@conduit/ui"
import {
  getProductDeliveryNoticeVariant,
  type ProductDeliveryNotice,
} from "../lib/product-delivery"
import type { OrderStockAdjustment } from "../lib/productStock"

interface OrderStockDeliveryView {
  adjustment: OrderStockAdjustment
  notice: ProductDeliveryNotice
}

interface OrderStockPanelProps {
  adjustments: OrderStockAdjustment[]
  delivery: OrderStockDeliveryView | null
  deliveryNeedsAttention: boolean
  pending: boolean
  updatePending: boolean
  errorMessage: string | null
  onUpdate: (adjustment: OrderStockAdjustment) => void
  onDecline: (adjustment: OrderStockAdjustment) => void
  onRetry: () => void
  onDismissDelivery: () => void
}

function getDeliveryStateLabel(state: ProductDeliveryNotice["state"]): string {
  if (state === "delivering") return "Delivering"
  if (state === "delivered") return "Delivered"
  if (state === "partial") return "Partial"
  return "Retry needed"
}

export function OrderStockPanel({
  adjustments,
  delivery,
  deliveryNeedsAttention,
  pending,
  updatePending,
  errorMessage,
  onUpdate,
  onDecline,
  onRetry,
  onDismissDelivery,
}: OrderStockPanelProps) {
  if (adjustments.length === 0 && !delivery) return null

  return (
    <section
      aria-labelledby="order-stock-heading"
      className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4"
    >
      <div>
        <h4
          id="order-stock-heading"
          className="text-sm font-semibold text-[var(--text-primary)]"
        >
          Inventory
        </h4>
        <p className="mt-1 text-pretty text-xs leading-5 text-[var(--text-secondary)]">
          Order quantities do not change public listings until you approve and
          sign each update.
        </p>
      </div>

      {delivery && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-xs leading-5 text-[var(--text-secondary)]"
        >
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill
              variant={getProductDeliveryNoticeVariant(delivery.notice.state)}
              className="text-[10px]"
            >
              {getDeliveryStateLabel(delivery.notice.state)}
            </StatusPill>
            <span className="font-medium text-[var(--text-primary)]">
              {delivery.adjustment.title}
            </span>
          </div>
          <p className="mt-2">{delivery.notice.detail}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {deliveryNeedsAttention && (
              <Button
                type="button"
                size="sm"
                className="min-h-10 px-3 text-xs"
                disabled={pending}
                onClick={onRetry}
              >
                Retry delivery
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-10 px-3 text-xs"
              onClick={onDismissDelivery}
            >
              {deliveryNeedsAttention ? "Hide for now" : "Dismiss"}
            </Button>
          </div>
        </div>
      )}

      {adjustments.map((adjustment) => (
        <div
          key={adjustment.key}
          className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3"
        >
          <p className="text-pretty text-sm leading-6 text-[var(--text-primary)]">
            Mark {adjustment.quantity} ×{" "}
            <span className="font-semibold">{adjustment.title}</span> sold.
            Update stock{" "}
            <span className="font-mono tabular-nums">
              {adjustment.currentStock} → {adjustment.nextStock}
            </span>
            ?
          </p>
          {adjustment.shortfall > 0 && (
            <p className="mt-1 text-pretty text-xs leading-5 text-warning">
              The order exceeds tracked stock by {adjustment.shortfall}; this
              update stops at zero.
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              className="min-h-10 flex-1 px-3 text-xs sm:flex-none"
              disabled={pending || deliveryNeedsAttention}
              onClick={() => onUpdate(adjustment)}
            >
              {updatePending
                ? "Waiting for signer…"
                : `Update to ${adjustment.nextStock}`}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-10 flex-1 px-3 text-xs sm:flex-none"
              disabled={pending}
              onClick={() => onDecline(adjustment)}
            >
              Keep {adjustment.currentStock}
            </Button>
          </div>
        </div>
      ))}

      {errorMessage && (
        <div
          role="alert"
          className="rounded-lg border border-error/30 bg-error/10 p-3 text-xs leading-5 text-error"
        >
          {errorMessage}
        </div>
      )}
    </section>
  )
}
