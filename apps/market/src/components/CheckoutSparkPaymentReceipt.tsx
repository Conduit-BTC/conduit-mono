import type { CheckoutSparkPaymentReceipt as PaymentReceipt } from "../lib/checkout-spark-buyer-settlement"

function Amount({ label, sats }: { label: string; sats: number }) {
  return (
    <div>
      <dt className="text-xs text-[var(--text-secondary)]">{label}</dt>
      <dd className="mt-1 tabular-nums text-[var(--text-primary)]">
        {sats.toLocaleString()} {sats === 1 ? "sat" : "sats"}
      </dd>
    </div>
  )
}

/** Private recorded facts only: rendering this receipt never inspects or moves funds. */
export function CheckoutSparkPaymentReceipt({
  receipt,
}: {
  receipt: PaymentReceipt
}) {
  return (
    <details className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
      <summary className="cursor-pointer text-sm font-medium text-[var(--text-primary)]">
        Payment details
      </summary>
      <section aria-label="Payment history" className="mt-4">
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">
          Payment history
        </h2>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          Recorded payment history, not a live wallet balance. Source-wallet
          fees and later refunds or transfers are not included.
        </p>
        <dl className="mt-4">
          <Amount label="Funding credited" sats={receipt.creditedSats} />
        </dl>
        <p className="mt-4 text-sm text-[var(--text-secondary)]">
          {!receipt.allPayoutsRecorded
            ? "Payments are still being completed."
            : receipt.rows.every((row) => row.payment?.recipientVerified)
              ? "All checkout payments verified."
              : "Payments recorded; final verification is still pending."}
        </p>
        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <Amount label="Recorded payouts" sats={receipt.recordedPaidSats} />
          <Amount
            label="Recorded outgoing fees"
            sats={receipt.recordedFeeSats}
          />
          <Amount
            label="Recorded total debited"
            sats={receipt.recordedDebitSats}
          />
        </dl>
        {receipt.nativeTreasury && (
          <section
            aria-label="Completed native Spark payment"
            className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-3"
          >
            <h3 className="text-sm font-medium text-[var(--text-primary)]">
              Completed native Spark payment
            </h3>
            <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">
              The final Conduit payment is recorded from its exact completed
              transfer. The approved order total did not increase.
            </p>
            <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
              <Amount
                label="Base Conduit allocation"
                sats={receipt.nativeTreasury.baseConduitAllocationSats}
              />
              <Amount
                label="Unused recipient fee reserves included"
                sats={receipt.nativeTreasury.unusedCommerceReserveSats}
              />
              <Amount
                label="Final Conduit payment"
                sats={receipt.nativeTreasury.debitSats}
              />
              <Amount
                label="Actual native Spark fee"
                sats={receipt.nativeTreasury.feeSats}
              />
            </dl>
          </section>
        )}
        <div className="mt-4 border-t border-[var(--border)] pt-4">
          {receipt.recordedUnspentSats !== null ? (
            <dl>
              <Amount
                label="Unspent from recorded checkout credit"
                sats={receipt.recordedUnspentSats}
              />
            </dl>
          ) : (
            <p className="text-sm text-[var(--text-secondary)]">
              The recorded remainder is unavailable until every payout has a
              payment record. Totals above include recorded payouts only.
            </p>
          )}
          <p className="mt-2 text-xs leading-5 text-[var(--text-secondary)]">
            These records do not prove the wallet is empty or safe to remove.
            Payment is separate from delivery confirmation.
          </p>
        </div>
      </section>
    </details>
  )
}
