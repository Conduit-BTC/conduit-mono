function sats(value: number): string {
  return `${value.toLocaleString()} ${value === 1 ? "sat" : "sats"}`
}

export function CheckoutSparkNativeTreasuryNotice({
  estimatedBaseConduitAllocationSats,
  fixedCheckoutTotalSats,
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
    <p className="text-xs leading-5 text-[var(--text-secondary)]">
      Your fixed total of {sats(fixedCheckoutTotalSats)} includes a best-effort{" "}
      {sats(estimatedBaseConduitAllocationSats)} Conduit fee estimate and
      payment reserves; Conduit is paid last, including unused authorized
      reserves, with no increase to your total.
    </p>
  )
}
