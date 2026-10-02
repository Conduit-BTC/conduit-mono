interface CheckoutSparkMerchantSettlementStatusProps {
  projection: {
    creditVerified: boolean
    merchantVerified: boolean
    commerceVerified: boolean
    feePending: boolean
    recipientUnverified?: boolean
  } | null
}

/** Display-only provider-proof projection; never authorizes fulfillment. */
export function CheckoutSparkMerchantSettlementStatus({
  projection,
}: CheckoutSparkMerchantSettlementStatusProps) {
  const label = projection?.commerceVerified
    ? "Commerce payments verified"
    : projection?.merchantVerified
      ? projection.creditVerified
        ? "Merchant payment verified; other commerce payouts need verification"
        : "Merchant payment verified; funding verification incomplete"
      : projection?.recipientUnverified
        ? "Payout observed; recipient not yet verified on this device"
        : projection?.creditVerified
          ? "Funding verified; merchant payment not yet verified"
          : "Payment not yet verified"

  return (
    <div aria-label="Verified checkout status" className="mt-2 text-xs">
      <p className="text-[var(--text-secondary)]">{label}</p>
      {projection?.recipientUnverified && (
        <p className="mt-1 text-[var(--text-muted)]">
          Spark confirms an exact invoice payment, but this device has no saved
          evidence that its invoice came from the frozen recipient. Do not pay
          it again.
        </p>
      )}
      {projection?.commerceVerified && projection.feePending && (
        <p className="mt-1 text-[var(--text-muted)]">
          The service-fee payout is still unverified. Commerce remains paid.
        </p>
      )}
    </div>
  )
}
