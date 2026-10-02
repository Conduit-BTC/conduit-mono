import { describe, expect, it } from "bun:test"
import type {
  CheckoutSparkMerchantSettlementRecord,
  CheckoutSparkRetiredSettlementSummary,
} from "@conduit/core"
import { createCheckoutSparkPaymentReceipt } from "../apps/market/src/lib/checkout-spark-payment-receipt"

function fixture() {
  const kinds = ["merchant", "supplier", "organizer", "conduit"] as const
  const allocations = [700, 200, 100, 113]
  const amounts = [690, 190, 95, 107]
  const fees = [3, 0, 1, 2]
  const summary: CheckoutSparkRetiredSettlementSummary = {
    schemaVersion: 1,
    checkoutId: "receipt-checkout",
    planDigest: "a".repeat(64),
    orderId: "receipt-order",
    merchantPubkey: "b".repeat(64),
    walletId: "receipt-wallet",
    commerceTotalSats: 1_000,
    credit: { transferId: "receipt-credit", creditedSats: 1_113 },
    legs: kinds.map((kind, index) => ({
      kind,
      legId: String(index + 1).repeat(64),
      transferId: `receipt-transfer-${index}`,
      allocationSats: allocations[index]!,
    })),
  }
  const record: CheckoutSparkMerchantSettlementRecord = {
    schemaVersion: 1,
    checkoutId: summary.checkoutId,
    planDigest: summary.planDigest,
    orderId: summary.orderId,
    merchantPubkey: summary.merchantPubkey,
    merchantLegId: summary.legs[0]!.legId,
    requiredCommerceLegIds: summary.legs.slice(0, 3).map((leg) => leg.legId),
    feeLegId: summary.legs[3]!.legId,
    credit: { ...summary.credit!, observedAt: 100 },
    paidLegs: summary.legs.map((leg, index) => ({
      legId: leg.legId,
      transferId: leg.transferId,
      allocationSats: leg.allocationSats,
      finalDebitSats: amounts[index]! + fees[index]!,
      finalFeeSats: fees[index]!,
      observedAt: 101 + index,
      recipientVerified: true,
    })),
  }
  return { summary, record }
}

