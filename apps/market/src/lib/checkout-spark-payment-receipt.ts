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
  /** Present only for the native-treasury plan generation; never includes provider IDs. */
  readonly nativeTreasury?: null | {
    readonly baseConduitAllocationSats: number
    readonly unusedCommerceReserveSats: number
    readonly principalSats: number
    readonly feeSats: 0
    readonly debitSats: number
    readonly observedAt: number
  }
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
    const nativeTreasury =
      summary.schemaVersion === 3 &&
      record.schemaVersion === 2 &&
      record.nativeTreasury
        ? {
            baseConduitAllocationSats:
              record.nativeTreasury.baseConduitAllocationSats,
            unusedCommerceReserveSats:
              record.nativeTreasury.unusedCommerceReserveSats,
            principalSats: record.nativeTreasury.principalSats,
            feeSats: record.nativeTreasury.finalFeeSats,
            debitSats: record.nativeTreasury.finalDebitSats,
            observedAt: record.nativeTreasury.observedAt,
          }
        : null
    let paid = 0n
    let fees = 0n
    let debits = 0n
    const rows = summary.legs.map((leg) => {
      const observed = record.paidLegs.find((row) => row.legId === leg.legId)
      const payment =
        summary.schemaVersion === 3 && leg.kind === "conduit" && nativeTreasury
          ? {
              invoiceAmountSats: nativeTreasury.principalSats,
              feeSats: nativeTreasury.feeSats,
              debitSats: nativeTreasury.debitSats,
              recipientVerified: true,
              observedAt: nativeTreasury.observedAt,
            }
          : observed
            ? {
                invoiceAmountSats: safeSats(
                  BigInt(observed.finalDebitSats) -
                    BigInt(observed.finalFeeSats)
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
      ...(summary.schemaVersion === 3 ? { nativeTreasury } : {}),
    }
  } catch {
    return null
  }
}
