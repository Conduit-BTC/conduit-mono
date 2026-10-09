import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { CheckoutSparkPaymentReceipt } from "../apps/market/src/components/CheckoutSparkPaymentReceipt"
import type { CheckoutSparkPaymentReceipt as PaymentReceipt } from "../apps/market/src/lib/checkout-spark-buyer-settlement"

function receipt(): PaymentReceipt {
  return {
    creditedSats: 1_113,
    rows: [
      {
        legId: "receipt-merchant",
        kind: "merchant",
        allocationSats: 1_002,
        payment: {
          invoiceAmountSats: 995,
          feeSats: 2,
          debitSats: 997,
          recipientVerified: true,
          observedAt: 1_000,
        },
      },
      {
        legId: "receipt-conduit",
        kind: "conduit",
        allocationSats: 111,
        payment: {
          invoiceAmountSats: 107,
          feeSats: 1,
          debitSats: 108,
          recipientVerified: true,
          observedAt: 2_000,
        },
      },
    ],
    recordedPaidSats: 1_102,
    recordedFeeSats: 3,
    recordedDebitSats: 1_105,
    recordedUnspentSats: 8,
    allPayoutsRecorded: true,
  }
}

describe("private checkout payment receipt", () => {
  it("keeps recorded accounting without a completed-native detail panel", () => {
    const html = renderToStaticMarkup(
      <CheckoutSparkPaymentReceipt
        receipt={{
          ...receipt(),
          recordedPaidSats: 1_108,
          recordedFeeSats: 2,
          recordedDebitSats: 1_110,
          recordedUnspentSats: 3,
          nativeTreasury: {
            baseConduitAllocationSats: 111,
            unusedCommerceReserveSats: 2,
            principalSats: 113,
            feeSats: 0,
            debitSats: 113,
            observedAt: 3_000,
          },
        }}
      />
    )

    expect(html).not.toContain("Completed native Spark payment")
    expect(html).not.toContain("exact completed transfer")
    expect(html).not.toContain("Base Conduit allocation")
    expect(html).not.toContain("Unused recipient fee reserves included")
    expect(html).not.toContain("Final Conduit payment")
    expect(html).not.toContain("Actual native Spark fee")
    expect(html).toContain("All checkout payments verified.")
    expect(html).toContain("Recorded payouts")
    expect(html).toContain("1,108 sats")
    expect(html).toContain("Recorded outgoing fees")
    expect(html).toContain("2 sats")
    expect(html).toContain("Recorded total debited")
    expect(html).toContain("1,110 sats")
    expect(html).toContain("Unspent from recorded checkout credit")
    expect(html).toContain("3 sats")
    expect(html).not.toContain("native-transfer")
    expect(html).not.toContain("11111111-1111-5111")
    expect(html).not.toContain("<button")
  })

  it("keeps routing accounting behind a collapsed payment-details disclosure", () => {
    const html = renderToStaticMarkup(
      <CheckoutSparkPaymentReceipt receipt={receipt()} />
    )
    expect(html).toContain("<summary")
    expect(html).toContain(">Payment details</summary>")
    expect(html).toContain("<details")
    expect(html).not.toContain("<details open")
    expect(html).toContain("All checkout payments verified.")
  })

  it("shows actual paid amounts and distinguishes recorded remainder from live funds", () => {
    const html = renderToStaticMarkup(
      <CheckoutSparkPaymentReceipt receipt={receipt()} />
    )
    expect(html).toContain("Payment history")
    expect(html).not.toContain("995 sats")
    expect(html).not.toContain("107 sats")
    expect(html).toContain("All checkout payments verified.")
    expect(html).toContain("Recorded outgoing fees")
    expect(html).toContain("1,105 sats")
    expect(html).toContain("8 sats")
    expect(html).toContain("not a live wallet balance")
    expect(html).toContain("Source-wallet fees")
    expect(html).not.toContain("receipt-merchant")
    expect(html).not.toContain("receipt-conduit")
    expect(html).not.toContain("<button")
    expect(html).not.toContain("Maximum outgoing fee")
    for (const role of [
      "Merchant",
      "Supplier",
      "Organizer",
      "Conduit payout",
      "Allocation",
    ])
      expect(html).not.toContain(role)
  })

  it("keeps unobserved payouts and their remainder unknown", () => {
    const full = receipt()
    const html = renderToStaticMarkup(
      <CheckoutSparkPaymentReceipt
        receipt={{
          ...full,
          rows: [full.rows[0]!, { ...full.rows[1]!, payment: null }],
          recordedPaidSats: 995,
          recordedFeeSats: 2,
          recordedDebitSats: 997,
          recordedUnspentSats: null,
          allPayoutsRecorded: false,
        }}
      />
    )
    expect(html).toContain("Payments are still being completed.")
    expect(html).toContain("Totals above include recorded payouts only.")
    expect(html).not.toContain("Unspent from recorded checkout credit")
    expect(html).not.toContain("107 sats")
  })

  it("distinguishes invoice payment from recipient verification and preserves zero fees", () => {
    const full = receipt()
    const merchant = full.rows[0]!
    const html = renderToStaticMarkup(
      <CheckoutSparkPaymentReceipt
        receipt={{
          ...full,
          rows: [
            {
              ...merchant,
              payment: {
                ...merchant.payment!,
                recipientVerified: false,
                feeSats: 0,
                debitSats: 995,
              },
            },
            {
              ...full.rows[1]!,
              payment: {
                ...full.rows[1]!.payment!,
                feeSats: 0,
                debitSats: 107,
              },
            },
          ],
          recordedFeeSats: 0,
          recordedDebitSats: 1_102,
          recordedUnspentSats: 11,
        }}
      />
    )
    expect(html).toContain(
      "Payments recorded; final verification is still pending."
    )
    expect(html).toContain("0 sats")
    expect(html).toContain("11 sats")
    expect(html).toContain("do not prove the wallet is empty or safe to remove")
  })
})
