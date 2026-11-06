import { beforeEach, describe, expect, it } from "bun:test"

import {
  __resetCommerceGmvEstimateSessionForTests,
  getCommerceGmvEstimateFromOrder,
  reportCommerceGmvEstimate,
} from "../packages/core/src/commerce-gmv"

const ORDER_ID = "018f4a00-1111-4abc-8def-0123456789ab"
const ESTIMATE = {
  orderId: ORDER_ID,
  orderCreatedAt: Date.parse("2026-09-17T18:24:31.000Z"),
  invoicedAmountSats: 42,
}

describe("commerce GMV estimate client", () => {
  beforeEach(() => {
    __resetCommerceGmvEstimateSessionForTests()
  })

  it("admits only the exact sats order snapshot for a conversation", () => {
    const order = {
      id: ORDER_ID,
      buyerPubkey: "buyer",
      merchantPubkey: "merchant",
      createdAt: ESTIMATE.orderCreatedAt,
      subtotal: 42,
      currency: "SATS",
    }
    expect(
      getCommerceGmvEstimateFromOrder({
        orderId: ORDER_ID,
        buyerPubkey: "buyer",
        merchantPubkey: "merchant",
        order,
      })
    ).toEqual(ESTIMATE)

    for (const invalid of [
      { ...order, id: "018f4a00-2222-4abc-8def-0123456789ab" },
      { ...order, buyerPubkey: "other-buyer" },
      { ...order, merchantPubkey: "other-merchant" },
      { ...order, currency: "USD" },
      { ...order, subtotal: 0 },
      { ...order, subtotal: 1.5 },
    ]) {
      expect(
        getCommerceGmvEstimateFromOrder({
          orderId: ORDER_ID,
          buyerPubkey: "buyer",
          merchantPubkey: "merchant",
          order: invalid,
        })
      ).toBeNull()
    }
  })

  it.each(["shop.conduit.market", "sell.conduit.market", "preview.example"])(
    "does not report or retain pending requests on %s",
    async (hostname) => {
      let requests = 0
      const fetchImpl = async () => {
        requests += 1
        throw new Error("must never reach a provider")
      }
      await expect(
        Promise.all([
          reportCommerceGmvEstimate(ESTIMATE, { hostname, fetchImpl }),
          reportCommerceGmvEstimate(ESTIMATE, { hostname, fetchImpl }),
        ])
      ).resolves.toEqual([false, false])
      expect(requests).toBe(0)
    }
  )
})
