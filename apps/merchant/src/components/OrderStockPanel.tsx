import { useId, useState, type FormEvent } from "react"
import { Button, cn, Input, Label, StatusPill } from "@conduit/ui"
import {
  getProductDeliveryNoticeVariant,
  type ProductDeliveryNotice,
} from "../lib/product-delivery"
import {
  getProductStockInputError,
  parseProductStockInput,
  type OrderStockAdjustment,
  type OrderStockTargetMode,
} from "../lib/productStock"

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
  onUpdate: (
    adjustment: OrderStockAdjustment,
    stock: number,
    targetMode: OrderStockTargetMode
  ) => void
  onMessageBuyer?: () => void
  onRetry: () => void
  onDismissDelivery: () => void
}

function StockPublishActions({
  adjustment,
  pending,
  updatePending,
  showCalculated,
  onUpdate,
}: {
  adjustment: OrderStockAdjustment
  pending: boolean
  updatePending: boolean
  showCalculated: boolean
  onUpdate: (
    adjustment: OrderStockAdjustment,
    stock: number,
    targetMode: OrderStockTargetMode
  ) => void
}) {
  const fieldIdentity = useId()
  const [customStock, setCustomStock] = useState("")
  const [customError, setCustomError] = useState<string | null>(null)
  const fieldId = `custom-stock-${fieldIdentity}`
  const helpId = `custom-stock-help-${fieldIdentity}`
  const errorId = `custom-stock-error-${fieldIdentity}`

  function publishCustomStock(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const error = customStock.trim()
      ? getProductStockInputError(customStock)
      : "Enter the available quantity to publish."
    if (error) {
      setCustomError(error)
      return
    }

    const stock = parseProductStockInput(customStock)
    if (stock === undefined) return
    setCustomError(null)
    onUpdate(adjustment, stock, "custom")
  }

  return (
    <div className="space-y-3">
      {showCalculated && (
        <Button
          type="button"
          size="sm"
          className="min-h-10 w-full px-3 text-xs sm:w-auto"
          disabled={pending}
          onClick={() =>
            onUpdate(adjustment, adjustment.nextStock, "calculated")
          }
        >
          {updatePending
            ? "Waiting for signer…"
            : `Publish stock ${adjustment.nextStock}`}
        </Button>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        aria-busy={updatePending}
        onSubmit={publishCustomStock}
      >
        <div className="min-w-40 flex-1 space-y-1 sm:max-w-52">
          <Label htmlFor={fieldId}>Custom updated stock</Label>
          <Input
            id={fieldId}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={customStock}
            disabled={pending}
            aria-invalid={customError ? true : undefined}
            aria-describedby={`${helpId}${customError ? ` ${errorId}` : ""}`}
            onChange={(event) => {
              setCustomStock(event.target.value)
              if (customError) setCustomError(null)
            }}
          />
        </div>
        <Button
          type="submit"
          variant="outline"
          size="sm"
          className="min-h-10 flex-1 px-3 text-xs sm:flex-none"
          disabled={pending}
        >
          {updatePending ? "Waiting for signer…" : "Publish custom stock"}
        </Button>
        <p
          id={helpId}
          className="w-full text-pretty text-xs leading-5 text-[var(--text-secondary)]"
        >
          Enter the available quantity you want to publish for this listing.
        </p>
        {customError && (
          <p
            id={errorId}
            role="alert"
            className="w-full text-pretty text-xs leading-5 text-error"
          >
            {customError}
          </p>
        )}
      </form>
    </div>
  )
}

function getDeliveryStateLabel(state: ProductDeliveryNotice["state"]): string {
  if (state === "delivering") return "Delivering"
  if (state === "delivered") return "Delivered"
  if (state === "partial") return "Partial"
  return "Retry needed"
}

function getInventorySyncDetail(detail: string): string {
  return detail.replaceAll("Retry delivery", "Retry listing sync")
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
          Inventory sync
        </h4>
        <p className="mt-1 text-pretty text-xs leading-5 text-[var(--text-secondary)]">
          Optional and separate from fulfillment. Public listings change only
          after you approve and sign each update.
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
          <p className="mt-2">
            {getInventorySyncDetail(delivery.notice.detail)}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {deliveryNeedsAttention && (
              <Button
                type="button"
                size="sm"
                className="min-h-10 px-3 text-xs"
                disabled={pending}
                onClick={onRetry}
              >
                Retry listing sync
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
        const restockingRequired = adjustment.shortfall > 0
        const canPublishStock = !stockMutationDisabledKeys.has(adjustment.key)
        const showCalculatedStock =
          adjustment.currentStock !== adjustment.nextStock
        const showMessageBuyer =
          restockingRequired && canMessageBuyer && Boolean(onMessageBuyer)
        const showActions = canPublishStock || showMessageBuyer

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
              <div className="mt-3 space-y-3">
                {canPublishStock && (
                  <StockPublishActions
                    adjustment={adjustment}
                    pending={pending || deliveryNeedsAttention}
                    updatePending={updatePending}
                    showCalculated={showCalculatedStock}
                    onUpdate={onUpdate}
                  />
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