describe("recorded checkout payment receipt", () => {
  it("uses actual below-budget debits and zero fees for every frozen recipient role", () => {
    const { summary, record } = fixture()
    expect(createCheckoutSparkPaymentReceipt(summary, record)).toEqual({
      creditedSats: 1_113,
      rows: summary.legs.map((leg, index) => ({
        legId: leg.legId,
        kind: leg.kind,
        allocationSats: leg.allocationSats,
        payment: {
          invoiceAmountSats: [690, 190, 95, 107][index],
          feeSats: [3, 0, 1, 2][index],
          debitSats: [693, 190, 96, 109][index],
          recipientVerified: true,
          observedAt: 101 + index,
        },
      })),
      recordedPaidSats: 1_082,
      recordedFeeSats: 6,
      recordedDebitSats: 1_088,
      recordedUnspentSats: 25,
      allPayoutsRecorded: true,
    })
  })

  it("keeps a missing Conduit observation distinct from zero paid and unknown unspent", () => {
    const { summary, record } = fixture()
    const receipt = createCheckoutSparkPaymentReceipt(summary, {
      ...record,
      paidLegs: record.paidLegs.slice(0, 3),
    })
    expect(receipt).toMatchObject({
      recordedPaidSats: 975,
      recordedFeeSats: 4,
      recordedDebitSats: 979,
      recordedUnspentSats: null,
      allPayoutsRecorded: false,
    })
    expect(receipt?.rows[3]?.payment).toBeNull()
  })

  it("reports provider debit without upgrading missing recipient attribution", () => {
    const { summary, record } = fixture()
    const receipt = createCheckoutSparkPaymentReceipt(summary, {
      ...record,
      paidLegs: record.paidLegs.map((leg) => {
        const observed = { ...leg }
        delete observed.recipientVerified
        return observed
      }),
    })
    expect(receipt).toMatchObject({
      allPayoutsRecorded: true,
      recordedUnspentSats: 25,
    })
    expect(
      receipt?.rows.every((row) => row.payment?.recipientVerified === false)
    ).toBe(true)
  })

  it("never invents funding or payment facts from allocations alone", () => {
    const { summary, record } = fixture()
    expect(
      createCheckoutSparkPaymentReceipt(summary, { ...record, credit: null })
    ).toBeNull()
    const receipt = createCheckoutSparkPaymentReceipt(summary, {
      ...record,
      paidLegs: [],
    })
    expect(receipt).toMatchObject({
      creditedSats: 1_113,
      recordedPaidSats: 0,
      recordedFeeSats: 0,
      recordedDebitSats: 0,
      recordedUnspentSats: null,
      allPayoutsRecorded: false,
    })
    expect(receipt?.rows.every((row) => row.payment === null)).toBe(true)
  })

  for (const mismatch of [
    "checkout",
    "credit",
    "transfer",
    "allocation",
    "role",
    "duplicate",
    "unsafe_debit",
    "unsafe_fee",
    "negative_fee",
  ] as const) {
    it(`rejects ${mismatch} evidence rather than fabricating a receipt`, () => {
      const { summary, record } = fixture()
      const first = record.paidLegs[0]!
      const changed: CheckoutSparkMerchantSettlementRecord = {
        ...record,
        ...(mismatch === "checkout"
          ? { checkoutId: "different-checkout" }
          : {}),
        ...(mismatch === "credit"
          ? { credit: { ...record.credit!, creditedSats: 1_114 } }
          : {}),
        ...(mismatch === "role"
          ? { merchantLegId: record.feeLegId, feeLegId: record.merchantLegId }
          : {}),
        paidLegs:
          mismatch === "duplicate"
            ? [first, first]
            : [
                {
                  ...first,
                  ...(mismatch === "transfer"
                    ? { transferId: "different-transfer" }
                    : {}),
                  ...(mismatch === "allocation"
                    ? { allocationSats: first.allocationSats + 1 }
                    : {}),
                  ...(mismatch === "unsafe_debit"
                    ? { finalDebitSats: Number.MAX_SAFE_INTEGER + 1 }
                    : {}),
                  ...(mismatch === "unsafe_fee"
                    ? { finalFeeSats: Number.NaN }
                    : {}),
                  ...(mismatch === "negative_fee" ? { finalFeeSats: -1 } : {}),
                },
                ...record.paidLegs.slice(1),
              ],
      }
      expect(createCheckoutSparkPaymentReceipt(summary, changed)).toBeNull()
    })
  }

  it("rejects allocation totals beyond the exact safe credited amount", () => {
    const { summary, record } = fixture()
    const maximum = Number.MAX_SAFE_INTEGER
    expect(
      createCheckoutSparkPaymentReceipt(
        {
          ...summary,
          credit: { ...summary.credit!, creditedSats: maximum },
          legs: summary.legs.map((leg, index) => ({
            ...leg,
            allocationSats: index === 0 ? maximum : 1,
          })),
        },
        {
          ...record,
          credit: { ...record.credit!, creditedSats: maximum },
          paidLegs: [],
        }
      )
    ).toBeNull()
  })

  it("preserves exact safe-integer arithmetic at the upper bound", () => {
    const { summary, record } = fixture()
    const maximum = Number.MAX_SAFE_INTEGER
    const legs = summary.legs.map((leg, index) => ({
      ...leg,
      allocationSats: index === 0 ? maximum - 3 : 1,
    }))
    const receipt = createCheckoutSparkPaymentReceipt(
      {
        ...summary,
        credit: { ...summary.credit!, creditedSats: maximum },
        legs,
      },
      {
        ...record,
        credit: { ...record.credit!, creditedSats: maximum },
        paidLegs: record.paidLegs.map((leg, index) => ({
          ...leg,
          allocationSats: legs[index]!.allocationSats,
          finalDebitSats: legs[index]!.allocationSats,
          finalFeeSats: 0,
        })),
      }
    )
    expect(receipt).toMatchObject({
      recordedPaidSats: maximum,
      recordedFeeSats: 0,
      recordedDebitSats: maximum,
      recordedUnspentSats: 0,
    })
  })

  it("returns detached public receipt fields without destinations, invoices, or transfer IDs", () => {
    const { summary, record } = fixture()
    const receipt = createCheckoutSparkPaymentReceipt(summary, record)!
    const before = structuredClone(receipt)
    Object.assign(summary.legs[0]!, { allocationSats: 1 })
    Object.assign(record.paidLegs[0]!, { finalFeeSats: 99 })
    expect(receipt).toEqual(before)
    expect(Object.keys(receipt.rows[0]!).sort()).toEqual([
      "allocationSats",
      "kind",
      "legId",
      "payment",
    ])
    expect(Object.keys(receipt.rows[0]!.payment!).sort()).toEqual([
      "debitSats",
      "feeSats",
      "invoiceAmountSats",
      "observedAt",
      "recipientVerified",
    ])
  })
})
