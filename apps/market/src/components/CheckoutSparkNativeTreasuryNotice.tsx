function sats(value: number): string {
  return `${value.toLocaleString()} ${value === 1 ? "sat" : "sats"}`
}

export function CheckoutSparkNativeTreasuryNotice({
  estimatedBaseConduitAllocationSats,
  fixedCheckoutTotalSats,
  prepared,
}: {
  estimatedBaseConduitAllocationSats: number
  fixedCheckoutTotalSats: number
  prepared: null | {
    baseConduitAllocationSats: number
    unusedCommerceReserveSats: number
    totalSats: number
    sparkFeeCapSats: 0
  }
}) {
  return (
    <section
      aria-label="Native Spark treasury authorization"
      className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-3 text-xs leading-5 text-[var(--text-secondary)]"
    >
      <h3 className="font-medium text-[var(--text-primary)]">
        Native Spark treasury
      </h3>
      {prepared ? (
        <p className="mt-1">
          The final Conduit payment is prepared for {sats(prepared.totalSats)}{" "}
          from verified checkout history: the actual{" "}
          {sats(prepared.baseConduitAllocationSats)} Conduit allocation after
          exact funding credit plus {sats(prepared.unusedCommerceReserveSats)}{" "}
          of unused, authorized recipient fee reserves. The native Spark fee cap
          is {sats(prepared.sparkFeeCapSats)}. Across all payments, debit
          remains within the fixed {sats(fixedCheckoutTotalSats)} buyer total.
        </p>
      ) : (
        <p className="mt-1">
          Before funding, you approve a final native payment to Conduit&apos;s
          configured Spark treasury only after every exact recipient payment is
          verified. The best-effort Conduit allocation estimate is{" "}
          {sats(estimatedBaseConduitAllocationSats)}. Its final amount combines
          the actual allocation after exact funding credit with unused,
          authorized recipient fee reserves. Across all checkout payments, debit
          cannot exceed the fixed {sats(fixedCheckoutTotalSats)} buyer total.
          The saved order total cannot increase.
        </p>
      )}
    </section>
  )
}
