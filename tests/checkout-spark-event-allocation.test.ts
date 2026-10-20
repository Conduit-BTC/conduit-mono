import { describe, expect, it } from "bun:test"
import {
  allocateCheckoutSparkEventSettledSats,
  calculateCheckoutSparkEventAllocationWeights,
  calculateCheckoutSparkEventBuyerPrice,
  calculateCheckoutSparkEventSettledGrossFundingSats,
  calculateCheckoutSparkBuyerPrice,
} from "@conduit/core/protocol/checkout-spark-settled-allocation"

describe("additive event allocation arithmetic", () => {
  it("conserves every attributed sat without charging Conduit's percentage on the organizer", () => {
    for (const commerce of [
      0, 1, 100, 1_000, 5_285, 5_286, 100_000, 1_000_001,
    ]) {
      for (const organizer of [0, 1, 5, 137, 100_000]) {
        if (commerce === 0 && organizer === 0) continue
        const weights = calculateCheckoutSparkEventAllocationWeights(
          commerce,
          organizer
        )
        const conduit = Math.max(
          111,
          Number((BigInt(commerce) * 21n + 999n) / 1_000n)
        )
        const allowance = Number(
          (BigInt(commerce + organizer) * 15n + 9_999n) / 10_000n
        )
        const gross = calculateCheckoutSparkEventSettledGrossFundingSats(
          commerce,
          organizer
        )
        expect(weights.conduitWeightSats).toBe(conduit)
        expect(gross).toBe(commerce + organizer + conduit + allowance)
        for (const credited of [commerce + organizer + conduit, gross]) {
          const divided = allocateCheckoutSparkEventSettledSats({
            settledSats: credited,
            fundingInvoiceGrossSats: gross,
            weights,
          })
          expect(divided.organizerAllocationSats).toBe(organizer)
          expect(
            divided.commerceAllocationSats +
              divided.conduitAllocationSats +
              divided.organizerAllocationSats
          ).toBe(credited)
          expect(divided.commerceAllocationSats).toBeGreaterThanOrEqual(
            commerce
          )
          expect(divided.conduitAllocationSats).toBeGreaterThanOrEqual(conduit)
        }
        expect(() =>
          allocateCheckoutSparkEventSettledSats({
            settledSats: commerce + organizer + conduit - 1,
            fundingInvoiceGrossSats: gross,
            weights,
          })
        ).toThrow()
      }
    }
  })

  it("keeps ordinary buyer prices identical when no event fee applies", () => {
    for (const itemSubtotalSats of [0, 1, 1_000, 100_000]) {
      const input = { itemSubtotalSats, shippingSubtotalSats: 0 }
      const event = calculateCheckoutSparkEventBuyerPrice({
        ...input,
        organizerFeeSats: 0,
      })
      const { organizerFeeSats, ...ordinary } = event
      expect(organizerFeeSats).toBe(0)
      expect(ordinary).toEqual(calculateCheckoutSparkBuyerPrice(input))
    }
    expect(
      calculateCheckoutSparkEventBuyerPrice({
        itemSubtotalSats: 0,
        shippingSubtotalSats: 0,
        organizerFeeSats: 5,
      })
    ).toMatchObject({
      commerceTotalSats: 0,
      organizerFeeSats: 5,
      conduitFeeSats: 111,
      networkAllowanceSats: 1,
      totalSats: 117,
    })
  })

  it("rejects invalid integers, millisatoshi overflow and changed frozen weights", () => {
    for (const invalid of [
      -1,
      0.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() =>
        calculateCheckoutSparkEventAllocationWeights(invalid, 5)
      ).toThrow()
      expect(() =>
        calculateCheckoutSparkEventAllocationWeights(100, invalid)
      ).toThrow()
    }
    expect(() =>
      calculateCheckoutSparkEventSettledGrossFundingSats(
        Number.MAX_SAFE_INTEGER,
        5
      )
    ).toThrow()
    expect(() =>
      calculateCheckoutSparkEventSettledGrossFundingSats(
        0,
        Number.MAX_SAFE_INTEGER
      )
    ).toThrow()
    expect(() => calculateCheckoutSparkEventAllocationWeights(0, 0)).toThrow()
    const weights = calculateCheckoutSparkEventAllocationWeights(100, 5)
    expect(() =>
      allocateCheckoutSparkEventSettledSats({
        settledSats: 216,
        fundingInvoiceGrossSats: 217,
        weights: { ...weights, conduitWeightSats: 112 },
      })
    ).toThrow()
  })
})
