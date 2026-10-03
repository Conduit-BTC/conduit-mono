import {
  restoreCheckoutSparkRetiredSettlementSummary,
  validateCheckoutSparkRetiredSettlementRecord,
  type CheckoutSparkMerchantSettlementRecord,
  type CheckoutSparkRetiredSettlementSummary,
} from "@conduit/core"

export interface CheckoutSparkPaymentReceipt {
  readonly creditedSats: number
  readonly rows: readonly {
    readonly legId: string
    readonly kind: "merchant" | "supplier" | "organizer" | "conduit"
    readonly allocationSats: number
    readonly payment: null | {
      readonly invoiceAmountSats: number
      readonly feeSats: number
      readonly debitSats: number
      readonly recipientVerified: boolean
      readonly observedAt: number
    }
  }[]
  readonly recordedPaidSats: number
  readonly recordedFeeSats: number
  readonly recordedDebitSats: number
  /** Recorded credit less all recorded debits, never a live wallet balance. */
  readonly recordedUnspentSats: number | null
  readonly allPayoutsRecorded: boolean
}

function safeSats(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Checkout Spark receipt arithmetic is invalid.")
  }
  return Number(value)
}

/** Frozen roles and independent provider records only; no reads or writes. */
export function createCheckoutSparkPaymentReceipt(
  summaryInput: CheckoutSparkRetiredSettlementSummary,
  settlement: CheckoutSparkMerchantSettlementRecord
): CheckoutSparkPaymentReceipt | null {
  try {
    const summary = restoreCheckoutSparkRetiredSettlementSummary(summaryInput)
    const record = validateCheckoutSparkRetiredSettlementRecord(
      summary,
      settlement
    )
    if (!record.credit) return null
    let paid = 0n
    let fees = 0n
    let debits = 0n
    const rows = summary.legs.map((leg) => {
      const observed = record.paidLegs.find((row) => row.legId === leg.legId)
      const payment = observed
        ? {
            invoiceAmountSats: safeSats(
              BigInt(observed.finalDebitSats) - BigInt(observed.finalFeeSats)
            ),
            feeSats: observed.finalFeeSats,
            debitSats: observed.finalDebitSats,
            recipientVerified: observed.recipientVerified === true,
            observedAt: observed.observedAt,
          }
        : null
      if (payment) {
        paid += BigInt(payment.invoiceAmountSats)
        fees += BigInt(payment.feeSats)
        debits += BigInt(payment.debitSats)
      }
      return {
        legId: leg.legId,
        kind: leg.kind,
        allocationSats: leg.allocationSats,
        payment,
      }
    })
    const allPayoutsRecorded = rows.every((row) => row.payment !== null)
    const unspent = BigInt(record.credit.creditedSats) - debits
    if (unspent < 0n) return null
    return {
      creditedSats: record.credit.creditedSats,
      rows,
      recordedPaidSats: safeSats(paid),
      recordedFeeSats: safeSats(fees),
      recordedDebitSats: safeSats(debits),
      recordedUnspentSats: allPayoutsRecorded ? safeSats(unspent) : null,
      allPayoutsRecorded,
    }
  } catch {
    return null
  }
}
