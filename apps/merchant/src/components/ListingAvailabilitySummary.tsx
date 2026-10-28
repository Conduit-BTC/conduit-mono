import {
  getListingAvailabilityDisplay,
  hasEventMarketListingVisibility,
  type ListingAvailabilityEvaluation,
  type ProductSchema,
} from "@conduit/core"
import { Button, StatusPill } from "@conduit/ui"

export function ListingAvailabilitySummary({
  item,
  onEdit,
}: {
  item: {
    product: ProductSchema
    availability: ListingAvailabilityEvaluation
    variationForm: { supported: boolean; reason?: string }
    variations: readonly unknown[]
  }
  onEdit?: () => void
}) {
  const display = getListingAvailabilityDisplay(item.availability)
  const intentionalEventOnly =
    item.variationForm.supported &&
    item.product.eventOnly === true &&
    hasEventMarketListingVisibility(item.product) &&
    item.availability.reasons.some((reason) => reason.code === "event_only") &&
    item.availability.reasons.every(
      (reason) =>
        reason.code === "event_only" || reason.code === "merchant_hidden"
    )

  if (intentionalEventOnly) {
    return (
      <article className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-sm text-[var(--text-secondary)]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-semibold text-[var(--text-primary)]">
              {item.product.title}
            </div>
            <p className="mt-2 leading-6">
              Hidden from your regular shop. Sell through its approved event
              assignments.
            </p>
            <p className="mt-2 text-xs leading-5">
              Event assignment and payment checks still apply.
            </p>
          </div>
          <StatusPill variant="neutral" className="text-[10px]">
            Events only
          </StatusPill>
        </div>
        {onEdit ? (
          <Button variant="outline" size="sm" className="mt-3" onClick={onEdit}>
            Edit
          </Button>
        ) : null}
      </article>
    )
  }

  if (item.product.type === "variable" && item.variationForm.supported) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-2">
        <StatusPill variant="info" className="text-[10px]">
          Variable product
        </StatusPill>
        <span className="text-xs text-[var(--text-secondary)]">
          {item.variations.length} variation
          {item.variations.length === 1 ? "" : "s"}
        </span>
      </div>
    )
  }

  if (!item.variationForm.supported) {
    return (
      <article className="rounded-[var(--radius-md)] border border-warning/30 bg-warning/10 p-4 text-sm text-[var(--warning-text)]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-semibold text-[var(--text-primary)]">
              {item.product.title}
            </div>
            <p className="mt-2 leading-6">
              {item.variationForm.reason ??
                "This variation family cannot be edited safely."}
            </p>
          </div>
          <StatusPill variant="warning" className="text-[10px]">
            Read-only
          </StatusPill>
        </div>
        <p className="mt-3 text-xs leading-5 text-[var(--text-secondary)]">
          You can delete the known listing family, but editing is disabled to
          avoid losing unsupported option data.
        </p>
      </article>
    )
  }

  return (
    <article className="rounded-[var(--radius-md)] border border-warning/30 bg-warning/10 p-4 text-sm text-[var(--warning-text)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold text-[var(--text-primary)]">
            {item.product.title}
          </div>
          <div className="mt-2 leading-6">{display.summary}</div>
          <p className="mt-2 text-xs leading-5 text-[var(--text-secondary)]">
            {display.merchantAction}
          </p>
        </div>
        <StatusPill variant={display.tone} className="text-[10px]">
          {display.label}
        </StatusPill>
      </div>

      {onEdit && (
        <Button variant="outline" size="sm" className="mt-3" onClick={onEdit}>
          Fix listing
        </Button>
      )}
    </article>
  )
}
