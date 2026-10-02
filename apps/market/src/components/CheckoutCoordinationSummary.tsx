import type { CheckoutSparkBuyerPrice } from "@conduit/core"

/** The buyer's price, not the merchant's commercially sensitive split plan. */
export function CheckoutCoordinationSummary({
  price,
  estimate = false,
  formatSats = (sats) =>
    `${sats.toLocaleString()} ${sats === 1 ? "sat" : "sats"}`,
}: {
  price: CheckoutSparkBuyerPrice
  estimate?: boolean
  formatSats?: (sats: number) => string
}) {
  const feeLabel =
    price.coordinationFeeSats === 0
      ? "No fee"
      : `${price.minimumApplies ? "111-sat minimum" : "2.1%"}${price.networkAllowanceSats > 0 ? " + network estimate" : ""}`
  return (
    <section aria-label="Order price" className="text-sm">
      <dl className="space-y-3 text-[var(--text-secondary)]">
        <div className="flex items-start justify-between gap-4">
          <dt>Item subtotal</dt>
          <dd className="shrink-0 text-right tabular-nums">
            {formatSats(price.itemSubtotalSats)}
          </dd>
        </div>
        <div className="flex items-start justify-between gap-4">
          <dt>Shipping subtotal</dt>
          <dd className="shrink-0 text-right tabular-nums">
            {formatSats(price.shippingSubtotalSats)}
          </dd>
        </div>
        <div className="flex items-start justify-between gap-4">
          <dt>
            Coordination fee{" "}
            <span className="mt-0.5 block text-xs text-[var(--text-muted)]">
              {feeLabel}
            </span>
          </dt>
          <dd className="shrink-0 text-right tabular-nums">
            {formatSats(price.coordinationFeeSats)}
          </dd>
        </div>
        <div className="flex items-end justify-between gap-4 border-t border-[var(--border)] pt-4 text-lg font-semibold text-[var(--text-primary)]">
          <dt>{estimate ? "Estimated order total" : "Order total"}</dt>
          <dd className="shrink-0 text-right tabular-nums">
            {formatSats(price.totalSats)}
          </dd>
        </div>
      </dl>
    </section>
  )
}
