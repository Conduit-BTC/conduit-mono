import { Button, cn, StatusPill } from "@conduit/ui"
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
  stockMutationDisabledKeys?: ReadonlySet<string>
  delivery: OrderStockDeliveryView | null
  deliveryNeedsAttention: boolean
  pending: boolean
  updatePending: boolean
  errorMessage: string | null
  canMessageBuyer?: boolean
  onUpdate: (adjustment: OrderStockAdjustment) => void
  onDecline: (adjustment: OrderStockAdjustment) => void
  onMessageBuyer?: () => void
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
  stockMutationDisabledKeys = new Set<string>(),
  delivery,
  deliveryNeedsAttention,
  pending,
  updatePending,
  errorMessage,
  canMessageBuyer = false,
  onUpdate,
  onDecline,
  onMessageBuyer,
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

      {adjustments.map((adjustment) => {
        const restockingRequired = adjustment.state === "restocking_required"
        const canUpdateStock =
          !stockMutationDisabledKeys.has(adjustment.key) &&
          adjustment.currentStock > adjustment.nextStock
        const showMessageBuyer =
          restockingRequired && canMessageBuyer && Boolean(onMessageBuyer)
        const showActions =
          canUpdateStock || showMessageBuyer || !restockingRequired

        return (
          <div
            key={adjustment.key}
            className={cn(
              "rounded-lg border bg-[var(--surface)] p-3",
              restockingRequired
                ? "border-warning/30 bg-warning/10"
                : "border-[var(--border)]"
            )}
          >
            {restockingRequired ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill variant="warning" className="text-[10px]">
                    Restocking required
                  </StatusPill>
                  <span className="font-medium text-[var(--text-primary)]">
                    {adjustment.title}
                  </span>
                </div>
                <p className="mt-2 text-pretty text-sm leading-6 text-[var(--text-primary)]">
                  {adjustment.currentStock === 0 ? (
                    <>
                      This order requests {adjustment.quantity} ×{" "}
                      <span className="font-semibold">{adjustment.title}</span>,
                      but tracked stock is already 0.
                    </>
                  ) : (
                    <>
                      This order requests {adjustment.quantity} ×{" "}
                      <span className="font-semibold">{adjustment.title}</span>.
                      It exceeds tracked stock by {adjustment.shortfall}; the
                      listing update stops at zero.
                    </>
                  )}
                </p>
                <p className="mt-1 text-pretty text-xs leading-5 text-[var(--text-secondary)]">
                  You can fulfill it after restocking,{" "}
                  {showMessageBuyer ? "message" : "contact"} the buyer with a
                  restock estimate and let them know if they are first in line,
                  or coordinate a refund if you cannot fulfill it.
                </p>
              </>
            ) : (
              <p className="text-pretty text-sm leading-6 text-[var(--text-primary)]">
                Mark {adjustment.quantity} ×{" "}
                <span className="font-semibold">{adjustment.title}</span> sold.
                Update stock{" "}
                <span className="font-mono tabular-nums">
                  {adjustment.currentStock} → {adjustment.nextStock}
                </span>
                ?
              </p>
            )}
            {showActions && (
              <div className="mt-3 flex flex-wrap gap-2">
                {canUpdateStock && (
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
                )}
                {showMessageBuyer && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-h-10 flex-1 px-3 text-xs sm:flex-none"
                    disabled={pending}
                    onClick={onMessageBuyer}
                  >
                    Message buyer
                  </Button>
                )}
                {!restockingRequired && (
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
                )}
              </div>
            )}
          </div>
        )
      })}

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
