import { AlertTriangle } from "lucide-react"

interface CheckoutAvailabilityNoticeProps {
  lastQuantityReported: boolean
  partialCoverage: boolean
}

export function CheckoutAvailabilityNotice({
  lastQuantityReported,
  partialCoverage,
}: CheckoutAvailabilityNoticeProps) {
  if (!lastQuantityReported && !partialCoverage) return null

  const availabilityCopy = lastQuantityReported
    ? partialCoverage
      ? "This order uses the last quantity reported by a signed listing observed live on responding relays. Some relays did not respond, and Nostr listings do not reserve inventory, so the merchant will confirm final availability."
      : "This order uses the last quantity reported by a signed listing observed live. Nostr listings do not reserve inventory, so the merchant will confirm final availability."
    : "A signed listing was observed live on responding relays, but some relays did not respond. The merchant will confirm final availability."

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="flex items-start gap-3 rounded-2xl border border-warning/40 bg-warning/10 p-4 text-sm text-[var(--text-secondary)]"
    >
      <AlertTriangle
        aria-hidden="true"
        className="mt-0.5 size-5 shrink-0 text-warning"
      />
      <div>
        <div className="text-balance font-medium text-[var(--text-primary)]">
          {lastQuantityReported
            ? "Limited availability"
            : "Availability may still change"}
        </div>
        <p className="mt-1 text-pretty leading-6">{availabilityCopy}</p>
        {lastQuantityReported && (
          <p className="mt-1 text-pretty leading-6">
            If restocking is delayed, the merchant can message you with timing
            or coordinate a refund.
          </p>
        )}
      </div>
    </div>
  )
}
