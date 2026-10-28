import { describe, expect, it } from "bun:test"
import type { MerchantCheckoutSparkRecoveryCandidate } from "@conduit/core"
import {
  getMerchantCheckoutSparkCandidateSelectionKey,
  getMerchantCheckoutSparkOrderSelectionKey,
  selectMerchantCheckoutSparkOrderRecovery,
} from "../apps/merchant/src/lib/checkout-spark-order-selection"

const merchant = "a".repeat(64)
const buyerA = "b".repeat(64)
const buyerB = "c".repeat(64)
const selected = {
  merchantPubkey: merchant,
  buyerPubkey: buyerA,
  orderId: "shared-order",
}
const candidate = {
  schemaVersion: 2,
  wrapId: "d".repeat(64),
  checkoutId: "checkout-a",
  orderId: selected.orderId,
  planDigest: "e".repeat(64),
  initialBuyerPubkey: buyerA,
  takeoverAt: 10,
  preparedAt: 1,
} satisfies MerchantCheckoutSparkRecoveryCandidate

describe("participant-qualified Merchant recovery selection", () => {
  it("never attaches a same-ID other-buyer recovery to the selected order", () => {
    const otherOrder = { ...selected, buyerPubkey: buyerB }
    expect(
      selectMerchantCheckoutSparkOrderRecovery(otherOrder, [candidate])
    ).toEqual({ candidate: null, matchingCount: 0 })
    expect(
      getMerchantCheckoutSparkCandidateSelectionKey(otherOrder, candidate)
    ).toBeNull()
    expect(
      selectMerchantCheckoutSparkOrderRecovery(selected, [candidate])
    ).toEqual({ candidate, matchingCount: 1 })
  })

  it("retains exact selection through progressive history and reload without depending on page order", () => {
    const other = {
      ...candidate,
      initialBuyerPubkey: buyerB,
      checkoutId: "checkout-b",
      planDigest: "f".repeat(64),
    }
    const key = getMerchantCheckoutSparkCandidateSelectionKey(
      selected,
      candidate
    )
    for (const page of [
      [other, candidate],
      [candidate, other],
      JSON.parse(JSON.stringify([other, candidate])),
    ]) {
      const resolved = selectMerchantCheckoutSparkOrderRecovery(selected, page)
      expect(resolved.matchingCount).toBe(1)
      expect(
        getMerchantCheckoutSparkCandidateSelectionKey(
          selected,
          resolved.candidate!
        )
      ).toBe(key)
    }
    expect(
      getMerchantCheckoutSparkCandidateSelectionKey(selected, {
        ...candidate,
        wrapId: "1".repeat(64),
        preparedAt: 2,
      })
    ).toBe(key)
    expect(
      getMerchantCheckoutSparkCandidateSelectionKey(selected, {
        ...candidate,
        checkoutId: "replacement",
      })
    ).not.toBe(key)
  })

  it("does not choose conflicting exact checkouts or missing authenticated participant metadata", () => {
    expect(
      selectMerchantCheckoutSparkOrderRecovery(selected, [
        candidate,
        { ...candidate, checkoutId: "other-checkout" },
      ])
    ).toEqual({ candidate: null, matchingCount: 2 })
    expect(
      selectMerchantCheckoutSparkOrderRecovery(selected, [
        { ...candidate, initialBuyerPubkey: undefined },
      ])
    ).toEqual({ candidate: null, matchingCount: 0 })
    expect(selectMerchantCheckoutSparkOrderRecovery(null, [candidate])).toEqual(
      { candidate: null, matchingCount: 0 }
    )
    expect(
      getMerchantCheckoutSparkOrderSelectionKey({ ...selected, orderId: "" })
    ).toBeNull()
    expect(
      getMerchantCheckoutSparkOrderSelectionKey({
        ...selected,
        buyerPubkey: "invalid",
      })
    ).toBeNull()
    expect(
      getMerchantCheckoutSparkOrderSelectionKey({
        ...selected,
        buyerPubkey: buyerB,
      })
    ).not.toBe(getMerchantCheckoutSparkOrderSelectionKey(selected))
    expect(
      getMerchantCheckoutSparkOrderSelectionKey({
        ...selected,
        merchantPubkey: buyerB,
      })
    ).not.toBe(getMerchantCheckoutSparkOrderSelectionKey(selected))
  })
})
